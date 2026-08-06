import './helpers/disable_production_mongo';
import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { StaticServer } from '../core/StaticServer';

function contentDir(): string {
    return path.resolve(__dirname, '../../client/content/localhost');
}

function waitForListening(server: StaticServer): Promise<number> {
    const httpServer = (server as any).server;
    if (httpServer.listening) {
        const address = httpServer.address();
        assert.equal(typeof address, 'object');
        return Promise.resolve(Number(address.port));
    }
    return new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.once('listening', () => {
            const address = httpServer.address();
            assert.equal(typeof address, 'object');
            resolve(Number(address.port));
        });
    });
}

async function testCalculadoraRedirectsToTrailingSlash(): Promise<void> {
    const server = new StaticServer(0);
    server.start();
    try {
        const port = await waitForListening(server);
        const baseUrl = `http://127.0.0.1:${port}`;

        // Relative asset URLs (data/, images/, js/) resolve against the page URL,
        // so /calculadora must redirect to /calculadora/ for the fetchs to work.
        const res = await fetch(`${baseUrl}/calculadora`, { redirect: 'manual' });
        assert.equal(res.status, 301, '/calculadora should 301 to /calculadora/');
        assert.equal(res.headers.get('location'), '/calculadora/', 'redirect target should keep assets under the subpath');

        const page = await fetch(`${baseUrl}/calculadora/`);
        assert.equal(page.status, 200, '/calculadora/ should serve the calculator');
        const html = await page.text();
        assert.ok(html.includes('Dungeon Blitz Talent Calculator'), 'page title should render');
        assert.ok(html.includes('talentcalc.js'), 'calculator script should be referenced');
        assert.ok(html.includes('style.css'), 'calculator stylesheet should be referenced');
    } finally {
        await server.stop();
    }
}

async function testCalculadoraAssetsResolve(): Promise<void> {
    const server = new StaticServer(0);
    server.start();
    try {
        const port = await waitForListening(server);
        const baseUrl = `http://127.0.0.1:${port}`;
        const calcDir = path.join(contentDir(), 'calculadora');

        const slugs = fs.readdirSync(path.join(calcDir, 'data'))
            .filter((f) => f.endsWith('.json'))
            .map((f) => f.replace(/\.json$/, ''));
        assert.ok(slugs.includes('tree'), 'tree.json should exist');
        assert.equal(slugs.length, 10, 'expected tree.json plus 9 discipline jsons');

        const missing: string[] = [];
        const check = async (url: string) => {
            const res = await fetch(`${baseUrl}/calculadora/${url}`, { redirect: 'follow' });
            if (res.status !== 200) missing.push(url);
        };

        for (const slug of slugs) await check(`data/${slug}.json`);
        await check('style.css');
        await check('talentcalc.js');

        // Every image the stylesheet references must resolve through the server.
        const css = fs.readFileSync(path.join(calcDir, 'style.css'), 'utf8');
        const urls = css.match(/url\(([^)]+)\)/g) ?? [];
        for (const u of urls) {
            const rel = u.match(/url\((.+)\)/)![1].trim();
            if (rel.startsWith('http')) continue;
            await check(rel);
        }

        // Every icon referenced by the data must exist on disk so the client never 404s.
        const iconMissing: string[] = [];
        for (const slug of slugs) {
            if (slug === 'tree') continue;
            const data = JSON.parse(fs.readFileSync(path.join(calcDir, 'data', `${slug}.json`), 'utf8'));
            for (const t of data.talents || []) if (t.icon && !fs.existsSync(path.join(calcDir, 'icons', `${t.icon}.png`))) iconMissing.push(`icons/${t.icon}.png`);
            for (const s of data.stats || []) if (s.icon && !fs.existsSync(path.join(calcDir, 'icons', `${s.icon}.png`))) iconMissing.push(`icons/${s.icon}.png`);
        }
        assert.deepEqual(iconMissing, [], 'every icon referenced by calculator data should exist');

        assert.deepEqual(missing, [], 'every calculator asset should resolve');
    } finally {
        await server.stop();
    }
}

async function main(): Promise<void> {
    await testCalculadoraRedirectsToTrailingSlash();
    await testCalculadoraAssetsResolve();
    console.log('calculadora_regression passed');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
