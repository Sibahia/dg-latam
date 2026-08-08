import express from 'express';
import rateLimit from 'express-rate-limit';
import * as crypto from 'crypto';
import * as fs from 'fs';
import type { Server as HttpServer } from 'http';
import type { Socket } from 'net';
import * as path from 'path';
import type { Request } from 'express';
import { Config } from './config';
import { buildDungeonBlitzSwfVariantBuffer, type DungeonBlitzSwfLocale } from './DungeonBlitzSwf';
import { PresenceService } from './PresenceService';
import { SocialHandler } from '../handlers/SocialHandler';
import { GlobalState } from './GlobalState';
import { DiscordAccountLinkService } from '../integrations/DiscordAccountLinkService';
import { JsonAdapter } from '../database/JsonAdapter';
import {
    hashPlaintextPasswordForClient,
    isValidRegistrationPassword,
    normalizeAccountIdentifier
} from '../auth/PasswordAuth';

function resolveContentDir(relativeContentPath: string): string {
    const candidates = [
        path.resolve(Config.DATA_DIR, relativeContentPath),
        path.resolve(__dirname, relativeContentPath),
        path.resolve(process.cwd(), relativeContentPath),
        path.resolve(process.cwd(), '../client/content/localhost'),
        path.resolve(process.cwd(), 'src/client/content/localhost')
    ];

    for (const candidate of candidates) {
        if (fs.existsSync(path.join(candidate, 'index.html'))) {
            return candidate;
        }
    }

    return candidates[0];
}

function escapeHtml(value: string | null | undefined): string {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Keyed on the socket address, not forwarded headers: a spoofable key would let one
// caller evade the limit (and hand out other players' buckets) on auth routes.
// ponytail: in-process counters, per-instance. Move to a shared store if the game
// server is ever run as more than one process behind a balancer.
function ipRateLimit(windowMs: number, limit: number, message: string) {
    return rateLimit({
        windowMs,
        limit,
        standardHeaders: 'draft-7',
        legacyHeaders: false,
        validate: { xForwardedForHeader: false },
        message
    });
}

// Password reset, Discord OAuth, and account linking: slow enough to make guessing
// state/code values and reset spam impractical, loose enough for a real retry.
const authRateLimit = () => ipRateLimit(15 * 60 * 1000, 30, 'Too many attempts. Wait a few minutes and try again.');

// Asset and status reads. A cold client load pulls dozens of SWF/XML files, and a
// whole household can share one NAT address, so the ceiling is high on purpose --
// it exists to bound a flood, not to shape normal play.
const assetRateLimit = () => ipRateLimit(60 * 1000, 1000, 'Too many requests. Slow down and try again.');

// The login page polls /api/auth/discord/pending once a second for up to two
// minutes while it waits for the OAuth window, so this one cannot use the auth
// budget -- a real login would exhaust it.
const pollRateLimit = () => ipRateLimit(60 * 1000, 90, 'Too many requests. Slow down and try again.');

export class StaticServer {
    private app: express.Application;
    private server: HttpServer | null;
    private readonly sockets = new Set<Socket>();
    private stopPromise: Promise<void> | null = null;
    private port: number;
    private contentDir: string;
    private host: string;
    private selectedSwfCache: { key: string; buffer: Buffer } | null;
    private readonly discordAccountLinks: DiscordAccountLinkService;
    private readonly db: JsonAdapter;
    private readonly selectedAssetVersion = 'cbp';
    private readonly flashVersion = this.selectedAssetVersion;
    private readonly gameVersion = this.selectedAssetVersion;
    private clientRevisionCache: { key: string; value: string } | null = null;

    // Every SWF request is redirected to this token, so it — not index.html's own literal — is
    // what decides whether a browser reuses its cached client. It used to be a hand-maintained
    // constant, which meant every client build collapsed onto one cache key and index.html's
    // cache buster did nothing (see the warning in
    // scripts/patch-dungeonblitz-hide-duplicate-boss-visual.ts). That was harmless while SWFs
    // were served `no-store`, but once they became cacheable it left players on a stale client
    // — #648 shipped a new DungeonBlitz.swf and nobody bumped this.
    //
    // Derive it from the SWF's content hash instead, using the same `swf-<sha1[0:12]>` scheme
    // syncClientRev writes into index.html, so the two stay in lockstep with no manual step.
    private get clientRevision(): string {
        const swfPath = this.getSelectedSwfPath();
        try {
            const stats = fs.statSync(swfPath);
            const cacheKey = `${stats.mtimeMs}:${stats.size}`;
            if (this.clientRevisionCache?.key === cacheKey) {
                return this.clientRevisionCache.value;
            }

            const digest = crypto.createHash('sha1').update(fs.readFileSync(swfPath)).digest('hex').slice(0, 12);
            const value = `swf-${digest}`;
            this.clientRevisionCache = { key: cacheKey, value };
            return value;
        } catch {
            return 'swf-unknown';
        }
    }

    private static shouldLog(): boolean {
        return process.env.DEBUG_STATIC_SERVER === '1';
    }

    constructor(
        port: number = Config.STATIC_PORT,
        relativeContentPath: string = '../client/content/localhost',
        host: string = Config.BIND_HOST
    ) {
        this.port = port;
        this.host = host;
        if (Config.ALLOW_DEV_PASSWORD_RESET && !['localhost', '127.0.0.1', '::1'].includes(host.trim().toLowerCase())) {
            throw new Error('Development password reset requires a loopback HTTP bind.');
        }
        this.app = express();
        this.app.set('trust proxy', Config.TRUST_PROXY_HEADERS ? Config.TRUSTED_PROXY_ADDRESSES : false);
        this.server = null;
        this.selectedSwfCache = null;
        this.discordAccountLinks = new DiscordAccountLinkService();
        this.db = new JsonAdapter();
        
        // Resolve against the server root so dist and ts-node use the same content directory.
        this.contentDir = resolveContentDir(relativeContentPath);
        
        this.setupRoutes();
    }

    private getSelectedSwfPath(): string {
        return path.join(this.contentDir, 'p', this.selectedAssetVersion, 'DungeonBlitz.swf');
    }

    private getSelectedSwfBuffer(locale: DungeonBlitzSwfLocale): Buffer {
        const mode = Config.MULTIPLAYER_MODE ? 'multiplayer' : 'local';
        const swfPath = this.getSelectedSwfPath();
        const stats = fs.statSync(swfPath);
        const cacheKey = `${mode}:${locale}:${swfPath}:${stats.mtimeMs}:${stats.size}`;
        if (this.selectedSwfCache?.key === cacheKey) {
            return this.selectedSwfCache.buffer;
        }

        const buffer = buildDungeonBlitzSwfVariantBuffer(swfPath, mode, locale);
        this.selectedSwfCache = { key: cacheKey, buffer };
        if (StaticServer.shouldLog()) {
            console.log(`[StaticServer] Prepared DungeonBlitz.swf variant for ${mode} mode (${locale}).`);
        }
        return buffer;
    }

    private getSelectedSwfUrl(): string {
        return `/p/${this.selectedAssetVersion}/DungeonBlitz.swf?fv=${this.flashVersion}&gv=${this.gameVersion}&clientrev=${this.clientRevision}`;
    }

    private getCanonicalSelectedSwfUrl(req?: Request): string {
        const params = new URLSearchParams();
        params.set('fv', this.flashVersion);
        params.set('gv', this.gameVersion);
        params.set('clientrev', this.clientRevision);

        if (req) {
            for (const [key, rawValue] of Object.entries(req.query)) {
                if (key === 'fv' || key === 'gv' || key === 'clientrev') {
                    continue;
                }

                const values = Array.isArray(rawValue) ? rawValue : [rawValue];
                for (const value of values) {
                    if (value === undefined || value === null || typeof value === 'object') {
                        continue;
                    }
                    params.append(key, String(value));
                }
            }
        }

        return `/p/${this.selectedAssetVersion}/DungeonBlitz.swf?${params.toString()}`;
    }

    private isCanonicalSelectedSwfRequest(req: Request): boolean {
        return String(req.query.fv ?? '') === this.flashVersion &&
            String(req.query.gv ?? '') === this.gameVersion &&
            String(req.query.clientrev ?? '') === this.clientRevision;
    }

    private normalizeLocale(value: unknown): 'en' | 'tr' | null {
        const normalized = String(value ?? '').trim().toLowerCase();
        return normalized === 'en' || normalized === 'tr' ? normalized : null;
    }

    private normalizeRemoteAddress(value: string | null | undefined): string {
        return GlobalState.normalizeRemoteAddress(value);
    }

    private resolveSessionLocale(req: Request): 'en' | 'tr' | null {
        const remoteAddress = this.normalizeRemoteAddress(this.resolveRequesterAddress(req));
        if (!remoteAddress) {
            return null;
        }

        const sessions = Array.from(GlobalState.sessionsByToken.values()).filter((client) => {
            return this.normalizeRemoteAddress(client.socket.remoteAddress) === remoteAddress;
        });
        const activeSessions = sessions.filter((client) => client.playerSpawned);
        const candidates = activeSessions.length > 0 ? activeSessions : sessions;
        const locales = new Set(
            candidates
                .map((client) => this.normalizeLocale(client.character?.dialogueLanguage))
                .filter((locale): locale is 'en' | 'tr' => Boolean(locale))
        );

        return locales.size === 1 ? [...locales][0] ?? null : null;
    }

    private resolveGameSwzLocale(req: Request): 'en' | 'tr' {
        return (
            this.normalizeLocale(req.query.lang) ??
            this.resolveSessionLocale(req) ??
            'en'
        );
    }

    private resolveSwfLocale(req: Request): DungeonBlitzSwfLocale {
        return (
            this.normalizeLocale(req.query.lang) ??
            this.resolveSessionLocale(req) ??
            'en'
        );
    }

    private getGameSwzPathForLocale(locale: 'en' | 'tr'): string {
        const cbqDir = path.join(this.contentDir, 'p', 'cbq');
        const variantPath = path.join(cbqDir, `Game.${locale}.swz`);
        if (fs.existsSync(variantPath)) {
            return variantPath;
        }

        if (locale === 'en') {
            const backupPath = path.join(cbqDir, 'Game.swz.bak');
            if (fs.existsSync(backupPath)) {
                return backupPath;
            }
        }

        return path.join(cbqDir, 'Game.swz');
    }

    private getFlashVersionAssetPath(assetPath: string): string {
        const segments = assetPath.split('/').filter(Boolean);
        if (segments.some((segment) => segment === '..' || segment.includes(path.sep))) {
            return path.join(this.contentDir, 'p', this.flashVersion, '__invalid__');
        }
        const normalizedAssetPath = segments.join(path.sep);
        const versionedPath = path.join(this.contentDir, 'p', this.flashVersion, normalizedAssetPath);
        if (fs.existsSync(versionedPath)) {
            return versionedPath;
        }

        return path.join(this.contentDir, 'p', 'cbq', normalizedAssetPath);
    }

    private renderDevSettings(devSettingsPath: string): string {
        const contents = fs.readFileSync(devSettingsPath, 'utf8');
        return contents.replace(
            /value="(?:100\.100\.146\.54|127\.0\.0\.1|localhost)"/g,
            `value="${Config.HOST}"`
        );
    }

    private isDiscordClientLaunchRequest(req: Request): boolean {
        const requestedClient = String(req.query.client ?? req.query.launch ?? '').trim().toLowerCase();
        return requestedClient === 'discord' || requestedClient === 'desktop';
    }

    private toDiscordClientAuthorizeUrl(authorizeUrl: string): string {
        const parsed = new URL(authorizeUrl);
        return `discord://-/oauth2/authorize?${parsed.searchParams.toString()}`;
    }

    private renderLostPasswordPage(message: string = '', isError: boolean = false): string {
        const resetEnabled = Config.ALLOW_DEV_PASSWORD_RESET || this.discordAccountLinks.canDeliverPasswordReset();
        const statusClass = isError ? 'error' : 'success';
        const safeMessage = message
            ? `<p class="message ${statusClass}">${escapeHtml(message)}</p>`
            : '';
        const disabled = resetEnabled ? '' : 'disabled';
        const unavailable = resetEnabled
            ? ''
            : '<p class="message error">Password reset is not configured for this server mode.</p>';

        return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Dungeon Blitz Password Reset</title>
  <style>
    body { margin: 0; font-family: Arial, sans-serif; background: #f2f4f7; color: #17202a; }
    main { width: min(420px, calc(100% - 32px)); margin: 48px auto; background: #fff; border: 1px solid #d7dde5; padding: 24px; }
    h1 { margin: 0 0 16px; font-size: 24px; }
    label { display: block; margin: 14px 0 6px; font-weight: 700; }
    input { box-sizing: border-box; width: 100%; padding: 10px; border: 1px solid #b7c0cc; font: inherit; }
    button { margin-top: 18px; width: 100%; padding: 10px 12px; border: 0; background: #1b5f8f; color: #fff; font: inherit; font-weight: 700; cursor: pointer; }
    button:disabled { background: #8c98a6; cursor: not-allowed; }
    .message { padding: 10px; border: 1px solid; }
    .success { background: #e9f7ef; border-color: #8fd19e; }
    .error { background: #fdecea; border-color: #f0a29a; }
    .note { color: #536171; font-size: 13px; line-height: 1.4; }
  </style>
</head>
<body>
  <main>
    <h1>Password Reset</h1>
    ${unavailable}
    ${safeMessage}
    <form method="post" action="/lostpw" autocomplete="off">
      <label for="email">Email</label>
      <input id="email" name="email" type="email" required ${disabled}>
      <button type="submit" ${disabled}>Send Discord password</button>
    </form>
    <p class="note">For Discord-linked accounts, the bot sends a fresh password by DM.</p>
  </main>
</body>
</html>`;
    }

    private renderDiscordOAuthPage(
        title: string,
        message: string,
        isError: boolean = false,
        notifyDiscordOAuthComplete: boolean = false
    ): string {
        const statusClass = isError ? 'error' : 'success';
        const completionScript = notifyDiscordOAuthComplete
            ? `<script>
try {
  localStorage.setItem('db_discord_oauth_complete', String(Date.now()));
} catch (_error) {}
</script>`
            : '';
        return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    body { margin: 0; font-family: Arial, sans-serif; background: #f2f4f7; color: #17202a; }
    main { width: min(520px, calc(100% - 32px)); margin: 48px auto; background: #fff; border: 1px solid #d7dde5; padding: 24px; }
    h1 { margin: 0 0 16px; font-size: 24px; }
    .message { padding: 10px; border: 1px solid; line-height: 1.45; }
    .success { background: #e9f7ef; border-color: #8fd19e; }
    .error { background: #fdecea; border-color: #f0a29a; }
    a { color: #1b5f8f; }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(title)}</h1>
    <p class="message ${statusClass}">${escapeHtml(message)}</p>
    <p><a href="/">Return to the game</a></p>
  </main>
  ${completionScript}
</body>
</html>`;
    }

    private resolveRequesterAddress(req: Request): string {
        return req.ip || req.socket.remoteAddress || '';
    }

    private isSameOriginFormRequest(req: Request): boolean {
        const origin = String(req.headers.origin ?? '').trim();
        if (!origin) {
            return true;
        }
        try {
            return new URL(origin).host === String(req.headers.host ?? '').trim();
        } catch {
            return false;
        }
    }

    private consumePresenceServiceTicket(
        req: Request,
        audience: 'presence:read' | 'presence:join'
    ): { subject: string } | null {
        const authorization = String(req.headers.authorization ?? '').trim();
        const bearer = authorization.toLowerCase().startsWith('bearer ')
            ? authorization.slice('bearer '.length).trim()
            : '';
        const explicit = String(req.headers['x-dungeonblitz-service-ticket'] ?? '').trim();
        return PresenceService.consumeServiceTicket(bearer || explicit, audience);
    }

    private setupRoutes(): void {
        const devSettingsPath = path.join(this.contentDir, 'p', 'cbq', 'devSettings.xml');

        this.app.use(express.json({ limit: '64kb' }));
        this.app.use(express.urlencoded({ extended: false, limit: '16kb' }));

        this.app.use((req, res, next) => {
            const shouldLog =
                req.path === '/' ||
                req.path.endsWith('.swf') ||
                req.path.endsWith('.swz') ||
                req.path.endsWith('.xml');

            if (shouldLog && StaticServer.shouldLog()) {
                const remoteAddress = req.socket.remoteAddress ?? '-';
                const startedAt = Date.now();
                let finished = false;
                console.log(`[StaticServer] -> ${req.method} ${req.path} from ${remoteAddress}`);
                res.on('finish', () => {
                    finished = true;
                    console.log(
                        `[StaticServer] <- ${res.statusCode} ${req.method} ${req.path} to ${remoteAddress} ${Date.now() - startedAt}ms`
                    );
                });
                res.on('close', () => {
                    if (!finished) {
                        console.log(
                            `[StaticServer] xx ${req.method} ${req.path} to ${remoteAddress} closed after ${Date.now() - startedAt}ms`
                        );
                    }
                });
            }

            if (req.path.endsWith('.swf') || req.path.endsWith('.swz')) {
                res.type('application/x-shockwave-flash');
            }

            if (
                req.path === '/' ||
                req.path.endsWith('.swf') ||
                req.path.endsWith('.swz') ||
                req.path.endsWith('.xml')
            ) {
                // Revalidate-always, but let the client keep the bytes. `no-store` used to be
                // set here, which defeated the clientRevision cache-busting token above and
                // forced Flash to re-download every level SWF (3-6 MB each) on every load and
                // every region change. `no-cache` keeps content just as fresh -- the browser
                // still asks on each request, and send()'s mtime/size ETag picks up a patched
                // SWF immediately -- but an unchanged asset answers 304 instead of the body.
                res.setHeader('Cache-Control', 'no-cache, must-revalidate, proxy-revalidate');
                res.setHeader('Surrogate-Control', 'no-store');
            }
            next();
        });

        // Registered ahead of every route below so each one inherits a limit.
        this.app.use(assetRateLimit());
        this.app.use('/api/auth/discord/pending', pollRateLimit());
        this.app.use([
            '/lostpw',
            '/auth/discord',
            '/callback',
            '/discord/link',
            '/api/discord/link',
            '/api/discord-linked-roles'
        ], authRateLimit());

        this.app.get('/', (_req, res) => {
            res.sendFile(path.join(this.contentDir, 'index.html'));
        });

        // Public Talents calculator (no auth required). Without the trailing
        // slash the browser resolves relative asset URLs (data/, images/, js/)
        // against the site root, so /calculadora must redirect to /calculadora/.
        // In non-strict routing a bare '/calculadora' route also matches
        // '/calculadora/', so serve that case directly to avoid a redirect loop.
        this.app.get('/calculadora', (req, res) => {
            if (req.path.endsWith('/')) {
                res.sendFile(path.join(this.contentDir, 'calculadora', 'index.html'));
                return;
            }
            res.redirect(301, '/calculadora/');
        });

        this.app.get('/lostpw', (req, res) => {
            console.log(`[LostPassword] Page opened from ${this.normalizeRemoteAddress(this.resolveRequesterAddress(req)) || '-'}`);
            res.setHeader('Cache-Control', 'no-store');
            res.type('text/html').send(this.renderLostPasswordPage());
        });

        this.app.post('/lostpw', async (req, res) => {
            res.setHeader('Cache-Control', 'no-store');
            if (!this.isSameOriginFormRequest(req)) {
                res.status(403).type('text/html').send(
                    this.renderLostPasswordPage('Cross-site password reset requests are not allowed.', true)
                );
                return;
            }
            const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
            const email = normalizeAccountIdentifier(body.email);
            const password = typeof body.password === 'string' ? body.password : '';
            const confirmPassword = typeof body.confirmPassword === 'string' ? body.confirmPassword : '';
            const hasManualPassword = password.length > 0 || confirmPassword.length > 0;

            console.log(`[LostPassword] Reset attempted for ${email || '(missing account id)'}`);

            if (!email) {
                console.warn(`[LostPassword] Reset failed for ${email || '(missing account id)'}: invalid form`);
                res.status(400).type('text/html').send(
                    this.renderLostPasswordPage('Could not reset password. Check the email and try again.', true)
                );
                return;
            }

            const existingAccount = await this.db.getAccount(email);
            if (!existingAccount) {
                console.warn(`[LostPassword] Reset failed for ${email}: account not found`);
                res.status(400).type('text/html').send(
                    this.renderLostPasswordPage('Could not reset password. Check the form fields and try again.', true)
                );
                return;
            }

            if (existingAccount.discordId) {
                const delivery = await this.discordAccountLinks.deliverPasswordReset(existingAccount);
                if (!delivery.ok) {
                    console.warn(`[LostPassword] Discord DM reset failed for ${email}: ${delivery.reason}`);
                    res.status(delivery.reason === 'bot-disabled' ? 503 : 400).type('text/html').send(
                        this.renderLostPasswordPage(delivery.message, true)
                    );
                    return;
                }

                console.log(`[LostPassword] Discord DM reset sent for ${delivery.account?.email ?? existingAccount.email}`);
                res.type('text/html').send(
                    this.renderLostPasswordPage('A new password was sent to the linked Discord DM.', false)
                );
                return;
            }

            if (!Config.ALLOW_DEV_PASSWORD_RESET) {
                console.warn(`[LostPassword] Reset rejected for ${email}: reset disabled`);
                res.status(403).type('text/html').send(
                    this.renderLostPasswordPage('Password reset is not configured for this server mode.', true)
                );
                return;
            }

            if (!hasManualPassword || !isValidRegistrationPassword(password) || password !== confirmPassword) {
                console.warn(`[LostPassword] Reset failed for ${email}: account is not Discord-linked`);
                res.status(400).type('text/html').send(
                    this.renderLostPasswordPage('That account is not linked to Discord. Use Discord login first, then try again.', true)
                );
                return;
            }

            const account = await this.db.updateAccountPassword(
                email,
                await hashPlaintextPasswordForClient(password)
            );
            if (!account) {
                console.warn(`[LostPassword] Reset failed for ${email}: account update failed`);
                res.status(400).type('text/html').send(
                    this.renderLostPasswordPage('Could not reset password. Check the form fields and try again.', true)
                );
                return;
            }

            console.log(`[LostPassword] Reset succeeded for ${email}`);
            res.type('text/html').send(
                this.renderLostPasswordPage('Password reset complete. You can return to the game and log in.', false)
            );
        });

        this.app.get('/api/auth/discord/config', (_req, res) => {
            const authUrl = '/auth/discord';
            res.setHeader('Cache-Control', 'no-store');
            res.json({
                configured: this.discordAccountLinks.isConfigured(),
                required: true,
                authUrl,
                linkUrl: null,
                clientAuthUrl: `${authUrl}?client=discord`,
                clientLinkUrl: null,
                mode: 'login',
                createsAccounts: false,
                accountCreateCommand: '/create-account',
                redirectUri: this.discordAccountLinks.getRedirectUri(),
                linkedRolesConnectUrl: this.discordAccountLinks.getLinkedRolesConnectUrl(),
                sponsorRequired: Config.SPONSOR_ACCOUNT_CREATION_REQUIRED
            });
        });

        this.app.get('/api/auth/discord/pending', (req, res) => {
            res.setHeader('Cache-Control', 'no-store');
            res.json({
                pending: false
            });
        });

        this.app.get('/auth/discord', async (req, res) => {
            if (!this.discordAccountLinks.isConfigured()) {
                console.warn('[DiscordOAuth] Start rejected: not configured');
                res.status(503).type('text/html').send(
                    this.renderDiscordOAuthPage(
                        'Discord Login Disabled',
                        'Discord OAuth is not configured on this server.',
                        true
                    )
                );
                return;
            }

            const result = await this.discordAccountLinks.createLoginAuthorizeUrl();

            if (!result.ok || !result.authorizeUrl) {
                console.warn(`[DiscordOAuth] Start failed: ${result.reason}`);
                res.status(result.reason === 'not-configured' ? 503 : 400).type('text/html').send(
                    this.renderDiscordOAuthPage('Discord Login Failed', result.message ?? 'Discord login could not start.', true)
                );
                return;
            }

            console.log('[DiscordOAuth] Starting login flow');
            res.redirect(
                this.isDiscordClientLaunchRequest(req)
                    ? this.toDiscordClientAuthorizeUrl(result.authorizeUrl)
                    : result.authorizeUrl
            );
        });

        this.app.get([
            '/auth/discord/callback',
            '/api/discord-linked-roles/callback',
            '/callback'
        ], async (req, res) => {
            const discordError = String(req.query.error ?? '').trim();
            if (discordError) {
                console.warn(`[DiscordOAuth] Callback failed: ${discordError}`);
                res.status(400).type('text/html').send(
                    this.renderDiscordOAuthPage('Discord Login Cancelled', 'Discord authorization did not complete.', true)
                );
                return;
            }

            const code = String(req.query.code ?? '').trim();
            const state = String(req.query.state ?? '').trim();
            const result = await this.discordAccountLinks.completeOAuth(code, state);
            if (!result.ok || !result.account) {
                const failureMessage = String(result.message ?? '').replace(/\s+/g, ' ').slice(0, 500);
                console.warn(
                    `[DiscordOAuth] Callback rejected: ${result.reason}` +
                    (failureMessage ? ` message=${failureMessage}` : '')
                );
                const status = [
                    'duplicate-discord-linked-account',
                    'account-sync-failed'
                ].includes(result.reason) ? 409 : result.reason === 'account-not-found' ? 404 : 400;
                const title = result.reason === 'duplicate-discord-linked-account'
                    ? 'Discord Account Already Linked'
                    : result.reason === 'account-not-found'
                        ? 'Create Your Account in Discord First'
                    : result.reason === 'missing-discord-email'
                            ? 'Discord Email Required'
                            : result.reason === 'discord-email-unverified'
                                ? 'Discord Email Not Verified'
                                : result.reason === 'sponsor-verification-required'
                                    ? 'Discord Sponsor Verification Required'
                                    : result.reason === 'sponsor-check-unavailable'
                                        ? 'Discord Sponsor Verification Unavailable'
                                        : 'Discord Login Failed';
                res.status(status).type('text/html').send(
                    this.renderDiscordOAuthPage(
                        title,
                        result.message ?? 'Discord login failed.',
                        true
                    )
                );
                return;
            }

            if (result.mode === 'link') {
                console.log(`[DiscordOAuth] Linked Discord account to ${result.account.email}`);
                res.type('text/html').send(
                    this.renderDiscordOAuthPage('Discord Linked', 'Discord linked successfully. Return to the game.')
                );
                return;
            }

            console.log(`[DiscordOAuth] Login identity verified for ${result.account.email}`);
            res.type('text/html').send(
                this.renderDiscordOAuthPage(
                    'Discord Login Successful',
                    'Discord identity verified. Return to the game and sign in with your account password.',
                    false
                )
            );
        });

        this.app.get([
            `/p/${this.selectedAssetVersion}/DungeonBlitz.swf`,
            `/p/${this.selectedAssetVersion}/DungeonBlitz.discord-oauth.swf`,
            `/p/${this.selectedAssetVersion}/DungeonBlitz.1.8.0.swf`
        ], (req, res) => {
            if (!this.isCanonicalSelectedSwfRequest(req)) {
                res.redirect(302, this.getCanonicalSelectedSwfUrl(req));
                return;
            }

            const locale = this.resolveSwfLocale(req);
            res.type('application/x-shockwave-flash');
            res.setHeader('X-DungeonBlitz-Language', locale);
            res.send(this.getSelectedSwfBuffer(locale));
        });

        this.app.get('/p/cbq/Game.swz', (req, res) => {
            const locale = this.resolveGameSwzLocale(req);
            const swzPath = this.getGameSwzPathForLocale(locale);
            res.type('application/x-shockwave-flash');
            res.setHeader('X-DungeonBlitz-Language', locale);
            res.sendFile(swzPath);
        });

        this.app.get('/p/:assetVersion/Game.swz', (req, res) => {
            const locale = this.resolveGameSwzLocale(req);
            const swzPath = this.getGameSwzPathForLocale(locale);
            res.type('application/x-shockwave-flash');
            res.setHeader('X-DungeonBlitz-Language', locale);
            res.sendFile(swzPath);
        });

        this.app.get(/^\/p\/[^/]+\/masterFileList(?:_\d+)?\.xml$/, (req, res, next) => {
            const assetPath = this.getFlashVersionAssetPath(`/${path.basename(req.path)}`);
            if (!fs.existsSync(assetPath) || !fs.statSync(assetPath).isFile()) {
                next();
                return;
            }

            res.type('application/xml');
            res.sendFile(assetPath);
        });

        this.app.get('/DungeonBlitzRemote.swf', (req, res) => {
            const locale = this.resolveSwfLocale(req);
            res.type('application/x-shockwave-flash');
            res.setHeader('X-DungeonBlitz-Language', locale);
            res.send(this.getSelectedSwfBuffer(locale));
        });

        this.app.get('/p/cbq/devSettings.xml', (_req, res) => {
            res.type('application/xml');
            res.send(this.renderDevSettings(devSettingsPath));
        });

        this.app.use(`/p/${this.flashVersion}`, (req, res, next) => {
            const assetPath = this.getFlashVersionAssetPath(req.path);
            // One stat instead of existsSync + statSync; this runs for every level SWF fetch.
            let stats: fs.Stats;
            try {
                stats = fs.statSync(assetPath);
            } catch {
                next();
                return;
            }
            if (!stats.isFile()) {
                next();
                return;
            }

            if (assetPath.endsWith('.xml')) {
                res.type('application/xml');
            }
            res.sendFile(assetPath);
        });

        this.app.get('/api/presence/sessions', (req, res) => {
            if (!this.consumePresenceServiceTicket(req, 'presence:read')) {
                res.status(401).json({ ok: false, reason: 'service-ticket-required' });
                return;
            }
            const requestedCharacter = String(req.query.character ?? '').trim();
            const sessions = PresenceService.listSessions().filter((session) => {
                if (!requestedCharacter) {
                    return true;
                }
                return session.characterName.localeCompare(requestedCharacter, undefined, { sensitivity: 'accent' }) === 0;
            });

            res.setHeader('Cache-Control', 'no-store');
            res.json({
                serverTime: new Date().toISOString(),
                count: sessions.length,
                sessions
            });
        });

        this.app.get('/api/presence/discord-target', (req, res) => {
            if (!this.consumePresenceServiceTicket(req, 'presence:read')) {
                res.status(401).json({ ok: false, reason: 'service-ticket-required' });
                return;
            }
            const requestedCharacter = String(req.query.character ?? '').trim();
            const selection = PresenceService.selectDiscordTarget(requestedCharacter);
            const statusCode =
                selection.reason === 'ok' ? 200 : selection.reason === 'ambiguous' ? 409 : 404;

            res.setHeader('Cache-Control', 'no-store');
            res.status(statusCode).json({
                serverTime: new Date().toISOString(),
                reason: selection.reason,
                availableCharacters: selection.availableCharacters,
                session: selection.snapshot
            });
        });

        this.app.get('/api/presence/self', (req, res) => {
            if (!this.consumePresenceServiceTicket(req, 'presence:read')) {
                res.status(401).json({ ok: false, reason: 'service-ticket-required' });
                return;
            }
            const selection = PresenceService.selectRequesterSession(this.resolveRequesterAddress(req));
            const statusCode =
                selection.reason === 'ok' ? 200 : selection.reason === 'ambiguous' ? 409 : 404;

            res.setHeader('Cache-Control', 'no-store');
            res.status(statusCode).json({
                serverTime: new Date().toISOString(),
                reason: selection.reason,
                remoteAddress: selection.remoteAddress,
                availableCharacters: selection.availableCharacters,
                session: selection.snapshot
            });
        });

        this.app.get('/discord/link', async (req, res) => {
            res.status(410).type('text/plain').send(
                'Public account linking is disabled. Link accounts through an authenticated account-management flow.'
            );
        });

        this.app.get('/api/discord/link/start', async (req, res) => {
            res.setHeader('Cache-Control', 'no-store');
            res.status(401).json({
                ok: false,
                reason: 'authenticated-account-required',
                message: 'Public account linking is disabled.'
            });
        });

        this.app.get('/api/discord/link/callback', async (req, res) => {
            const code = String(req.query.code ?? '').trim();
            const state = String(req.query.state ?? '').trim();
            const result = await this.discordAccountLinks.completeLink(code, state);
            const statusCode = result.ok ? 200 : 400;

            res.setHeader('Cache-Control', 'no-store');
            if (!result.ok || !result.account) {
                res.status(statusCode).type('text/html').send(
                    `<h1>Discord link failed</h1><p>${escapeHtml(result.message ?? result.reason)}</p>`
                );
                return;
            }

            const discordName =
                result.discordUser?.globalName ||
                result.discordUser?.username ||
                result.discordUser?.id ||
                result.account.discordGlobalName ||
                result.account.discordUsername ||
                result.account.discordId ||
                'Discord';
            res.type('text/html').send(
                `<h1>Discord linked</h1><p>${escapeHtml(discordName)} is now linked to ${escapeHtml(result.account.email)}.</p>`
            );
        });

        this.app.post('/api/presence/discord-join', (req, res) => {
            const serviceTicket = this.consumePresenceServiceTicket(req, 'presence:join');
            if (!serviceTicket) {
                res.status(401).json({
                    ok: false,
                    reason: 'service-ticket-required',
                    message: 'A valid Discord bridge service ticket is required.'
                });
                return;
            }
            const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
            const secret = String(body.secret ?? '').trim();
            const decodedSecret = PresenceService.resolveDiscordJoinSecret(secret);

            if (!decodedSecret) {
                res.status(400).json({
                    ok: false,
                    reason: 'invalid-secret',
                    message: 'Invalid Discord join secret.'
                });
                return;
            }

            const resolvedRequesterName = serviceTicket.subject;

            if (!resolvedRequesterName) {
                res.status(404).json({
                    ok: false,
                    reason: 'requester-not-found',
                    message: 'Could not resolve an online character for this Discord join.'
                });
                return;
            }

            const result = SocialHandler.joinPartyFromDiscord(
                resolvedRequesterName,
                decodedSecret.partyId,
                decodedSecret.partyLeader
            );
            const statusCode = result.ok ? 200 : result.reason === 'party-not-found' ? 404 : 409;

            res.setHeader('Cache-Control', 'no-store');
            res.status(statusCode).json({
                ok: result.ok,
                reason: result.reason,
                message: result.message,
                partyId: result.partyId
            });
        });

        // Serve static files
        this.app.use(express.static(this.contentDir, { index: false }));

        this.app.get('/healthz', (_req, res) => {
            res.type('text/plain');
            res.setHeader('Cache-Control', 'no-store');
            res.setHeader('Connection', 'close');
            res.send('ok');
        });
        
        // Debug route to check path
        this.app.get('/debug-path', (req, res) => {
            res.send(`Serving content from: ${this.contentDir}`);
        });
    }

    public start(): void {
        this.server = this.app.listen(this.port, this.host, () => {
            console.log(`[StaticServer] Password reset URL: ${Config.PASSWORD_RESET_URL}`);
            if (Config.ALLOW_DEV_PASSWORD_RESET) {
                console.warn('[StaticServer] DEVELOPMENT PASSWORD RESET ENABLED (loopback-only).');
            }
            console.log(
                `[StaticServer] Discord OAuth login: ${this.discordAccountLinks.isConfigured() ? 'configured' : 'disabled'}`
            );
            if (this.discordAccountLinks.isConfigured()) {
                console.log(`[StaticServer] Discord OAuth redirect URI: ${this.discordAccountLinks.getRedirectUri()}`);
            }
            if (StaticServer.shouldLog()) {
                const portSuffix = this.port === 80 ? '' : `:${this.port}`;
                const baseUrl = `http://${Config.HOST}${portSuffix}`;
                console.log(`[StaticServer] Serving ${this.contentDir} on http://${this.host}:${this.port}`);
                console.log(`[StaticServer] Multiplayer mode: ${Config.MULTIPLAYER_MODE}`);
                console.log(`[StaticServer] Browser URL: ${baseUrl}/`);
                console.log(`[StaticServer] Flash URL: ${baseUrl}${this.getSelectedSwfUrl()}`);
            }
        });

        // Flash pulls ~100 assets per session. Node's 5s default keep-alive expires during
        // level loads and forces a fresh TCP handshake per asset, costing a full round trip
        // each on a remote host. headersTimeout must stay above keepAliveTimeout.
        this.server.keepAliveTimeout = 65_000;
        this.server.headersTimeout = 70_000;
        this.server.on('connection', (socket) => {
            this.sockets.add(socket);
            socket.once('close', () => this.sockets.delete(socket));
        });

        this.server.on('error', (error) => {
            const socketError = error as NodeJS.ErrnoException;
            if (socketError.code === 'EADDRINUSE') {
                console.error(
                    `[Server] Cannot listen on ${this.host}:${this.port} because the port is already in use.`
                );
                console.error('[Server] Stop the previous dev server or change STATIC_PORT before restarting.');
                process.exitCode = 1;
                setImmediate(() => process.exit(1));
                return;
            }

            console.error('[Server] Static server error:', error);
        });
    }

    public stop(): Promise<void> {
        if (this.stopPromise) {
            return this.stopPromise;
        }

        this.stopPromise = new Promise((resolve) => {
            let settled = false;
            const finish = async (): Promise<void> => {
                if (settled) return;
                settled = true;
                try {
                    await this.discordAccountLinks.close();
                } catch (error) {
                    console.error('[StaticServer] Integration stop error:', error);
                }
                resolve();
            };
            const deadline = setTimeout(() => {
                for (const socket of this.sockets) socket.destroy();
                void finish();
            }, Config.SHUTDOWN_GRACE_MS);
            deadline.unref?.();

            if (!this.server || !this.server.listening) {
                clearTimeout(deadline);
                for (const socket of this.sockets) socket.destroy();
                void finish();
                return;
            }

            this.server.close((error) => {
                if (error) {
                    console.error('[StaticServer] Stop error:', error);
                }
                clearTimeout(deadline);
                void finish();
            });
            this.server.closeIdleConnections?.();
        });
        return this.stopPromise;
    }
}
