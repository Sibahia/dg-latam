#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// class_112 cannot be round-tripped through FFDec source: its export contains
// non-importable control-flow pseudo-instructions.  Load the shared AVM2
// parser so the progress label can be patched directly instead.
require('ts-node/register');
const {
    PatchError,
    applyPatchesToBody,
    classIndexByName,
    disassemble,
    methodIdxForTrait,
    parseAbc,
    parseSwf,
    readU30,
    writeSwf,
    writeU30
} = require('./swfPatchUtils');

const TARGET_SWFS = [
    path.join('src', 'client', 'content', 'localhost', 'p', 'cbp', 'DungeonBlitz.swf')
];

const PROGRESS_CLASS = 'class_112';
const PROGRESS_METHOD = 'OnRefreshScreen';
const PROGRESS_FIELD = 'var_690';
const STRING_MULTINAME = 'String';

function findMultinames(abc, name) {
    const matches = [];
    for (let index = 0; index < abc.multinameNames.length; index += 1) {
        if (abc.multinameNames[index] === name) {
            matches.push(index);
        }
    }
    if (matches.length === 0) {
        throw new PatchError(`Could not find multiname ${name}`);
    }
    return matches;
}

function writeS24(value) {
    if (value < -0x800000 || value > 0x7fffff) {
        throw new PatchError(`s24 branch offset out of range: ${value}`);
    }
    const encoded = value < 0 ? value + 0x1000000 : value;
    return Buffer.from([encoded & 0xff, (encoded >>> 8) & 0xff, (encoded >>> 16) & 0xff]);
}

function isBranch(instruction) {
    return instruction.opcode >= 0x0c && instruction.opcode <= 0x1a;
}

function patchCodeAndRelocateBranches(originalCode, instructions, edits, label) {
    const ordered = [...edits].sort((left, right) => left.start - right.start);
    let cursor = 0;
    const chunks = [];
    for (const edit of ordered) {
        if (edit.start < cursor || edit.end < edit.start || edit.end > originalCode.length) {
            throw new PatchError(`Invalid ${label} bytecode edit ${edit.start}:${edit.end}`);
        }
        chunks.push(originalCode.subarray(cursor, edit.start), edit.data);
        cursor = edit.end;
    }
    chunks.push(originalCode.subarray(cursor));
    const patched = Buffer.concat(chunks);

    const deltaFor = (edit) => edit.data.length - (edit.end - edit.start);
    const isEdited = (offset) => ordered.some((edit) => offset >= edit.start && offset < edit.end);
    const mapOffset = (offset) => ordered.reduce(
        (mapped, edit) => mapped + (edit.end <= offset ? deltaFor(edit) : 0),
        offset
    );
    const mapTarget = (offset) => {
        let mapped = offset;
        for (const edit of ordered) {
            if (offset < edit.start) {
                continue;
            }
            if (offset === edit.start) {
                return mapped;
            }
            if (offset < edit.end) {
                throw new PatchError(`${label} branch targets replaced instructions at ${offset}`);
            }
            mapped += deltaFor(edit);
        }
        return mapped;
    };

    for (const instruction of instructions) {
        if (!isBranch(instruction) || isEdited(instruction.offset)) {
            continue;
        }
        const branch = instruction.operands[0];
        if (!branch || branch[0] !== 's24') {
            throw new PatchError(`Malformed ${label} branch at ${instruction.offset}`);
        }
        const oldTarget = instruction.offset + instruction.size + branch[1];
        const newOffset = mapOffset(instruction.offset);
        const newTarget = mapTarget(oldTarget);
        writeS24(newTarget - (newOffset + instruction.size)).copy(patched, newOffset + 1);
    }

    return patched;
}

function verifyBranchTargets(code, label) {
    const instructions = disassemble(code, label);
    const boundaries = new Set(instructions.map((instruction) => instruction.offset));
    boundaries.add(code.length);
    for (const instruction of instructions) {
        if (!isBranch(instruction)) {
            continue;
        }
        const branch = instruction.operands[0];
        const target = instruction.offset + instruction.size + branch[1];
        if (!boundaries.has(target)) {
            throw new PatchError(`${label} branch at ${instruction.offset} targets ${target}, not an instruction boundary`);
        }
    }
}

function progressMethod(ctx, abc) {
    const classIndex = classIndexByName(abc, PROGRESS_CLASS);
    if (classIndex === null) {
        throw new PatchError(`Class ${PROGRESS_CLASS} not found`);
    }
    const methodIndex = methodIdxForTrait(abc.instances[classIndex].traits, abc, PROGRESS_METHOD);
    if (methodIndex === null) {
        throw new PatchError(`Method ${PROGRESS_CLASS}.${PROGRESS_METHOD} not found`);
    }
    const body = abc.methodBodies.get(methodIndex);
    if (!body || body.exceptionCount !== 0) {
        throw new PatchError(`Unexpected ${PROGRESS_CLASS}.${PROGRESS_METHOD} body shape`);
    }
    return body;
}

function progressPatchStatus(swfPath) {
    const ctx = parseSwf(swfPath);
    const abc = parseAbc(ctx);
    const body = progressMethod(ctx, abc);
    const code = Buffer.from(ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen));
    const fieldIndexes = findMultinames(abc, PROGRESS_FIELD);
    const stringIndexes = findMultinames(abc, STRING_MULTINAME);
    const originalOffsets = [];
    const patchedOffsets = [];

    for (const field of fieldIndexes) {
        const getProgress = Buffer.concat([Buffer.from([0xd1, 0x66]), writeU30(field)]);
        const clamp = Buffer.concat([
            getProgress,
            Buffer.from([0x2a, 0x24, 0x63, 0xaf, 0xa1, 0x70])
        ]);
        for (const string of stringIndexes) {
            const original = Buffer.concat([
                Buffer.from([0x5d]),
                writeU30(string),
                getProgress,
                Buffer.from([0x46]),
                writeU30(string),
                Buffer.from([0x01])
            ]);
            let offset = code.indexOf(original);
            while (offset >= 0) {
                originalOffsets.push({ offset, length: original.length, replacement: clamp });
                offset = code.indexOf(original, offset + 1);
            }
        }
        let offset = code.indexOf(clamp);
        while (offset >= 0) {
            patchedOffsets.push(offset);
            offset = code.indexOf(clamp, offset + 1);
        }
    }

    if (originalOffsets.length > 0 && patchedOffsets.length > 0) {
        throw new PatchError('Tutorial progress display is in a mixed partial state');
    }
    if (originalOffsets.length === 0 && patchedOffsets.length === 0) {
        throw new PatchError('Could not locate tutorial progress display call sites');
    }
    if (originalOffsets.length > 0 && originalOffsets.length !== 2) {
        throw new PatchError(`Expected two unpatched tutorial progress call sites, found ${originalOffsets.length}`);
    }
    if (patchedOffsets.length > 0 && patchedOffsets.length !== 2) {
        throw new PatchError(`Expected two patched tutorial progress call sites, found ${patchedOffsets.length}`);
    }
    return { ctx, abc, body, code, originalOffsets, patchedOffsets };
}

function patchTutorialProgressDisplay(swfPath) {
    const status = progressPatchStatus(swfPath);
    if (status.patchedOffsets.length > 0) {
        return;
    }
    const instructions = disassemble(status.code, `${PROGRESS_CLASS}.${PROGRESS_METHOD}`);
    const patchedCode = patchCodeAndRelocateBranches(
        status.code,
        instructions,
        status.originalOffsets.map((entry) => ({
            start: entry.offset,
            end: entry.offset + entry.length,
            data: entry.replacement
        })),
        `${PROGRESS_CLASS}.${PROGRESS_METHOD}`
    );
    verifyBranchTargets(patchedCode, `${PROGRESS_CLASS}.${PROGRESS_METHOD}`);
    const [maxStack] = readU30(status.ctx.body, status.body.maxStackPos, `${PROGRESS_CLASS}.${PROGRESS_METHOD}.max_stack`);
    if (maxStack < 4) {
        throw new PatchError(`${PROGRESS_CLASS}.${PROGRESS_METHOD} max_stack ${maxStack} is too small`);
    }
    const patched = applyPatchesToBody(status.ctx.body, [
        {
            key: 'tutorial-progress-display-code',
            start: status.body.codeStart,
            end: status.body.codeStart + status.body.codeLen,
            data: patchedCode,
            detail: 'clamp follower progress display at 99 until the tutorial completes'
        },
        {
            key: 'tutorial-progress-display-code-length',
            start: status.body.codeLenPos,
            end: status.body.codeStart,
            data: writeU30(patchedCode.length),
            detail: 'update class_112 OnRefreshScreen code length'
        }
    ]);
    writeSwf(status.ctx, patched.body, patched.delta);
    const verified = progressPatchStatus(swfPath);
    if (verified.patchedOffsets.length !== 2) {
        throw new PatchError('Tutorial progress display did not verify after patching');
    }
    verifyBranchTargets(
        verified.code,
        `${PROGRESS_CLASS}.${PROGRESS_METHOD} verified`
    );
}

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
            '  node src/server/scripts/patch-dungeonblitz-tutorial-party-progress.js [--verify] [--swf <path>] [--ffdec <path>]',
            '',
            'Defaults:',
            '  patches the served SWF:',
            `    ${TARGET_SWFS[0]}`,
            '  --verify validates bytecode and source-imported markers for the tutorial party-progress fix'
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
        path.join(repoRoot, 'build', 'tools', 'ffdec_25.1.3', 'ffdec.jar'),
        path.join(repoRoot, 'build', 'tools', 'ffdec_25.1.3', 'ffdec.sh'),
        path.join(repoRoot, 'build', 'tools', 'ffdec_25.1.3', 'ffdec-cli.jar'),
        path.join(repoRoot, 'temp', 'jpexs_25_1_3', 'FFDec.app', 'Contents', 'Resources', 'ffdec.jar'),
        path.join(repoRoot, 'temp', 'jpexs_25_1_3', 'FFDec.app', 'Contents', 'Resources', 'ffdec.sh'),
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

    if (basename.endsWith('.sh')) {
        execFileSync(resolved, ['-cli', ...args], {
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

function patchLinkUpdater(source) {
    const eol = source.includes('\r\n') ? '\r\n' : '\n';
    const join = (lines) => lines.join(eol);

    if (!source.includes('private function method_1912(param1:Entity) : void')) {
        source = replaceExact(
            source,
            join([
                '      private function method_1615(param1:Packet) : void'
            ]),
            join([
                '      private function method_1912(param1:Entity) : void',
                '      {',
                '         var _loc2_:Room = null;',
                '         var _loc3_:uint = 0;',
                '         if(!param1 || !param1.cue || !param1.cue.room)',
                '         {',
                '            return;',
                '         }',
                '         if(!this.var_1 || !this.var_1.level || this.var_1.level.internalName != "TutorialDungeon")',
                '         {',
                '            return;',
                '         }',
                '         _loc2_ = param1.cue.room as Room;',
                '         if(!_loc2_)',
                '         {',
                '            return;',
                '         }',
                '         param1.var_1609 = _loc2_;',
                '         param1.currRoom = _loc2_;',
                '         if(_loc2_.var_229.indexOf(param1) == -1)',
                '         {',
                '            _loc2_.var_229.push(param1);',
                '         }',
                '         _loc3_ = _loc2_.method_348();',
                '         if(_loc3_ > _loc2_.var_2261)',
                '         {',
                '            _loc2_.var_2261 = _loc3_;',
                '         }',
                '         _loc3_ = _loc2_.method_1990();',
                '         if(_loc3_ > _loc2_.var_802)',
                '         {',
                '            _loc2_.var_802 = _loc3_;',
                '         }',
                '      }',
                '      ',
                '      private function method_1615(param1:Packet) : void'
            ]),
            'LinkUpdater tutorial room bookkeeping helper'
        );
    }

    if (!source.includes('this.method_1912(_loc46_);')) {
        source = replaceExact(
            source,
            join([
                '         _loc46_.var_38.var_914 = _loc5_;'
            ]),
            join([
                '         if(_loc12_ != Entity.PLAYER)',
                '         {',
                '            this.method_1912(_loc46_);',
                '         }',
                '         _loc46_.var_38.var_914 = _loc5_;'
            ]),
            'LinkUpdater tutorial room bookkeeping call'
        );
    }

    return source;
}

function patchRoom(source) {
    const eol = source.includes('\r\n') ? '\r\n' : '\n';
    const join = (lines) => lines.join(eol);

    if (source.includes('null.bDisabled = param3 != "On";')) {
        source = replaceExact(
            source,
            join([
                '            var _loc4_:Door = this.var_1.level.method_1462(param2);',
                '            if(_loc4_)',
                '            {',
                '               null.bDisabled = param3 != "On";',
                '            }'
            ]),
            join([
                '            var _loc4_:Door = this.var_1.level.method_1462(param2);',
                '            if(_loc4_)',
                '            {',
                '               _loc4_.bDisabled = param3 != "On";',
                '            }'
            ]),
            'Room decompile fix: door state'
        );
    }

    if (source.includes('if((Boolean(_loc5_)) && null.entState != Entity.const_6)')) {
        source = replaceExact(
            source,
            join([
                '            var _loc5_:Entity = this.var_1.GetEntFromID(int(param2));',
                '            if((Boolean(_loc5_)) && null.entState != Entity.const_6)',
                '            {',
                '               null.gfx.m_Seq.method_34(Seq.C_USEPOWER,param3,true);',
                '            }'
            ]),
            join([
                '            var _loc5_:Entity = this.var_1.GetEntFromID(int(param2));',
                '            if((Boolean(_loc5_)) && _loc5_.entState != Entity.const_6)',
                '            {',
                '               _loc5_.gfx.m_Seq.method_34(Seq.C_USEPOWER,param3,true);',
                '            }'
            ]),
            'Room decompile fix: entity animation'
        );
    }

    if (source.includes('var _loc34_:SuperAnimInstance = this.method_67(null);')) {
        source = replaceExact(
            source,
            join([
                '               var _loc33_:String = "am_WaveFG" + (_loc10_ == 1 ? 14 : _loc10_ - 1);',
                '               var _loc34_:SuperAnimInstance = this.method_67(null);',
                '               _loc17_.x = null.m_TheDO.x + 200 + Math.random() * 200;'
            ]),
            join([
                '               var _loc33_:String = "am_WaveFG" + (_loc10_ == 1 ? 14 : _loc10_ - 1);',
                '               var _loc34_:SuperAnimInstance = this.method_67(_loc33_);',
                '               _loc17_.x = _loc34_.m_TheDO.x + 200 + Math.random() * 200;'
            ]),
            'Room decompile fix: wave animation anchor'
        );
    }

    if (source.includes('var _loc8_:* = §§findproperty(_loc6_);')) {
        source = replaceExact(
            source,
            join([
                '         var _loc7_:int = int(_loc1_.length);',
                '         _loc2_ = 0;',
                '         while(_loc2_ < _loc7_)',
                '         {',
                '            _loc3_ = _loc1_[_loc2_];',
                '            _loc3_.aggroTeamID = 1;',
                '            if(_loc2_ + 1 < _loc7_)',
                '            {',
                '               var _loc6_:a_Cue = _loc1_[_loc2_ + 1];',
                '               if(_loc6_.x - _loc3_.x > const_1046)',
                '               {',
                '                  var _loc8_:* = §§findproperty(_loc6_);',
                '                  var _loc9_:* = Number(_loc8_._loc6_) + 1;',
                '                  _loc8_._loc6_ = _loc9_;',
                '               }',
                '            }',
                '            _loc2_++;',
                '         }'
            ]),
            join([
                '         var _loc6_:int = 1;',
                '         var _loc8_:int = int(_loc1_.length);',
                '         _loc2_ = 0;',
                '         while(_loc2_ < _loc8_)',
                '         {',
                '            _loc3_ = _loc1_[_loc2_];',
                '            _loc3_.aggroTeamID = _loc6_;',
                '            if(_loc2_ + 1 < _loc8_)',
                '            {',
                '               var _loc7_:a_Cue = _loc1_[_loc2_ + 1];',
                '               if(_loc7_.x - _loc3_.x > const_1046)',
                '               {',
                '                  _loc6_++;',
                '               }',
                '            }',
                '            _loc2_++;',
                '         }'
            ]),
            'Room decompile fix: aggro team counter'
        );
    }

    if (!source.includes('this.var_1.level.internalName == "TutorialDungeon"')) {
        source = replaceExact(
            source,
            join([
                '      public function method_1264() : Number',
                '      {',
                '         if(!this.var_2261)',
                '         {',
                '            return 1;',
                '         }',
                '         if(Boolean(this.var_2261) && !this.var_802)',
                '         {',
                '            return 0;',
                '         }',
                '         if(!this.var_802)',
                '         {',
                '            return 1;',
                '         }',
                '         var _loc1_:uint = this.method_1990();',
                '         if(_loc1_ >= this.var_802)',
                '         {',
                '            return 0;',
                '         }',
                '         if(this.var_1217 > this.var_802)',
                '         {',
                '            this.var_1217 = this.var_802;',
                '         }',
                '         return 1 - (_loc1_ + this.var_1217) / this.var_802;',
                '      }'
            ]),
            join([
                '      public function method_1264() : Number',
                '      {',
                '         var _loc1_:uint = 0;',
                '         if(!this.var_2261)',
                '         {',
                '            if(this.var_1 && this.var_1.level && this.var_1.level.internalName == "TutorialDungeon")',
                '            {',
                '               _loc1_ = this.method_348();',
                '               if(_loc1_)',
                '               {',
                '                  this.var_2261 = _loc1_;',
                '                  this.var_802 = this.method_1990();',
                '               }',
                '            }',
                '            if(!this.var_2261)',
                '            {',
                '               return 1;',
                '            }',
                '         }',
                '         if(Boolean(this.var_2261) && !this.var_802)',
                '         {',
                '            return 0;',
                '         }',
                '         if(!this.var_802)',
                '         {',
                '            return 1;',
                '         }',
                '         _loc1_ = this.method_1990();',
                '         if(_loc1_ >= this.var_802)',
                '         {',
                '            return 0;',
                '         }',
                '         if(this.var_1217 > this.var_802)',
                '         {',
                '            this.var_1217 = this.var_802;',
                '         }',
                '         return 1 - (_loc1_ + this.var_1217) / this.var_802;',
                '      }'
            ]),
            'Room tutorial bootstrap in method_1264'
        );
    }

    return source;
}

function assertVerification(content, checks, targetLabel) {
    for (const check of checks) {
        if (!content.includes(check.needle)) {
            throw new Error(`${targetLabel} is missing verification marker: ${check.label}`);
        }
    }
}

function verifyPatchedScripts(linkUpdaterSource, roomSource, swfPath) {
    const label = path.basename(swfPath);
    const progress = progressPatchStatus(swfPath);
    if (progress.patchedOffsets.length !== 2) {
        throw new Error(`${label} class_112 is missing both follower progress clamps`);
    }
    verifyBranchTargets(progress.code, `${label} class_112 follower progress`);
    assertVerification(
        linkUpdaterSource,
        [
            { label: 'LinkUpdater tutorial helper', needle: 'private function method_1912(param1:Entity) : void' },
            { label: 'LinkUpdater tutorial scope', needle: 'this.var_1.level.internalName != "TutorialDungeon"' },
            { label: 'LinkUpdater room bind', needle: 'param1.var_1609 = _loc2_;' },
            { label: 'LinkUpdater room vector insert', needle: '_loc2_.var_229.indexOf(param1) == -1' }
        ],
        `${label} LinkUpdater`
    );
    assertVerification(
        roomSource,
        [
            { label: 'Room tutorial bootstrap scope', needle: 'this.var_1.level.internalName == "TutorialDungeon"' },
            { label: 'Room tutorial hostile bootstrap', needle: 'this.var_2261 = _loc1_;' },
            { label: 'Room tutorial weighted bootstrap', needle: 'this.var_802 = this.method_1990();' }
        ],
        `${label} Room`
    );
}

function exportScripts(ffdecPath, workRoot, swfPath) {
    fs.rmSync(workRoot, { recursive: true, force: true });
    fs.mkdirSync(workRoot, { recursive: true });
    runFfdec(ffdecPath, ['-selectclass', 'LinkUpdater,Room', '-export', 'script', workRoot, swfPath]);

    const scriptsRoot = path.join(workRoot, 'scripts');
    const paths = {
        scriptsRoot,
        linkUpdater: path.join(scriptsRoot, 'LinkUpdater.as'),
        room: path.join(scriptsRoot, 'Room.as')
    };

    for (const filePath of Object.values(paths)) {
        if (!fs.existsSync(filePath)) {
            throw new Error(`FFDec export did not produce expected script: ${filePath}`);
        }
    }

    return paths;
}

function patchSwf(repoRoot, ffdecPath, swfPath) {
    const workRoot = path.join(
        repoRoot,
        'build',
        'ffdec-dungeonblitz-tutorial-party-progress',
        path.basename(swfPath, path.extname(swfPath))
    );
    const patchedSwfPath = path.join(workRoot, `${path.basename(swfPath, path.extname(swfPath))}.patched.swf`);
    patchTutorialProgressDisplay(swfPath);
    const exported = exportScripts(ffdecPath, workRoot, swfPath);

    const originalLinkUpdater = fs.readFileSync(exported.linkUpdater, 'utf8');
    const originalRoom = fs.readFileSync(exported.room, 'utf8');

    try {
        verifyPatchedScripts(originalLinkUpdater, originalRoom, swfPath);
        console.log(`SWF already contains tutorial follower fix: ${swfPath}`);
        return;
    } catch (_error) {
    }

    const patchedLinkUpdater = patchLinkUpdater(originalLinkUpdater);
    const patchedRoom = patchRoom(originalRoom);

    fs.writeFileSync(exported.linkUpdater, patchedLinkUpdater, 'utf8');
    fs.writeFileSync(exported.room, patchedRoom, 'utf8');

    runFfdec(ffdecPath, ['-importScript', swfPath, patchedSwfPath, exported.scriptsRoot]);
    fs.copyFileSync(patchedSwfPath, swfPath);
    console.log(`Patched tutorial follower fix into ${swfPath}`);
}

function verifySwf(repoRoot, ffdecPath, swfPath) {
    const workRoot = path.join(
        repoRoot,
        'build',
        'ffdec-dungeonblitz-tutorial-party-progress-verify',
        path.basename(swfPath, path.extname(swfPath))
    );
    const exported = exportScripts(ffdecPath, workRoot, swfPath);
    verifyPatchedScripts(
        fs.readFileSync(exported.linkUpdater, 'utf8'),
        fs.readFileSync(exported.room, 'utf8'),
        swfPath
    );
    console.log(`Verified tutorial follower fix markers in ${swfPath}`);
}

function main() {
    const repoRoot = resolveRepoRoot();
    const args = parseArgs(process.argv);
    const ffdecPath = detectFfdec(repoRoot, args.ffdec);
    if (!ffdecPath) {
        throw new Error('FFDec not found. Pass --ffdec or restore the repo-bundled FFDec app.');
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
