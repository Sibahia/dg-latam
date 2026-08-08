import { Client } from '../core/Client';
import { BitReader } from '../network/protocol/bitReader';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { Config } from '../core/config';
import * as crypto from 'crypto';
import { JsonAdapter } from '../database/JsonAdapter';
import { UserAccount } from '../database/Database';
import { GlobalState, PendingTransfer } from '../core/GlobalState';
import {
    hasValidDiscordSync,
    isClientPasswordDigest,
    isValidPasswordInput,
    normalizeAccountIdentifier,
    unmaskChallengeXorClientPassword,
    verifyClientPasswordInput
} from '../auth/PasswordAuth';

const INVALID_CREDENTIALS_MESSAGE = "Invalid email or password";
const DISCORD_ACCOUNT_CREATE_MESSAGE = "Create your account in Discord with /create-account.";
const PASSWORD_NOT_SET_MESSAGE = "Set a password before using password login.";
export const CONCURRENT_ACCOUNT_EMAIL_MESSAGE = "You already have an account open with this email address.";

interface LoginPayload {
    email: string;
    password: string;
}

interface AccountIdentityConflictSet {
    sessions: Client[];
    pendingWorldLocks: Array<[number, PendingTransfer]>;
}

export class LoginHandler {
    public static db: JsonAdapter = new JsonAdapter();
    private static readonly PENDING_WORLD_LOGIN_LOCK_TTL_MS = 60 * 1000;
    private static readonly MAX_FAILED_PASSWORD_ATTEMPTS = 8;
    private static readonly FAILED_PASSWORD_ATTEMPT_WINDOW_MS = 5 * 60 * 1000;
    private static readonly failedPasswordAttempts = new Map<string, number[]>();

    private static issueChallenge(client: Client): string {
        const sid = crypto.randomInt(0, 65536);
        const secret = Buffer.from(Config.SECRET, 'hex');
        const sidBytes = Buffer.alloc(2);
        sidBytes.writeUInt16BE(sid);

        const digest = crypto.createHmac('sha256', secret).update(sidBytes).digest('hex').substring(0, 12);
        const challenge = `${sid.toString(16).padStart(4, '0')}${digest}`;
        client.challengeStr = challenge;

        const challengeBuf = Buffer.from(challenge, 'utf-8');
        const payload = Buffer.alloc(2 + challengeBuf.length);
        payload.writeUInt16BE(challengeBuf.length, 0);
        challengeBuf.copy(payload, 2);

        const send = (client as Client & { send?: (id: number, payload: Buffer) => void }).send;
        if (typeof send === 'function') {
            send.call(client, 0x12, payload);
        }

        return challenge;
    }

    private static parseLoginPayload(data: Buffer): LoginPayload | null {
        try {
            const br = new BitReader(data);
            br.readMethod26(); // fbId
            br.readMethod26(); // kongId
            const email = normalizeAccountIdentifier(br.readMethod26());
            const password = br.readMethod26();
            br.readMethod26(); // legacyKey

            if (
                !email ||
                email.length > 254 ||
                !/^[^\s@]+@[^\s@]+$/.test(email) ||
                password.length > 256
            ) {
                return null;
            }

            return { email, password };
        } catch (err) {
            console.warn(`[Login] Rejected malformed login payload: ${(err as Error).message}`);
            return null;
        }
    }

    private static getPasswordAttemptKey(client: Client, email: string): string {
        const remoteAddress = GlobalState.normalizeRemoteAddress(client.socket.remoteAddress) || 'unknown';
        return `${remoteAddress}:${email}`;
    }

    private static getRecentFailedPasswordAttempts(key: string, now: number = Date.now()): number[] {
        const cutoff = now - LoginHandler.FAILED_PASSWORD_ATTEMPT_WINDOW_MS;
        const recent = (LoginHandler.failedPasswordAttempts.get(key) ?? []).filter((attemptedAt) => attemptedAt > cutoff);
        if (recent.length > 0) {
            LoginHandler.failedPasswordAttempts.set(key, recent);
        } else {
            LoginHandler.failedPasswordAttempts.delete(key);
        }
        return recent;
    }

    private static isPasswordAttemptRateLimited(key: string): boolean {
        return LoginHandler.getRecentFailedPasswordAttempts(key).length >= LoginHandler.MAX_FAILED_PASSWORD_ATTEMPTS;
    }

    private static recordFailedPasswordAttempt(key: string): void {
        const recent = LoginHandler.getRecentFailedPasswordAttempts(key);
        recent.push(Date.now());
        LoginHandler.failedPasswordAttempts.set(key, recent);
    }

    private static clearFailedAuthState(client: Client): void {
        client.userId = null;
        client.account = null;
        client.authenticated = false;
        client.characters = [];
        client.character = null;
    }

    private static isFreshPendingWorldLoginLock(entry: PendingTransfer, now: number = Date.now()): boolean {
        const pendingSince = Number(entry.pendingSince ?? entry.playSessionStartedAt ?? 0);
        if (!Number.isFinite(pendingSince) || pendingSince <= 0) {
            return true;
        }

        return now - Math.round(pendingSince) <= LoginHandler.PENDING_WORLD_LOGIN_LOCK_TTL_MS;
    }

    private static clearStalePendingWorldLoginLock(
        token: number,
        entry: PendingTransfer,
        accountEmail: string,
        reason: 'stale' | 'replaced' = 'stale'
    ): void {
        GlobalState.pendingWorld.delete(token);
        GlobalState.pendingExtended.delete(token);
        GlobalState.pendingTeleports.delete(token);
        GlobalState.tokenChar.delete(token);
        GlobalState.usedTransferTokens.delete(token);
        GlobalState.houseVisits.delete(token);
        GlobalState.transferTokenAliases.delete(token);
        for (const [aliasToken, targetToken] of Array.from(GlobalState.transferTokenAliases.entries())) {
            if (targetToken === token) {
                GlobalState.transferTokenAliases.delete(aliasToken);
            }
        }

        const characterName = String(entry.character?.name ?? '').trim() || '(unknown)';
        console.warn(
            `[Login] Cleared ${reason} pending world login lock for ${accountEmail} token=${token} character=${characterName}`
        );
    }

    private static async collectActiveAccountIdentityConflicts(
        account: UserAccount,
        excludedClient?: Client | null,
        selectedCharacterName?: string | null
    ): Promise<AccountIdentityConflictSet> {
        const sessions: Client[] = [];
        const candidates = new Set<Client>();
        const pendingWorldLocks: Array<[number, PendingTransfer]> = [];
        const accountUserId = Math.max(0, Math.round(Number(account.user_id ?? 0)));
        const selectedCharacterKey = String(selectedCharacterName ?? '').trim().toLowerCase();

        const addCandidate = (session: Client | null | undefined): void => {
            if (!session || session === excludedClient) {
                return;
            }

            const socket = (session as unknown as { socket?: { destroyed?: boolean } }).socket;
            if (socket?.destroyed) {
                return;
            }

            candidates.add(session);
        };

        for (const client of GlobalState.clients) {
            addCandidate(client);
        }
        for (const session of GlobalState.sessionsByToken.values()) {
            addCandidate(session);
        }
        for (const session of GlobalState.sessionsByUserId.values()) {
            addCandidate(session);
        }
        for (const session of GlobalState.sessionsByCharacterName.values()) {
            addCandidate(session);
        }
        if (accountUserId > 0) {
            addCandidate(GlobalState.sessionsByUserId.get(accountUserId));
        }
        if (selectedCharacterKey) {
            addCandidate(GlobalState.sessionsByCharacterName.get(selectedCharacterKey));
        }

        for (const session of candidates) {
            if (session === excludedClient) {
                continue;
            }

            const sessionUserId = Math.max(0, Math.round(Number(session.userId ?? 0)));
            const sessionCharacterKey = String(session.character?.name ?? '').trim().toLowerCase();
            if (selectedCharacterKey && sessionCharacterKey === selectedCharacterKey) {
                sessions.push(session);
                continue;
            }

            if (accountUserId > 0 && sessionUserId === accountUserId) {
                sessions.push(session);
                continue;
            }

            if (GlobalState.accountsShareIdentity(session.account, account)) {
                sessions.push(session);
                continue;
            }

            if (sessionUserId > 0) {
                const sessionAccount = await LoginHandler.db.getAccountById(sessionUserId);
                if (GlobalState.accountsShareIdentity(sessionAccount, account)) {
                    sessions.push(session);
                }
            }
        }

        const now = Date.now();
        for (const [token, entry] of Array.from(GlobalState.pendingWorld.entries())) {
            let matchesAccountIdentity = false;
            if (accountUserId > 0 && entry.userId === accountUserId) {
                matchesAccountIdentity = true;
            } else if (GlobalState.accountsShareIdentity(entry.account, account)) {
                matchesAccountIdentity = true;
            } else if (entry.accountEmail && GlobalState.accountsShareIdentity({ email: entry.accountEmail }, account)) {
                matchesAccountIdentity = true;
            } else if (entry.userId > 0) {
                const pendingAccount = await LoginHandler.db.getAccountById(entry.userId);
                matchesAccountIdentity = GlobalState.accountsShareIdentity(pendingAccount, account);
            }

            if (!matchesAccountIdentity) {
                continue;
            }

            if (LoginHandler.isFreshPendingWorldLoginLock(entry, now)) {
                pendingWorldLocks.push([token, entry]);
                continue;
            }

            LoginHandler.clearStalePendingWorldLoginLock(token, entry, account.email);
        }

        return { sessions, pendingWorldLocks };
    }

    private static async disconnectReplacedSession(session: Client, replacementEmail: string): Promise<void> {
        const sessionUserId = Number(session.userId ?? 0);
        const characterName = String(session.character?.name ?? '').trim() || '(none)';
        const socket = session.socket as Client['socket'] & {
            destroy?: () => void;
            end?: () => void;
            unref?: () => void;
        };
        if (socket && !socket.destroyed) {
            try {
                socket.end?.();
            } catch {
                // Ignore close races; the follow-up destroy forces the disconnect.
            }

            if (!socket.destroyed && typeof socket.destroy === 'function') {
                socket.destroy();
            }
        }

        try {
            await session.resetForLoginCycle(`replacement login for ${replacementEmail}`);
        } catch (err) {
            console.error(
                `[Login] Failed to persist replaced session after disconnect: ` +
                `replacement=${replacementEmail} userId=${sessionUserId} char=${characterName}`,
                err
            );
        }

        console.warn(
            `[Login] Replaced active session for ${replacementEmail}: ` +
            `oldUserId=${sessionUserId || 0} oldChar=${characterName}`
        );
    }

    private static hasAccountIdentityConflicts(conflicts: AccountIdentityConflictSet): boolean {
        return conflicts.sessions.length > 0 || conflicts.pendingWorldLocks.length > 0;
    }

    private static async replaceCollectedAccountIdentityConflicts(
        account: UserAccount,
        conflicts: AccountIdentityConflictSet
    ): Promise<boolean> {
        const hadConflicts = LoginHandler.hasAccountIdentityConflicts(conflicts);
        for (const [token, entry] of conflicts.pendingWorldLocks) {
            LoginHandler.clearStalePendingWorldLoginLock(token, entry, account.email, 'replaced');
        }

        for (const session of conflicts.sessions) {
            await LoginHandler.disconnectReplacedSession(session, account.email);
        }

        return hadConflicts;
    }

    public static async replaceActiveAccountIdentityConflicts(
        account: UserAccount,
        excludedClient?: Client | null,
        selectedCharacterName?: string | null
    ): Promise<boolean> {
        const conflicts = await LoginHandler.collectActiveAccountIdentityConflicts(account, excludedClient, selectedCharacterName);
        return LoginHandler.replaceCollectedAccountIdentityConflicts(account, conflicts);
    }

    public static async replaceAndWarnActiveAccountIdentityConflicts(
        client: Client,
        account: UserAccount,
        selectedCharacterName?: string | null
    ): Promise<boolean> {
        const conflicts = await LoginHandler.collectActiveAccountIdentityConflicts(account, client, selectedCharacterName);
        if (!LoginHandler.hasAccountIdentityConflicts(conflicts)) {
            console.warn(
                `[Login] No active account identity conflict found for ${account.email} ` +
                `character=${String(selectedCharacterName ?? '').trim() || '(none)'} at enter-game replacement check`
            );
            return false;
        }

        console.warn(
            `[Login] Replacing account identity conflicts for ${account.email}: ` +
            `character=${String(selectedCharacterName ?? '').trim() || '(none)'} ` +
            `sessions=${conflicts.sessions.length} pendingWorld=${conflicts.pendingWorldLocks.length}`
        );
        await LoginHandler.replaceCollectedAccountIdentityConflicts(account, conflicts);
        LoginHandler.sendPopup(client, CONCURRENT_ACCOUNT_EMAIL_MESSAGE, false);
        return true;
    }

    private static async completeAuthentication(
        client: Client,
        account: UserAccount,
        reason: string,
        resetForLoginCycle: boolean = false,
        sendCharacters: boolean = true
    ): Promise<void> {
        if (resetForLoginCycle) {
            await client.resetForLoginCycle(reason);
        }

        client.userId = account.user_id;
        client.account = account;
        client.authenticated = true;
        client.characters = await LoginHandler.db.loadCharacters(account.user_id);

        console.log(`[Login] Authenticated ${account.email}: ${reason}`);
        if (sendCharacters) {
            LoginHandler.sendCharacterList(client);
        }
    }

    private static rejectLogin(
        client: Client,
        email: string,
        reason: string,
        publicMessage: string = INVALID_CREDENTIALS_MESSAGE
    ): void {
        LoginHandler.clearFailedAuthState(client);
        console.warn(`[Login] Authentication failed for ${email || '(missing account id)'}: ${reason}`);
        LoginHandler.sendPopup(client, publicMessage, false);
        LoginHandler.issueChallenge(client);
    }

    static async handleLoginVersion(client: Client, data: Buffer): Promise<void> {
        // 0x11
        await client.resetForLoginCycle('login version');

        const br = new BitReader(data);
        const version = br.readMethod9();

        const challenge = LoginHandler.issueChallenge(client);

        console.log(`[Login] Version: ${version}, Challenge: ${challenge}`);

    }

    static async handleLoginCreate(client: Client, data: Buffer): Promise<void> {
        // 0x13
        await client.resetForLoginCycle('login create');

        const payload = LoginHandler.parseLoginPayload(data);
        if (!payload) {
            LoginHandler.rejectLogin(client, '', 'invalid login payload');
            return;
        }

        LoginHandler.rejectLogin(
            client,
            payload.email,
            'direct game account creation is disabled',
            DISCORD_ACCOUNT_CREATE_MESSAGE
        );
    }
    static async handleLoginAuthenticate(client: Client, data: Buffer): Promise<void> {
        // 0x14
        const payload = LoginHandler.parseLoginPayload(data);
        if (!payload) {
            LoginHandler.rejectLogin(client, '', 'invalid login payload');
            return;
        }

        const { email, password } = payload;
        const attemptKey = LoginHandler.getPasswordAttemptKey(client, email);
        const challenge = String(client.challengeStr ?? '');
        client.challengeStr = '';

        if (LoginHandler.isPasswordAttemptRateLimited(attemptKey)) {
            LoginHandler.rejectLogin(client, email, 'password attempt rate limit exceeded');
            return;
        }

        if (!isValidPasswordInput(password)) {
            LoginHandler.recordFailedPasswordAttempt(attemptKey);
            LoginHandler.rejectLogin(client, email, 'empty password');
            return;
        }

        if (Config.MULTIPLAYER_MODE && (!challenge || !isClientPasswordDigest(password))) {
            LoginHandler.recordFailedPasswordAttempt(attemptKey);
            LoginHandler.rejectLogin(client, email, 'missing login challenge or malformed challenge response');
            return;
        }

        const account = await LoginHandler.db.getAccount(email);
        if (!account) {
            LoginHandler.recordFailedPasswordAttempt(attemptKey);
            LoginHandler.rejectLogin(client, email, 'unknown account');
            return;
        }

        if (!account.passwordHash) {
            LoginHandler.recordFailedPasswordAttempt(attemptKey);
            LoginHandler.rejectLogin(
                client,
                email,
                'account has no password record',
                hasValidDiscordSync(account) ? PASSWORD_NOT_SET_MESSAGE : INVALID_CREDENTIALS_MESSAGE
            );
            return;
        }

        const unmaskedPassword = unmaskChallengeXorClientPassword(password, challenge);
        let validPassword = false;
        try {
            validPassword = await verifyClientPasswordInput(unmaskedPassword, account);
            if (!validPassword && !Config.MULTIPLAYER_MODE && unmaskedPassword !== password) {
                validPassword = await verifyClientPasswordInput(password, account);
            }
        } catch (err) {
            console.error(`[Login] Password verification failed internally for ${email}:`, err);
        }

        if (!validPassword) {
            LoginHandler.recordFailedPasswordAttempt(attemptKey);
            LoginHandler.rejectLogin(client, email, 'password mismatch');
            return;
        }

        LoginHandler.failedPasswordAttempts.delete(attemptKey);
        await LoginHandler.completeAuthentication(client, account, 'password verified', true);
    }
    static sendCharacterList(client: Client): void {
        const bb = new BitBuffer();
        const maxChars = 8;
        const charCount = client.characters.length;

        if (client.userId === null) {
            console.error("[Login] Cannot send char list: User ID is null");
            return;
        }

        // method_4(user_id)
        bb.writeMethod4(client.userId);
        
        // method_393(max_chars)
        bb.writeMethod393(maxChars);
        
        // method_393(char_count)
        bb.writeMethod393(charCount);

        for (const char of client.characters) {
            bb.writeMethod13(char.name);
            bb.writeMethod13(char.class);
            // level is commonly just "level", but python said char["level"]
            // If new char, it might be undefined, so default to 1.
            const level = char.level || 1;
            bb.writeMethod6(level, 6);
        }

        client.sendBitBuffer(0x15, bb);
    }

    static sendPopup(client: Client, message: string, disconnect: boolean): void {
        const bb = new BitBuffer();
        bb.writeMethod13(message);
        bb.writeMethod6(disconnect ? 1 : 0, 1);
        client.sendBitBuffer(0x1B, bb);
    }
}
