import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function resolveServerDataDir(): string {
    const candidates = [
        path.resolve(process.cwd(), 'src/server'),
        path.resolve(__dirname, '../..'),
        path.resolve(__dirname, '..'),
        process.cwd()
    ];

    for (const candidate of candidates) {
        if (fs.existsSync(path.join(candidate, 'data', 'level_config.json'))) {
            return candidate;
        }
    }

    return path.resolve(process.cwd(), 'src/server');
}

function parseBooleanEnv(name: string, fallback: boolean): boolean {
    const raw = process.env[name];
    if (raw == null) {
        return fallback;
    }

    switch (raw.trim().toLowerCase()) {
        case '1':
        case 'true':
        case 'yes':
        case 'on':
            return true;
        case '0':
        case 'false':
        case 'no':
        case 'off':
            return false;
        default:
            return fallback;
    }
}

function parseNumberEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw == null) {
        return fallback;
    }

    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function parseBoundedNumberEnv(name: string, fallback: number, minimum: number, maximum: number): number {
    return Math.max(minimum, Math.min(maximum, parseNumberEnv(name, fallback)));
}

function parseStringEnv(name: string, fallback: string): string {
    const raw = process.env[name];
    if (raw == null) {
        return fallback;
    }

    const trimmed = raw.trim();
    return trimmed || fallback;
}

function parseCsvEnv(name: string, fallback: string[] = []): string[] {
    const raw = process.env[name];
    if (raw == null) {
        return [...fallback];
    }

    return raw
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
}

export function isLoopbackHost(host: string | null | undefined): boolean {
    const normalized = String(host ?? '').trim().toLowerCase();
    return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

export function resolveDevPasswordResetEnabled(
    multiplayerMode: boolean,
    bindHost: string,
    explicitlyRequested: boolean
): boolean {
    if (!explicitlyRequested) {
        return false;
    }
    if (multiplayerMode || !isLoopbackHost(bindHost)) {
        throw new Error(
            'ALLOW_DEV_PASSWORD_RESET may only be enabled in single-player mode on a loopback bind.'
        );
    }
    return true;
}

function parseHexEnv(name: string): string | null {
    const raw = process.env[name];
    if (raw == null) {
        return null;
    }

    const normalized = raw.trim().toLowerCase();
    return /^[0-9a-f]{32,128}$/.test(normalized) && normalized.length % 2 === 0
        ? normalized
        : null;
}

function resolveRuntimeKeyHex(): string {
    return parseHexEnv('DUNGEONBLITZ_KEY_HEX') ?? crypto.randomBytes(16).toString('hex');
}

export function normalizeHostValue(raw: string | undefined, fallback: string): string {
    const trimmed = String(raw ?? '').trim();
    if (!trimmed) {
        return fallback;
    }

    const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
    try {
        const parsed = new URL(withProtocol);
        if (parsed.hostname) {
            return parsed.hostname;
        }
    } catch {
        // Fall back to conservative string cleanup below.
    }

    return (
        trimmed
            .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
            .replace(/\/.*$/, '')
            .replace(/:\d+$/, '')
            .trim() || fallback
    );
}

function isPrivateIpv4Address(address: string): boolean {
    return (
        /^10\./.test(address) ||
        /^192\.168\./.test(address) ||
        /^172\.(1[6-9]|2\d|3[0-1])\./.test(address)
    );
}

function scoreInterfaceName(name: string): number {
    const normalized = name.trim().toLowerCase();

    if (normalized.includes('zerotier')) {
        return 400;
    }

    if (
        normalized.includes('tailscale') ||
        normalized.includes('hamachi') ||
        normalized.includes('radmin') ||
        normalized.includes('wireguard')
    ) {
        return 350;
    }

    if (
        normalized.includes('vpn') ||
        normalized.includes('tun') ||
        normalized.includes('tap') ||
        normalized.includes('virtual')
    ) {
        return 250;
    }

    if (
        normalized.includes('ethernet') ||
        normalized.includes('wi-fi') ||
        normalized.includes('wifi') ||
        normalized.includes('wlan')
    ) {
        return 100;
    }

    return 0;
}

export function resolveDefaultMultiplayerHost(
    enumerateInterfaces: typeof os.networkInterfaces = os.networkInterfaces
): string {
    const candidates: Array<{ name: string; address: string; score: number }> = [];

    let interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>;
    try {
        interfaces = enumerateInterfaces();
    } catch (error) {
        console.warn('[Config] Could not enumerate network interfaces; using localhost.', error);
        return 'localhost';
    }

    for (const [name, entries] of Object.entries(interfaces)) {
        for (const entry of entries ?? []) {
            if (entry.family !== 'IPv4' || entry.internal) {
                continue;
            }

            const privateScore = isPrivateIpv4Address(entry.address) ? 50 : 0;
            candidates.push({
                name,
                address: entry.address,
                score: scoreInterfaceName(name) + privateScore
            });
        }
    }

    candidates.sort((left, right) => right.score - left.score || left.address.localeCompare(right.address));
    return candidates[0]?.address ?? 'localhost';
}

const MULTIPLAYER_MODE = parseBooleanEnv('MULTIPLAYER_MODE', false);
const LOCAL_HOST = 'localhost';
const EXPLICIT_MULTIPLAYER_HOST = String(process.env.MULTIPLAYER_BASE_IP ?? '').trim();
export function resolveMultiplayerHost(
    multiplayerMode: boolean,
    explicitHost: string | undefined,
    resolveDefault: () => string = resolveDefaultMultiplayerHost
): string {
    const requestedHost = String(explicitHost ?? '').trim();
    if (requestedHost) return normalizeHostValue(requestedHost, LOCAL_HOST);
    if (!multiplayerMode) return LOCAL_HOST;
    return normalizeHostValue(resolveDefault(), LOCAL_HOST);
}
const MULTIPLAYER_HOST = resolveMultiplayerHost(MULTIPLAYER_MODE, EXPLICIT_MULTIPLAYER_HOST);
const DEFAULT_STATIC_PORT = MULTIPLAYER_MODE ? 80 : 8000;
const DEFAULT_GAME_PORT = 8080;
const DEFAULT_POLICY_PORT = 843;
const DEFAULT_PUBLIC_HOST = MULTIPLAYER_MODE ? MULTIPLAYER_HOST : LOCAL_HOST;
const DEFAULT_PUBLIC_BASE_URL = `http://${DEFAULT_PUBLIC_HOST}${DEFAULT_STATIC_PORT === 80 ? '' : `:${DEFAULT_STATIC_PORT}`}`;
const PUBLIC_BASE_URL = parseStringEnv(
    'PUBLIC_BASE_URL',
    parseStringEnv('BASE_URL', DEFAULT_PUBLIC_BASE_URL)
).replace(/\/+$/, '');
const PASSWORD_RESET_URL = parseStringEnv('PASSWORD_RESET_URL', `${PUBLIC_BASE_URL}/lostpw`);
const DISCORD_CLIENT_ID = parseStringEnv(
    'DISCORD_CLIENT_ID',
    parseStringEnv('DISCORD_APPLICATION_ID', parseStringEnv('DISCORD_SOCIAL_APP_ID', ''))
);
const DISCORD_CLIENT_SECRET = parseStringEnv('DISCORD_CLIENT_SECRET', '');
const DISCORD_REDIRECT_URI = parseStringEnv('DISCORD_REDIRECT_URI', `${PUBLIC_BASE_URL}/auth/discord/callback`);
const DISCORD_LINKED_ROLES_CONNECT_URL = parseStringEnv(
    'DISCORD_LINKED_ROLES_CONNECT_URL',
    'https://discord-github-assistant-bot.vercel.app/api/discord-linked-roles/connect'
);
// GAME_MONGODB_* is shared with the Discord account service. MONGO_DB_NAME is
// deliberately excluded because legacy deployments use it for sponsor data.
const MONGODB_URI = parseStringEnv('GAME_MONGODB_URI', parseStringEnv('MONGODB_URI', ''));
const MONGODB_DB_NAME = parseStringEnv(
    'GAME_MONGODB_DB_NAME',
    parseStringEnv('MONGODB_DB_NAME', 'minidb')
);
const SPONSOR_MONGODB_URI = parseStringEnv('SPONSOR_MONGODB_URI', MONGODB_URI);
const SPONSOR_MONGODB_DB_NAME = parseStringEnv('SPONSOR_MONGODB_DB_NAME', MONGODB_DB_NAME);
const SPONSOR_MONGODB_COLLECTION = parseStringEnv('SPONSOR_MONGODB_COLLECTION', 'minidb');
const SPONSOR_DISCORD_ID_FIELDS = parseStringEnv(
    'SPONSOR_DISCORD_ID_FIELDS',
    'discordId,discordUserId,discord.id,user.discordId'
);
const SPONSOR_STATUS_FIELD = parseStringEnv('SPONSOR_STATUS_FIELD', 'isSponsor');
const SPONSOR_ACCOUNT_CREATION_REQUIRED = parseBooleanEnv('SPONSOR_ACCOUNT_CREATION_REQUIRED', true);
const BIND_HOST = MULTIPLAYER_MODE ? '0.0.0.0' : '127.0.0.1';
const ALLOW_DEV_PASSWORD_RESET_REQUESTED = parseBooleanEnv('ALLOW_DEV_PASSWORD_RESET', false);
const ALLOW_DEV_PASSWORD_RESET = resolveDevPasswordResetEnabled(
    MULTIPLAYER_MODE,
    BIND_HOST,
    ALLOW_DEV_PASSWORD_RESET_REQUESTED
);
const TRUST_PROXY_HEADERS = parseBooleanEnv('TRUST_PROXY_HEADERS', false);
const TRUSTED_PROXY_ADDRESSES = parseCsvEnv('TRUSTED_PROXY_ADDRESSES', ['loopback']);
const MAX_GAME_CONNECTIONS = parseBoundedNumberEnv('MAX_GAME_CONNECTIONS', MULTIPLAYER_MODE ? 500 : 64, 1, 10_000);
const MAX_GAME_CONNECTIONS_PER_IP = parseBoundedNumberEnv(
    'MAX_GAME_CONNECTIONS_PER_IP',
    MULTIPLAYER_MODE ? 20 : 8,
    1,
    MAX_GAME_CONNECTIONS
);
const GAME_AUTH_TIMEOUT_MS = parseBoundedNumberEnv('GAME_AUTH_TIMEOUT_MS', 30_000, 1_000, 10 * 60_000);
const GAME_SOCKET_IDLE_TIMEOUT_MS = parseBoundedNumberEnv(
    'GAME_SOCKET_IDLE_TIMEOUT_MS',
    10 * 60_000,
    10_000,
    24 * 60 * 60_000
);
const SHUTDOWN_GRACE_MS = parseBoundedNumberEnv('SHUTDOWN_GRACE_MS', 5_000, 10, 60_000);
const SHUTDOWN_TIMEOUT_MS = parseBoundedNumberEnv(
    'SHUTDOWN_TIMEOUT_MS',
    SHUTDOWN_GRACE_MS + 5_000,
    SHUTDOWN_GRACE_MS,
    120_000
);
const SOCKET_POLICY_DOMAINS = Array.from(new Set(
    parseCsvEnv('SOCKET_POLICY_DOMAINS', [MULTIPLAYER_MODE ? MULTIPLAYER_HOST : LOCAL_HOST])
        .filter((domain) => domain !== '*')
        .map((domain) => normalizeHostValue(domain, ''))
        .filter(Boolean)
));

if (TRUST_PROXY_HEADERS && TRUSTED_PROXY_ADDRESSES.length === 0) {
    throw new Error('TRUST_PROXY_HEADERS requires at least one TRUSTED_PROXY_ADDRESSES entry.');
}

export const Config = {
    MULTIPLAYER_MODE,
    LOCAL_HOST,
    MULTIPLAYER_HOST,
    HOST: MULTIPLAYER_MODE ? MULTIPLAYER_HOST : LOCAL_HOST,
    BIND_HOST,
    STATIC_PORT: parseNumberEnv('STATIC_PORT', DEFAULT_STATIC_PORT),
    PORTS: [parseNumberEnv('GAME_PORT', DEFAULT_GAME_PORT)],
    POLICY_PORT: parseNumberEnv('POLICY_PORT', DEFAULT_POLICY_PORT),
    ENABLE_POLICY_SERVER: parseBooleanEnv('ENABLE_POLICY_SERVER', MULTIPLAYER_MODE),
    MAX_GAME_CONNECTIONS,
    MAX_GAME_CONNECTIONS_PER_IP,
    GAME_AUTH_TIMEOUT_MS,
    GAME_SOCKET_IDLE_TIMEOUT_MS,
    SHUTDOWN_GRACE_MS,
    SHUTDOWN_TIMEOUT_MS,
    SOCKET_POLICY_DOMAINS,
    MONGODB_URI,
    MONGODB_DB_NAME,
    MONGODB_ACCOUNTS_COLLECTION: parseStringEnv('MONGODB_ACCOUNTS_COLLECTION', 'accounts'),
    MONGODB_SAVES_COLLECTION: parseStringEnv('MONGODB_SAVES_COLLECTION', 'saves'),
    MONGODB_COUNTERS_COLLECTION: parseStringEnv('MONGODB_COUNTERS_COLLECTION', 'counters'),
    MONGODB_GEAR_COLLECTION: parseStringEnv('MONGODB_GEAR_COLLECTION', 'gear_catalog'),
    ENABLE_MONGO_GAME_DATA: parseBooleanEnv('ENABLE_MONGO_GAME_DATA', Boolean(MONGODB_URI)),
    SECRET: resolveRuntimeKeyHex(),
    DATA_DIR: resolveServerDataDir(),
    PUBLIC_BASE_URL,
    PASSWORD_RESET_URL,
    ALLOW_DEV_PASSWORD_RESET,
    TRUST_PROXY_HEADERS,
    TRUSTED_PROXY_ADDRESSES,
    DISCORD_CLIENT_ID,
    DISCORD_CLIENT_SECRET,
    DISCORD_REDIRECT_URI,
    DISCORD_LINKED_ROLES_CONNECT_URL,
    DISCORD_OAUTH_CONFIGURED: Boolean(DISCORD_CLIENT_ID && DISCORD_CLIENT_SECRET && DISCORD_REDIRECT_URI),
    SPONSOR_MONGODB_URI,
    SPONSOR_MONGODB_DB_NAME,
    SPONSOR_MONGODB_COLLECTION,
    SPONSOR_DISCORD_ID_FIELDS,
    SPONSOR_STATUS_FIELD,
    SPONSOR_ACCOUNT_CREATION_REQUIRED
};
