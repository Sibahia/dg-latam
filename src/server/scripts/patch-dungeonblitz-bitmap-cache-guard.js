#!/usr/bin/env node

/*
 * Disable the one cache-maintenance call that can crash the renderer.
 *
 * This deliberately does not use FFDec source import.  The historical source
 * patch required an exported Game.as that is not part of this repository; on
 * a rebuilt SWF that made the fix impossible to reproduce.  The AVM2 sequence
 * is stable and replaces a void call with `pop; nop; nop; nop`, so it consumes
 * the same receiver, has the same byte length, and cannot disturb branches or
 * exception tables.  Rendering continues without this optional cache sweep.
 */

require("ts-node/register");

const fs = require("fs");
const path = require("path");
const {
    PatchError,
    applyPatchesToBody,
    classIndexByName,
    methodIdxForTrait,
    parseAbc,
    parseSwf,
    writeSwf,
    writeU30
} = require("./swfPatchUtils");

const DEFAULT_SWF = path.resolve(
    __dirname,
    "..",
    "..",
    "client",
    "content",
    "localhost",
    "p",
    "cbp",
    "DungeonBlitz.swf"
);
const GAME_CLASS = "Game";
const GAME_TICK_METHOD = "method_1296";
const CACHE_FIELD = "var_171";
const CACHE_TICK_METHOD = "method_1829";
const POP_AND_NOPS = Buffer.from([0x29, 0x02, 0x02, 0x02]);

function parseArgs(argv) {
    let swfPath = DEFAULT_SWF;
    let verify = false;

    for (let index = 2; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === "--verify") {
            verify = true;
            continue;
        }
        if (arg === "--swf" || arg === "-s") {
            const value = argv[++index];
            if (!value) {
                throw new PatchError(`${arg} requires a path`);
            }
            swfPath = path.resolve(value);
            continue;
        }
        if (arg === "--help" || arg === "-h") {
            console.log([
                "Usage:",
                "  node src/server/scripts/patch-dungeonblitz-bitmap-cache-guard.js [--verify] [--swf <path>]",
                "",
                "Disables the crashing optional bitmap-cache maintenance call in DungeonBlitz.swf.",
                "This patch is bytecode-only and does not require FFDec or an exported Game.as."
            ].join("\n"));
            process.exit(0);
        }
        throw new PatchError(`Unknown argument: ${arg}`);
    }

    return { swfPath, verify };
}

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

function getTarget(ctx, abc) {
    const classIndex = classIndexByName(abc, GAME_CLASS);
    if (classIndex === null) {
        throw new PatchError(`Class ${GAME_CLASS} not found`);
    }
    const methodIndex = methodIdxForTrait(
        abc.instances[classIndex].traits,
        abc,
        GAME_TICK_METHOD
    );
    if (methodIndex === null) {
        throw new PatchError(`Method ${GAME_CLASS}.${GAME_TICK_METHOD} not found`);
    }
    const body = abc.methodBodies.get(methodIndex);
    if (!body) {
        throw new PatchError(`Method body ${GAME_CLASS}.${GAME_TICK_METHOD} not found`);
    }

    const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
    const candidates = [];
    for (const field of findMultinames(abc, CACHE_FIELD)) {
        const property = Buffer.concat([Buffer.from([0x66]), writeU30(field)]);
        for (const method of findMultinames(abc, CACHE_TICK_METHOD)) {
            const original = Buffer.concat([
                property,
                Buffer.from([0x4f]),
                writeU30(method),
                Buffer.from([0x00])
            ]);
            let offset = code.indexOf(original);
            while (offset >= 0) {
                candidates.push({ isPatched: false, offset, propertyLength: property.length });
                offset = code.indexOf(original, offset + 1);
            }
        }
        const patched = Buffer.concat([property, POP_AND_NOPS]);
        let offset = code.indexOf(patched);
        while (offset >= 0) {
            candidates.push({ isPatched: true, offset, propertyLength: property.length });
            offset = code.indexOf(patched, offset + 1);
        }
    }

    if (candidates.length === 0) {
        throw new PatchError("Could not find the Game bitmap-cache maintenance call");
    }
    if (candidates.length > 1) {
        throw new PatchError(`Expected one Game bitmap-cache maintenance call, found ${candidates.length}`);
    }
    const candidate = candidates[0];

    return {
        body,
        callOffset: candidate.offset + candidate.propertyLength,
        isPatched: candidate.isPatched
    };
}

function verifySwf(swfPath) {
    const ctx = parseSwf(swfPath);
    const abc = parseAbc(ctx);
    const target = getTarget(ctx, abc);
    if (!target.isPatched) {
        throw new PatchError("Bitmap cache maintenance is still enabled");
    }
    console.log("Bitmap cache crash guard verified (optional cache sweep disabled).");
}

function patchSwf(swfPath) {
    const ctx = parseSwf(swfPath);
    const abc = parseAbc(ctx);
    const target = getTarget(ctx, abc);
    if (target.isPatched) {
        console.log("Bitmap cache crash guard is already applied.");
        return;
    }

    const start = target.body.codeStart + target.callOffset;
    const { body, delta } = applyPatchesToBody(ctx.body, [{
        key: "game-bitmap-cache-disable-crashing-tick",
        start,
        end: start + 4,
        data: POP_AND_NOPS,
        detail: "replace class_82.method_1829 void call with pop and nops"
    }]);
    if (delta !== 0) {
        throw new PatchError("Bitmap cache patch must preserve the SWF byte length");
    }
    writeSwf(ctx, body, delta);
    verifySwf(swfPath);
}

try {
    const args = parseArgs(process.argv);
    if (!fs.existsSync(args.swfPath)) {
        throw new PatchError(`SWF not found: ${args.swfPath}`);
    }
    if (args.verify) {
        verifySwf(args.swfPath);
    } else {
        patchSwf(args.swfPath);
    }
} catch (error) {
    console.error("[bitmap-cache-guard] failed");
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
}
