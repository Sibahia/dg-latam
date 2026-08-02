#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const TARGET_SWFS = [
    path.join('src', 'client', 'content', 'localhost', 'p', 'cbp', 'DungeonBlitz.swf')
];

function parseArgs(argv) {
    const args = { ffdec: '', verify: false, swfs: [] };
    for (let index = 2; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === '--ffdec' || arg === '-f') {
            args.ffdec = argv[++index] || '';
        } else if (arg === '--swf' || arg === '-s') {
            args.swfs.push(argv[++index] || '');
        } else if (arg === '--verify') {
            args.verify = true;
        } else if (arg === '--help' || arg === '-h') {
            console.log([
                'Usage:',
                '  node src/server/scripts/patch-dungeonblitz-character-select-reset.js [--verify] [--swf <path>] [--ffdec <path>]',
                '',
                'Patches DungeonBlitz.swf so a refreshed character list clears the',
                'character-select pending Enter Game state after an account-open popup.'
            ].join('\n'));
            process.exit(0);
        } else {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }
    return args;
}

function resolveRepoRoot() {
    return path.resolve(__dirname, '..', '..', '..');
}

function resolvePath(repoRoot, value) {
    if (!value) return '';
    return path.isAbsolute(value) ? value : path.join(repoRoot, value);
}

function detectFfdec(repoRoot, preferred) {
    const candidates = [];
    if (preferred) {
        candidates.push(resolvePath(repoRoot, preferred));
    }
    candidates.push(
        path.join(repoRoot, 'build', 'ffdec', 'ffdec.jar'),
        path.join(repoRoot, 'build', 'ffdec', 'ffdec-cli.jar'),
        path.join(repoRoot, 'build', 'tools', 'ffdec_25.1.3', 'ffdec.jar'),
        path.join(repoRoot, 'build', 'tools', 'ffdec_25.1.3', 'ffdec-cli.jar'),
        path.join(process.env['ProgramFiles(x86)'] || '', 'FFDec', 'ffdec-cli.jar'),
        path.join(process.env['ProgramFiles(x86)'] || '', 'FFDec', 'ffdec.jar'),
        path.join(process.env.ProgramFiles || '', 'FFDec', 'ffdec-cli.jar'),
        path.join(process.env.ProgramFiles || '', 'FFDec', 'ffdec.jar')
    );
    return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || '';
}

function ensureFfdecHome(repoRoot) {
    const ffdecHome = path.join(repoRoot, 'build', 'ffdec-home');
    fs.mkdirSync(path.join(ffdecHome, 'JPEXS', 'FFDec', 'logs'), { recursive: true });
    fs.mkdirSync(path.join(ffdecHome, 'LocalAppData'), { recursive: true });
    fs.mkdirSync(path.join(ffdecHome, 'Library', 'Application Support', 'FFDec', 'logs'), { recursive: true });
    return ffdecHome;
}

function runFfdec(ffdecPath, args) {
    const repoRoot = resolveRepoRoot();
    const ffdecHome = ensureFfdecHome(repoRoot);
    const env = {
        ...process.env,
        APPDATA: ffdecHome,
        HOME: ffdecHome,
        LOCALAPPDATA: path.join(ffdecHome, 'LocalAppData'),
        USERPROFILE: ffdecHome
    };
    const resolved = path.resolve(ffdecPath);
    const basename = path.basename(resolved).toLowerCase();
    if (basename.endsWith('.jar')) {
        execFileSync('java', [`-Duser.home=${ffdecHome}`, '-jar', resolved, '-cli', ...args], { env, stdio: 'inherit' });
    } else {
        execFileSync(resolved, ['-cli', ...args], { env, stdio: 'inherit' });
    }
}

function exportLinkUpdater(ffdecPath, workRoot, swfPath) {
    fs.rmSync(workRoot, { recursive: true, force: true });
    fs.mkdirSync(workRoot, { recursive: true });
    runFfdec(ffdecPath, ['-selectclass', 'LinkUpdater', '-export', 'script', workRoot, swfPath]);
    const linkUpdaterPath = path.join(workRoot, 'scripts', 'LinkUpdater.as');
    if (!fs.existsSync(linkUpdaterPath)) {
        throw new Error(`FFDec export did not produce ${linkUpdaterPath}`);
    }
    return linkUpdaterPath;
}

function patchLinkUpdater(source) {
    const eol = source.includes('\r\n') ? '\r\n' : '\n';
    const join = (lines) => lines.join(eol);
    let patchedSource = source;
    const original = join([
        '         this.var_1.clientUserID = _loc2_;',
        '         this.var_1.loginMaxChars = _loc3_;',
        '         this.var_1.var_355 = _loc5_;'
    ]);
    const patched = join([
        '         this.var_1.clientUserID = _loc2_;',
        '         this.var_1.loginMaxChars = _loc3_;',
        '         this.var_1.var_355 = _loc5_;',
        '         this.var_1.var_1125 = null;',
        '         this.var_1.var_2056 = false;',
        '         this.var_1.var_2138 = false;',
        '         this.var_1.var_612 = false;',
        '         this.var_1.var_1198 = false;',
        '         if(Boolean(this.var_1.var_341) && this.var_1.var_341.method_40())',
        '         {',
        '            this.var_1.var_341.method_1875(_loc5_);',
        '         }'
    ]);
    if (!patchedSource.includes('this.var_1.var_341.method_1875(_loc5_);')) {
        if (!patchedSource.includes(original)) {
            throw new Error('Could not find LinkUpdater.method_1772 character-list assignment block.');
        }
        patchedSource = patchedSource.replace(original, patched);
    }

    const popupOriginal = join([
        '         if(_loc2_ == "Account created, but your character name is taken. Please choose a new name." || _loc2_ == "Character name is unavailable. Please choose a new name.")',
        '         {',
        '            this.var_1.var_141.method_1848();',
        '         }',
        '         this.var_1.var_94.method_71(_loc2_,true);'
    ]);
    const popupPatched = join([
        '         if(_loc2_ == "Account created, but your character name is taken. Please choose a new name." || _loc2_ == "Character name is unavailable. Please choose a new name.")',
        '         {',
        '            this.var_1.var_141.method_1848();',
        '         }',
        '         if(_loc2_ == "You already have an account open with this email address.")',
        '         {',
        '            this.var_1.var_1125 = null;',
        '            this.var_1.var_2056 = false;',
        '            this.var_1.var_2138 = false;',
        '            this.var_1.var_612 = false;',
        '            this.var_1.var_1198 = false;',
        '         }',
        '         this.var_1.var_94.method_71(_loc2_,true);'
    ]);
    if (!patchedSource.includes('if(_loc2_ == "You already have an account open with this email address.")')) {
        if (!patchedSource.includes(popupOriginal)) {
            throw new Error('Could not find LinkUpdater.method_1419 login-failure popup block.');
        }
        patchedSource = patchedSource.replace(popupOriginal, popupPatched);
    }

    return patchedSource;
}

function verifyLinkUpdater(source, swfPath) {
    const normalized = source.replace(/\r\n/g, '\n');
    const required = [
        'this.var_1.var_1125 = null;',
        'this.var_1.var_2056 = false;',
        'this.var_1.var_2138 = false;',
        'this.var_1.var_612 = false;',
        'this.var_1.var_1198 = false;',
        'this.var_1.var_341.method_1875(_loc5_);',
        'if(_loc2_ == "You already have an account open with this email address.")'
    ];
    for (const snippet of required) {
        if (!normalized.includes(snippet)) {
            throw new Error(`${path.basename(swfPath)} is missing character-select reset snippet: ${snippet}`);
        }
    }
    const popupResetIndex = normalized.indexOf('if(_loc2_ == "You already have an account open with this email address.")');
    const popupDisplayIndex = normalized.indexOf('this.var_1.var_94.method_71(_loc2_,true);', popupResetIndex);
    if (popupResetIndex < 0 || popupDisplayIndex < 0 || popupDisplayIndex < popupResetIndex) {
        throw new Error(`${path.basename(swfPath)} popup reset must run before displaying the login failure popup.`);
    }
}

function patchSwf(repoRoot, ffdecPath, swfPath) {
    const workRoot = path.join(repoRoot, 'build', 'ffdec-dungeonblitz-character-select-reset', path.basename(swfPath, path.extname(swfPath)));
    const linkUpdaterPath = exportLinkUpdater(ffdecPath, workRoot, swfPath);
    const original = fs.readFileSync(linkUpdaterPath, 'utf8');
    const patched = patchLinkUpdater(original);
    if (patched === original) {
        verifyLinkUpdater(original, swfPath);
        return;
    }
    fs.writeFileSync(linkUpdaterPath, patched, 'utf8');
    const patchedSwfPath = path.join(workRoot, path.basename(swfPath));
    runFfdec(ffdecPath, ['-importScript', swfPath, patchedSwfPath, path.dirname(linkUpdaterPath)]);
    fs.copyFileSync(patchedSwfPath, swfPath);
}

function verifySwf(repoRoot, ffdecPath, swfPath) {
    const workRoot = path.join(repoRoot, 'build', 'ffdec-dungeonblitz-character-select-reset-verify', path.basename(swfPath, path.extname(swfPath)));
    const linkUpdaterPath = exportLinkUpdater(ffdecPath, workRoot, swfPath);
    verifyLinkUpdater(fs.readFileSync(linkUpdaterPath, 'utf8'), swfPath);
}

function main() {
    const args = parseArgs(process.argv);
    const repoRoot = resolveRepoRoot();
    const ffdecPath = detectFfdec(repoRoot, args.ffdec);
    if (!ffdecPath) {
        throw new Error('FFDec not found. Pass --ffdec or install JPEXS FFDec.');
    }
    const targets = (args.swfs.length ? args.swfs : TARGET_SWFS).map((swfPath) => resolvePath(repoRoot, swfPath));
    for (const swfPath of targets) {
        if (!fs.existsSync(swfPath)) {
            throw new Error(`SWF not found: ${swfPath}`);
        }
        if (args.verify) {
            verifySwf(repoRoot, ffdecPath, swfPath);
            console.log(`[patch-dungeonblitz-character-select-reset] Verified ${swfPath}`);
        } else {
            patchSwf(repoRoot, ffdecPath, swfPath);
            verifySwf(repoRoot, ffdecPath, swfPath);
            console.log(`[patch-dungeonblitz-character-select-reset] Patched ${swfPath}`);
        }
    }
}

try {
    main();
} catch (error) {
    console.error(`[patch-dungeonblitz-character-select-reset] ${error.message}`);
    process.exitCode = 1;
}
