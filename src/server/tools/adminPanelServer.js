const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { MongoClient } = require('mongodb');

function readArg(name, fallback) {
    const index = process.argv.indexOf(name);
    return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const panelHost = readArg('--host', process.env.ADMIN_PANEL_HOST || '127.0.0.1');
const panelPort = Math.max(1, Number(readArg('--port', process.env.ADMIN_PANEL_PORT || 8787)) || 8787);
const targetBase = new URL(readArg('--server', process.env.ADMIN_SERVER_URL || process.env.PUBLIC_BASE_URL || 'http://localhost:8000'));
const secret = String(readArg('--secret', process.env.ADMIN_API_SECRET || process.env.DISCORD_MAINTENANCE_API_SECRET || '')).trim();
const webDir = path.resolve(__dirname, 'admin-panel');

const jwtSecret = String(process.env.ADMIN_JWT_SECRET || '').trim();
const mongoUri = String(process.env.GAME_MONGODB_URI || process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017').trim();
const mongoDbName = String(process.env.GAME_MONGODB_DB_NAME || 'dungeonblitz').trim();
const cookieSecure = String(process.env.ADMIN_COOKIE_SECURE ?? '1').trim() !== '0';

function parseDuration(value, fallbackMs) {
    const text = String(value ?? '').trim().toLowerCase();
    const match = text.match(/^(\d+)(ms|s|m|h|d)?$/);
    if (!match) return fallbackMs;
    const unit = match[2] || 'ms';
    const multipliers = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 };
    return Number(match[1]) * (multipliers[unit] || 1);
}
const accessTokenTtlMs = parseDuration(process.env.ADMIN_ACCESS_TTL, 4 * 3600000); // 4h
const refreshTokenTtlMs = parseDuration(process.env.ADMIN_REFRESH_TTL, 7 * 86400000); // 7d

if (!secret) {
    console.error('[AdminPanel] ADMIN_API_SECRET or DISCORD_MAINTENANCE_API_SECRET is required.');
    process.exit(1);
}
if (!jwtSecret) {
    console.error('[AdminPanel] ADMIN_JWT_SECRET is required.');
    process.exit(1);
}

const contentTypes = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.svg': 'image/svg+xml'
};

let mongoClient = null;
async function getDb() {
    if (!mongoClient) {
        mongoClient = new MongoClient(mongoUri, { ignoreUndefined: true });
        await mongoClient.connect();
    }
    return mongoClient.db(mongoDbName);
}

function sha256(value) {
    return crypto.createHash('sha256').update(String(value)).digest('hex');
}

// Simple in-memory login rate limiter (20 attempts / 15 minutes per IP).
const loginAttempts = new Map();
function consumeLoginAttempt(ip) {
    const now = Date.now();
    const windowMs = 15 * 60000;
    const entry = loginAttempts.get(ip) || { count: 0, first: now };
    if (now - entry.first > windowMs) {
        entry.count = 0;
        entry.first = now;
    }
    entry.count += 1;
    loginAttempts.set(ip, entry);
    return entry.count > 20;
}

function refreshCookieHeader(token) {
    const secure = cookieSecure ? '; Secure' : '';
    return `admin_refresh=${token}; HttpOnly; SameSite=Strict; Path=/${secure}; Max-Age=${Math.floor(refreshTokenTtlMs / 1000)}`;
}

function readCookie(req, name) {
    const header = String(req.headers.cookie || '');
    const match = header.match(new RegExp('(?:^|;)\\s*' + name + '=([^;]*)'));
    return match ? decodeURIComponent(match[1].trim()) : '';
}

async function isAuthenticated(req) {
    const authorization = String(req.headers.authorization || '');
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
    if (token) {
        try {
            jwt.verify(token, jwtSecret);
            return true;
        } catch (_error) {
            // Fall through to the refresh cookie below.
        }
    }

    // Page navigations carry no Authorization header, so a valid refresh cookie also counts.
    const refreshToken = readCookie(req, 'admin_refresh');
    if (!refreshToken) {
        return false;
    }
    try {
        const db = await getDb();
        const session = await db.collection('admin_sessions').findOne({ tokenHash: sha256(refreshToken) });
        return Boolean(session && !session.revokedAt && session.expiresAt > new Date());
    } catch (_error) {
        return false;
    }
}

function signAccessToken(username) {
    return jwt.sign({ sub: username, role: 'admin' }, jwtSecret, {
        expiresIn: Math.floor(accessTokenTtlMs / 1000)
    });
}

async function createRefreshSession(username) {
    const db = await getDb();
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + refreshTokenTtlMs);
    await db.collection('admin_sessions').insertOne({
        tokenHash: sha256(token),
        username,
        expiresAt,
        createdAt: new Date(),
        revokedAt: null
    });
    return { token, expiresAt, username };
}

async function rotateRefreshSession(refreshToken) {
    const db = await getDb();
    const tokenHash = sha256(refreshToken);
    const session = await db.collection('admin_sessions').findOne({ tokenHash });
    if (!session || session.revokedAt || session.expiresAt <= new Date()) {
        return null;
    }
    await db.collection('admin_sessions').updateOne({ tokenHash }, { $set: { revokedAt: new Date() } });
    return createRefreshSession(session.username);
}

async function revokeRefreshSession(refreshToken) {
    if (!refreshToken) {
        return;
    }
    try {
        const db = await getDb();
        await db.collection('admin_sessions').updateOne(
            { tokenHash: sha256(refreshToken), revokedAt: null },
            { $set: { revokedAt: new Date() } }
        );
    } catch (_error) {
        // Logout must never fail the response.
    }
}

async function handleLogin(req, res) {
    const ip = String(req.socket.remoteAddress || 'unknown').replace(/^::ffff:/, '');
    if (consumeLoginAttempt(ip)) {
        res.writeHead(429, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Demasiados intentos. Espera unos minutos.' }));
        return;
    }

    let body = '';
    for await (const chunk of req) {
        body += chunk;
    }
    let payload = {};
    try {
        payload = JSON.parse(body || '{}');
    } catch (_error) {
        // invalid json -> invalid credentials path below
    }
    const username = String(payload.username || '').trim();
    const password = String(payload.password || '');
    if (!username || !password) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Usuario y contraseña requeridos.' }));
        return;
    }

    try {
        const db = await getDb();
        const user = await db.collection('admin_users').findOne({ username });
        const valid = Boolean(user) && await bcrypt.compare(password, user.passwordHash);
        if (!valid) {
            res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'Credenciales inválidas.' }));
            return;
        }

        const accessToken = signAccessToken(username);
        const session = await createRefreshSession(username);
        res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
            'set-cookie': refreshCookieHeader(session.token)
        });
        res.end(JSON.stringify({ accessToken, expiresIn: Math.floor(accessTokenTtlMs / 1000) }));
    } catch (error) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Error interno: ' + error.message }));
    }
}

async function handleRefresh(req, res) {
    const refreshToken = readCookie(req, 'admin_refresh');
    if (!refreshToken) {
        res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'No hay sesión activa.' }));
        return;
    }

    try {
        const session = await rotateRefreshSession(refreshToken);
        if (!session) {
            res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'Sesión expirada o revocada.' }));
            return;
        }
        const accessToken = signAccessToken(session.username);
        res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
            'set-cookie': refreshCookieHeader(session.token)
        });
        res.end(JSON.stringify({ accessToken, expiresIn: Math.floor(accessTokenTtlMs / 1000) }));
    } catch (error) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Error interno: ' + error.message }));
    }
}

async function handleLogout(req, res) {
    const refreshToken = readCookie(req, 'admin_refresh');
    await revokeRefreshSession(refreshToken);
    const secure = cookieSecure ? '; Secure' : '';
    res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'set-cookie': `admin_refresh=; HttpOnly; SameSite=Strict; Path=/${secure}; Max-Age=0`
    });
    res.end(JSON.stringify({ ok: true }));
}

function sanitizeApiSuffix(pathname) {
    const rawSuffix = pathname.slice(5);
    let decodedSuffix;
    try {
        decodedSuffix = decodeURIComponent(rawSuffix);
    } catch (_error) {
        return null;
    }

    if (!decodedSuffix || /(^|\/)\.\.?(\/|$)/.test(decodedSuffix) || decodedSuffix.includes('\\') || /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(decodedSuffix) || decodedSuffix.startsWith('/') || /[\r\n\0]/.test(decodedSuffix)) {
        return null;
    }

    return decodedSuffix
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/');
}

function targetRequest(req, res, targetPath, stream = false) {
    const transport = targetBase.protocol === 'https:' ? https : http;
    const headers = {
        authorization: `Bearer ${secret}`,
        accept: stream ? 'text/event-stream' : 'application/json'
    };
    if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];
    const upstream = transport.request(new URL(targetPath, targetBase), {
        method: req.method,
        headers
    }, (upstreamResponse) => {
        res.writeHead(upstreamResponse.statusCode || 502, {
            'content-type': upstreamResponse.headers['content-type'] || 'application/json',
            'cache-control': 'no-store',
            connection: stream ? 'keep-alive' : 'close'
        });
        upstreamResponse.pipe(res);
    });
    upstream.on('error', (error) => {
        if (!res.headersSent) {
            res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
        }
        res.end(JSON.stringify({ error: `Active server is unreachable: ${error.message}` }));
    });
    if (stream) {
        res.on('close', () => upstream.destroy());
    }
    if (req.method === 'GET' || req.method === 'HEAD') upstream.end();
    else req.pipe(upstream);
}

function serveFile(res, name) {
    const filePath = path.resolve(webDir, name);
    if (!filePath.startsWith(`${webDir}${path.sep}`) && filePath !== path.join(webDir, 'index.html')) {
        res.writeHead(403).end('Forbidden');
        return;
    }
    fs.readFile(filePath, (error, contents) => {
        if (error) {
            res.writeHead(404).end('Not found');
            return;
        }
        res.writeHead(200, {
            'content-type': contentTypes[path.extname(filePath)] || 'application/octet-stream',
            'cache-control': 'no-store'
        });
        res.end(contents);
    });
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${panelHost}:${panelPort}`);

    if (url.pathname === '/api/admin/login') {
        await handleLogin(req, res);
        return;
    }
    if (url.pathname === '/api/admin/refresh') {
        await handleRefresh(req, res);
        return;
    }
    if (url.pathname === '/api/admin/logout') {
        await handleLogout(req, res);
        return;
    }

    if (url.pathname === '/events' || url.pathname.startsWith('/api/')) {
        if (!(await isAuthenticated(req))) {
            res.writeHead(401, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
            res.end(JSON.stringify({ error: 'Unauthorized.' }));
            return;
        }
        if (url.pathname === '/events') {
            targetRequest(req, res, '/api/admin/control/events', true);
            return;
        }
        const sanitizedSuffix = sanitizeApiSuffix(url.pathname);
        if (!sanitizedSuffix) {
            res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'Invalid API path.' }));
            return;
        }
        targetRequest(req, res, `/api/admin/control/${sanitizedSuffix}${url.search}`);
        return;
    }

    // Static assets (css/js/svg) are fetched by the browser's <link>/<script> tags, which carry
    // neither the Authorization header nor the refresh cookie, so they are served regardless of
    // auth. Only the HTML pages are gated.
    const requested = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const ext = path.extname(requested);
    if (ext && ext !== '.html') {
        serveFile(res, requested);
        return;
    }
    if (!(await isAuthenticated(req))) {
        serveFile(res, 'login.html');
        return;
    }
    serveFile(res, requested);
});

server.listen(panelPort, panelHost, () => {
    const panelUrl = `http://${panelHost}:${panelPort}`;
    console.log(`[AdminPanel] ${panelUrl}`);
    console.log(`[AdminPanel] Active server: ${targetBase.origin}`);
    console.log(`[AdminPanel] Mongo: ${mongoUri}/${mongoDbName} | access TTL ${Math.floor(accessTokenTtlMs / 1000)}s | refresh TTL ${Math.floor(refreshTokenTtlMs / 1000)}s | cookie Secure=${cookieSecure}`);
    if (!process.argv.includes('--no-open')) {
        const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
        const args = process.platform === 'win32' ? ['/c', 'start', '', panelUrl] : [panelUrl];
        spawn(command, args, { detached: true, stdio: 'ignore' }).unref();
    }
});

function shutdown() {
    server.close(() => process.exit(0));
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
