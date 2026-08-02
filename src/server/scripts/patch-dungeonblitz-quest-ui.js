#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const TARGET_SWFS = [
    path.join('src', 'client', 'content', 'localhost', 'p', 'cbp', 'DungeonBlitz.swf')
];

function parseArgs(argv) {
    const args = {
        ffdec: '',
        verify: false,
        swfs: []
    };

    for (let index = 2; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === '--ffdec' || arg === '-f') {
            args.ffdec = argv[++index] || '';
            continue;
        }
        if (arg === '--swf' || arg === '-s') {
            args.swfs.push(argv[++index] || '');
            continue;
        }
        if (arg === '--verify') {
            args.verify = true;
            continue;
        }
        if (arg === '--help' || arg === '-h') {
            printHelp();
            process.exit(0);
        }

        throw new Error(`Unknown argument: ${arg}`);
    }

    return args;
}

function printHelp() {
    console.log(
        [
            'Usage:',
            '  node src/server/scripts/patch-dungeonblitz-quest-ui.js [--verify] [--swf <path>] [--ffdec <path>]',
            '',
            'Defaults:',
            '  patches LinkUpdater in the served DungeonBlitz SWF',
            '  so quest popups and tutorial highlighters follow the intended story flow.'
        ].join('\n')
    );
}

function resolveRepoRoot() {
    return path.resolve(__dirname, '..', '..', '..');
}

function resolvePath(repoRoot, value) {
    if (!value) {
        return '';
    }
    if (path.isAbsolute(value)) {
        return value;
    }
    return path.join(repoRoot, value);
}

function detectFfdec(repoRoot, preferred) {
    const candidates = [];
    if (preferred) {
        candidates.push(resolvePath(repoRoot, preferred));
    }

    candidates.push(
        '/Applications/FFDec.app/Contents/Resources/ffdec.sh',
        '/Applications/FFDec.app/Contents/Resources/ffdec.jar',
        '/Applications/FFDec.app/Contents/Resources/ffdec-cli.jar',
        path.join(repoRoot, 'temp', 'jpexs_25_1_3', 'FFDec.app', 'Contents', 'Resources', 'ffdec.sh'),
        path.join(repoRoot, 'temp', 'jpexs_25_1_3', 'FFDec.app', 'Contents', 'Resources', 'ffdec.jar'),
        path.join(repoRoot, 'temp', 'jpexs_25_1_3', 'FFDec.app', 'Contents', 'Resources', 'ffdec-cli.jar')
    );

    for (const candidate of candidates) {
        if (candidate && fs.existsSync(candidate)) {
            return candidate;
        }
    }

    return '';
}

function runFfdec(ffdecPath, args) {
    const resolved = path.resolve(ffdecPath);
    const basename = path.basename(resolved).toLowerCase();

    if (basename.endsWith('.jar')) {
        execFileSync('java', ['-jar', resolved, '-cli', ...args], {
            stdio: 'inherit'
        });
        return;
    }

    execFileSync(resolved, ['-cli', ...args], {
        stdio: 'inherit'
    });
}

function replaceExact(source, needle, replacement, label) {
    if (!source.includes(needle)) {
        throw new Error(`Could not find patch marker: ${label}`);
    }
    return source.replace(needle, replacement);
}

function replaceBlock(source, candidates, replacement, label) {
    if (source.includes(replacement)) {
        return source;
    }

    for (const candidate of candidates) {
        if (candidate && source.includes(candidate)) {
            return source.replace(candidate, replacement);
        }
    }

    throw new Error(`Could not find patch marker: ${label}`);
}

function patchLinkUpdater(source) {
    const eol = source.includes('\r\n') ? '\r\n' : '\n';
    const join = (lines) => lines.join(eol);

    const missionReadyOriginal = join([
        '      private function method_1550(param1:Packet) : void',
        '      {',
        '         var _loc2_:uint = param1.method_4();',
        '         this.var_1.method_1787(_loc2_);',
        '      }'
    ]);
    const missionReadyPatched = join([
        '      private function method_1550(param1:Packet) : void',
        '      {',
        '         var _loc2_:uint = param1.method_4();',
        '         this.var_1.method_1787(_loc2_);',
        '         if(_loc2_ == class_13.const_544)',
        '         {',
        '            this.var_1.SetNewTutorialStage(Game.const_306);',
        '         }',
        '      }'
    ]);

    const missionCompleteOriginal = join([
        '      private function method_1294(param1:Packet) : void',
        '      {',
        '         var _loc2_:uint = 0;',
        '         var _loc3_:uint = 0;',
        '         var _loc4_:uint = param1.method_4();',
        '         if(param1.method_11())',
        '         {',
        '            _loc2_ = param1.method_6(class_119.const_228);',
        '            _loc3_ = param1.method_4();',
        '         }',
        '         this.var_1.method_1472(_loc4_,_loc2_,_loc3_);',
        '      }'
    ]);
    const missionCompletePatched = join([
        '      private function method_1294(param1:Packet) : void',
        '      {',
        '         var _loc2_:uint = 0;',
        '         var _loc3_:uint = 0;',
        '         var _loc4_:uint = param1.method_4();',
        '         if(param1.method_11())',
        '         {',
        '            _loc2_ = param1.method_6(class_119.const_228);',
        '            _loc3_ = param1.method_4();',
        '         }',
        '         this.var_1.method_1472(_loc4_,_loc2_,_loc3_);',
        '         if(_loc4_ == class_13.const_544)',
        '         {',
        '            this.var_1.SetNewTutorialStage(Game.const_313);',
        '         }',
        '      }'
    ]);

    const missionAddedOriginal = join([
        '      private function method_1122(param1:Packet) : void',
        '      {',
        '         var _loc2_:uint = param1.method_4();',
        '         var _loc3_:Boolean = param1.method_11();',
        '         this.var_1.method_1380(_loc2_,_loc3_);',
        '      }'
    ]);
    const missionAddedGuarded = join([
        '      private function method_1122(param1:Packet) : void',
        '      {',
         '         var _loc4_:Mission = null;',
        '         var _loc2_:uint = param1.method_4();',
        '         var _loc3_:Boolean = param1.method_11();',
        '         _loc4_ = this.var_1.mMissionInfoList[_loc2_];',
        '         if(_loc4_)',
        '         {',
        '            return;',
        '         }',
        '         this.var_1.method_1380(_loc2_,_loc3_);',
        '      }'
    ]);
    const missionAddedPatched = join([
        '      private function method_1122(param1:Packet) : void',
        '      {',
        '         var _loc2_:uint = param1.method_4();',
        '         var _loc3_:Boolean = param1.method_11();',
        '         this.var_1.method_1380(_loc2_,_loc3_);',
        '         if(_loc2_ == class_13.const_831 && !_loc3_)',
        '         {',
        '            this.var_1.SetNewTutorialStage(Game.const_212);',
        '         }',
        '      }'
    ]);

    let patched = source;
    patched = replaceBlock(
        patched,
        [missionReadyOriginal],
        missionReadyPatched,
        'LinkUpdater mission-ready tutorial hook'
    );
    patched = replaceBlock(
        patched,
        [missionCompleteOriginal],
        missionCompletePatched,
        'LinkUpdater mission-complete tutorial hook'
    );
    patched = replaceBlock(
        patched,
        [missionAddedOriginal, missionAddedGuarded],
        missionAddedPatched,
        'LinkUpdater mission-added tutorial hook'
    );

    return patched;
}

function verifyLinkUpdater(source, swfPath) {
    if (source.includes('_loc4_ = this.var_1.mMissionInfoList[_loc2_];')) {
        throw new Error(`${path.basename(swfPath)} still contains the stale duplicate mission-added guard.`);
    }
    if (!source.includes('this.var_1.SetNewTutorialStage(Game.const_306);')) {
        throw new Error(`${path.basename(swfPath)} is missing the mission-ready tutorial hook.`);
    }
    if (!source.includes('this.var_1.SetNewTutorialStage(Game.const_313);')) {
        throw new Error(`${path.basename(swfPath)} is missing the mission-complete tutorial hook.`);
    }
    if (!source.includes('this.var_1.SetNewTutorialStage(Game.const_212);')) {
        throw new Error(`${path.basename(swfPath)} is missing the quest-information tutorial hook.`);
    }
}

function exportScripts(ffdecPath, workRoot, swfPath) {
    fs.rmSync(workRoot, { recursive: true, force: true });
    fs.mkdirSync(workRoot, { recursive: true });
    runFfdec(ffdecPath, ['-selectclass', 'LinkUpdater', '-export', 'script', workRoot, swfPath]);

    const linkUpdaterPath = path.join(workRoot, 'scripts', 'LinkUpdater.as');
    if (!fs.existsSync(linkUpdaterPath)) {
        throw new Error(`FFDec export did not produce ${linkUpdaterPath}`);
    }

    return linkUpdaterPath;
}

function patchSwf(repoRoot, ffdecPath, swfPath) {
    const workRoot = path.join(
        repoRoot,
        'build',
        'ffdec-dungeonblitz-quest-ui',
        path.basename(swfPath, path.extname(swfPath))
    );
    const patchedSwfPath = path.join(workRoot, `${path.basename(swfPath, path.extname(swfPath))}.patched.swf`);
    const linkUpdaterPath = exportScripts(ffdecPath, workRoot, swfPath);
    const original = fs.readFileSync(linkUpdaterPath, 'utf8');
    const patched = patchLinkUpdater(original);

    if (patched === original) {
        verifyLinkUpdater(original, swfPath);
        console.log(`SWF already contains the quest UI patch: ${swfPath}`);
        return;
    }

    fs.writeFileSync(linkUpdaterPath, patched, 'utf8');
    runFfdec(ffdecPath, ['-importScript', swfPath, patchedSwfPath, path.dirname(linkUpdaterPath)]);
    fs.copyFileSync(patchedSwfPath, swfPath);
    console.log(`Patched quest UI flow in ${swfPath}`);
}

function verifySwf(repoRoot, ffdecPath, swfPath) {
    const workRoot = path.join(
        repoRoot,
        'build',
        'ffdec-dungeonblitz-quest-ui-verify',
        path.basename(swfPath, path.extname(swfPath))
    );
    const linkUpdaterPath = exportScripts(ffdecPath, workRoot, swfPath);
    verifyLinkUpdater(fs.readFileSync(linkUpdaterPath, 'utf8'), swfPath);
    console.log(`Verified quest UI flow patch in ${swfPath}`);
}

function main() {
    const repoRoot = resolveRepoRoot();
    const args = parseArgs(process.argv);
    const ffdecPath = detectFfdec(repoRoot, args.ffdec);

    if (!ffdecPath) {
        throw new Error('FFDec not found. Pass --ffdec or install JPEXS FFDec.');
    }

    const swfs = (args.swfs.length ? args.swfs : TARGET_SWFS).map((entry) => resolvePath(repoRoot, entry));
    for (const swfPath of swfs) {
        if (!fs.existsSync(swfPath)) {
            throw new Error(`SWF not found: ${swfPath}`);
        }
    }

    if (args.verify) {
        for (const swfPath of swfs) {
            verifySwf(repoRoot, ffdecPath, swfPath);
        }
        return;
    }

    for (const swfPath of swfs) {
        patchSwf(repoRoot, ffdecPath, swfPath);
    }
}

try {
    main();
} catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
}
