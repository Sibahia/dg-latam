const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The client-side fixes in scripts/ are byte patches against DungeonBlitz.swf, Game.swz and the
// Levels*.swz files. Nothing re-applies them automatically, so committing a rebuilt SWF silently
// throws them away -- that is how the forge charm durations, the forge tutorial persistence and
// the home timer reductions each came back as "new" bugs.
//
// Every patch script that supports --verify is a self-check for exactly that. Run them all before
// the build so a dropped patch fails loudly here instead of shipping to players.
const scriptsDir = path.resolve(__dirname, '..', 'scripts');
const serverDir = path.resolve(__dirname, '..');
// Deploys run this on the live box while players are connected, so leave a core for the game
// server rather than saturating every one of them for the ~2 minutes the sweep takes.
const concurrency = Math.max(1, Math.min(8, os.cpus().length - 1));
const requireFfdec = process.env.REQUIRE_FFDEC === '1';

function loadSupersededScripts() {
    const ledger = JSON.parse(fs.readFileSync(path.join(__dirname, 'client-patch-baseline.json'), 'utf8'));
    const replacements = Object.values(ledger.superseded ?? {});
    for (const replacement of replacements) {
        if (typeof replacement !== 'string' || !fs.existsSync(path.join(scriptsDir, replacement))) {
            throw new Error(`Superseded client patch references missing replacement ${String(replacement)}.`);
        }
    }
    return new Set(Object.keys(ledger.superseded ?? {}));
}

function discoverVerifiableScripts() {
    const superseded = loadSupersededScripts();
    return fs
        .readdirSync(scriptsDir)
        .filter((name) => /^patch.*\.(ts|js)$/.test(name))
        .filter((name) => !superseded.has(name))
        .filter((name) => {
            try {
                return fs.readFileSync(path.join(scriptsDir, name), 'utf8').includes('--verify');
            } catch {
                return false;
            }
        })
        .sort();
}

function runVerify(name) {
    const isTypeScript = name.endsWith('.ts');
    const command = isTypeScript ? 'npx' : process.execPath;
    const args = isTypeScript
        ? ['ts-node', path.join('scripts', name), '--verify']
        : [path.join('scripts', name), '--verify'];

    return new Promise((resolve) => {
        execFile(command, args, { cwd: serverDir, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
            const output = `${stdout ?? ''}${stderr ?? ''}`.trim();
            // Some verifiers shell out to FFDec to disassemble Levels*.swz. A missing FFDec means
            // the check could not run at all, which is not the same as the patch being gone --
            // report it separately rather than failing a build over a missing local tool.
            const unavailable = Boolean(error) &&
                /FFDec (?:CLI )?not found|Pass --ffdec|install JPEXS FFDec/i.test(output);
            resolve({
                name,
                ok: !error,
                skipped: unavailable,
                output
            });
        });
    });
}

async function runAll(names) {
    const results = [];
    let cursor = 0;

    async function worker() {
        while (cursor < names.length) {
            const name = names[cursor];
            cursor += 1;
            results.push(await runVerify(name));
        }
    }

    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    return results;
}

async function main() {
    const names = discoverVerifiableScripts();
    if (names.length === 0) {
        console.error('[verify-patches] No verifiable patch scripts found -- expected scripts/patch*.{ts,js}');
        process.exitCode = 1;
        return;
    }

    console.log(`[verify-patches] Checking ${names.length} client patches (concurrency ${concurrency})...`);
    const results = await runAll(names);

    // Under concurrency JPEXS' decompiler worker can time out (it drops a com.jpexs stack trace and
    // a truncated .as export), which makes a patch that is actually present verify as missing.
    // Re-check anything we are about to call lost one at a time before believing it: a starved
    // decompiler passes on the second look, a real loss still fails.
    const suspects = results.filter((result) => !result.ok && !result.skipped);
    if (suspects.length > 0) {
        console.warn(`[verify-patches] ${suspects.length} patch(es) failed; re-checking them serially...`);
        for (const suspect of suspects) {
            results[results.indexOf(suspect)] = await runVerify(suspect.name);
        }
    }

    const failures = results.filter((result) => !result.ok && !result.skipped);
    const skipped = results.filter((result) => result.skipped);

    if (skipped.length > 0) {
        const log = requireFfdec ? console.error : console.warn;
        log(
            `[verify-patches] ${skipped.length} patch(es) could not be checked (FFDec unavailable): ` +
            skipped.map((entry) => entry.name).sort().join(', ')
        );
    }

    const regressions = [...failures, ...(requireFfdec ? skipped : [])];

    if (regressions.length === 0) {
        const checked = results.length - skipped.length;
        console.log(
            `[verify-patches] ${checked}/${checked} checkable patches present. No losses.`
        );
        return;
    }

    if (regressions.length > 0) {
        console.error(`[verify-patches] ${regressions.length} client patch(es) are missing from the served assets:`);
        for (const failure of regressions.sort((left, right) => left.name.localeCompare(right.name))) {
            console.error(`\n  ---- ${failure.name} ----`);
            console.error(failure.output.split('\n').slice(-12).map((line) => `  ${line}`).join('\n'));
        }
        console.error(
            '\n[verify-patches] A rebuilt SWF most likely dropped these. Re-run the listed script(s)\n' +
            '[verify-patches] without --verify to re-apply, then commit the patched asset.'
        );
    }

    process.exitCode = 1;
}

main().catch((error) => {
    console.error('[verify-patches] Runner failed:', error);
    process.exitCode = 1;
});
