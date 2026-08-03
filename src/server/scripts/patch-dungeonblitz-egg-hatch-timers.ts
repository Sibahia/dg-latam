import * as fs from "fs";
import * as path from "path";
import {
  applyPatchesToBody,
  BytePatch,
  disassemble,
  ensureBackup,
  Instruction,
  parseAbc,
  parseSwf,
  PatchError,
  writeS32,
  writeSwf,
} from "./swfPatchUtils";

const DEFAULT_SWF_CANDIDATES = [
  path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p", "cbp", "DungeonBlitz.swf"),
  path.resolve(__dirname, "..", "..", "..", "client", "content", "localhost", "p", "cbp", "DungeonBlitz.swf"),
];
const DEFAULT_SWF = DEFAULT_SWF_CANDIDATES.find((candidate) => fs.existsSync(candidate)) ?? DEFAULT_SWF_CANDIDATES[0];

const OLD_EGG_HATCH_SECONDS = [259200, 432000, 604800] as const;
const MODERN_EGG_HATCH_SECONDS = [3600, 7200, 10800] as const;

function parseArgs(argv: string[]): { swfPath: string; verify: boolean } {
  let swfPath = DEFAULT_SWF;
  let verify = false;

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--swf" || arg === "-s") {
      swfPath = path.resolve(argv[++index] || "");
      continue;
    }
    if (arg === "--verify" || arg === "--dry-run") {
      verify = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log([
        "Usage:",
        "  ts-node src/server/scripts/patch-dungeonblitz-egg-hatch-timers.ts [--verify] [--swf <path>]",
        "",
        "Patches DungeonBlitz.swf egg hatch durations to 1h, 2h, 3h.",
      ].join("\n"));
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { swfPath, verify };
}

function instructionValue(abc: ReturnType<typeof parseAbc>, inst: Instruction): number | null {
  const operand = inst.operands[0];
  if (inst.opcode === 0x2d && operand?.[0] === "u30") {
    return abc.intValues[operand[1]] ?? null;
  }
  return null;
}

function findSequence(abc: ReturnType<typeof parseAbc>, instructions: Instruction[], sequence: readonly number[]): Instruction[] | null {
  for (let index = 0; index < instructions.length; index += 1) {
    const matched: Instruction[] = [];
    let cursor = index;

    while (cursor < instructions.length && matched.length < sequence.length) {
      const inst = instructions[cursor];
      const value = instructionValue(abc, inst);
      if (value === null) {
        cursor += 1;
        continue;
      }
      if (value !== sequence[matched.length]) {
        break;
      }
      matched.push(inst);
      cursor += 1;
    }

    if (matched.length === sequence.length) {
      return matched;
    }
  }
  return null;
}

function findPatches(swfPath: string): { patches: BytePatch[]; oldSequenceCount: number; modernSequenceCount: number } {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);
  const patches: BytePatch[] = [];
  const patchedIntStarts = new Set<number>();
  let oldSequenceCount = 0;
  let modernSequenceCount = 0;

  for (const [methodIdx, methodBody] of abc.methodBodies.entries()) {
    const code = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
    let instructions: Instruction[];
    try {
      instructions = disassemble(code, `method_${methodIdx}`);
    } catch {
      continue;
    }

    const oldSequence = findSequence(abc, instructions, OLD_EGG_HATCH_SECONDS);
    const modernSequence = findSequence(abc, instructions, MODERN_EGG_HATCH_SECONDS);
    if (modernSequence) {
      modernSequenceCount += 1;
    }
    if (!oldSequence) {
      continue;
    }

    oldSequenceCount += 1;
    for (let offset = 0; offset < OLD_EGG_HATCH_SECONDS.length; offset += 1) {
      const inst = oldSequence[offset];
      if (inst.opcode !== 0x2d || inst.operands[0]?.[0] !== "u30") {
        throw new PatchError(`Unexpected egg hatch duration opcode 0x${inst.opcode.toString(16)} at sequence offset ${offset}`);
      }
      const intIndex = inst.operands[0][1];
      const intStart = abc.intValuePositions[intIndex];
      const intEnd = abc.intValueEndPositions[intIndex];
      if (!intStart || !intEnd || abc.intValues[intIndex] !== OLD_EGG_HATCH_SECONDS[offset]) {
        throw new PatchError(`Unexpected int constant for egg hatch duration ${OLD_EGG_HATCH_SECONDS[offset]}`);
      }
      if (patchedIntStarts.has(intStart)) {
        continue;
      }
      patchedIntStarts.add(intStart);
      patches.push({
        key: `eggHatchConstant.${intStart}`,
        start: intStart,
        end: intEnd,
        data: writeS32(MODERN_EGG_HATCH_SECONDS[offset]),
        detail: `replace egg hatch duration ${OLD_EGG_HATCH_SECONDS[offset]} with ${MODERN_EGG_HATCH_SECONDS[offset]}`,
      });
    }
  }

  return { patches, oldSequenceCount, modernSequenceCount };
}

function patchSwf(swfPath: string, verify: boolean): void {
  const firstPass = findPatches(swfPath);
  if (verify) {
    if (firstPass.oldSequenceCount > 0 || firstPass.modernSequenceCount !== 1) {
      throw new PatchError(`Egg hatch timer patch missing: old=${firstPass.oldSequenceCount}, modern=${firstPass.modernSequenceCount}`);
    }
    console.log("Egg hatch timer patch verified.");
    return;
  }

  if (firstPass.patches.length === 0) {
    if (firstPass.modernSequenceCount === 1) {
      console.log("Egg hatch timer patch already applied.");
      return;
    }
    throw new PatchError(`Could not find old or modern egg hatch timer sequence in ${swfPath}`);
  }

  const ctx = parseSwf(swfPath);
  ensureBackup(swfPath);
  const { body, delta } = applyPatchesToBody(ctx.body, firstPass.patches);
  writeSwf(ctx, body, delta);

  const secondPass = findPatches(swfPath);
  if (secondPass.oldSequenceCount > 0 || secondPass.modernSequenceCount !== 1) {
    throw new PatchError(`Egg hatch timer patch did not verify after write: old=${secondPass.oldSequenceCount}, modern=${secondPass.modernSequenceCount}`);
  }

  console.log("Egg hatch timer patch applied.");
}

const args = parseArgs(process.argv);
patchSwf(args.swfPath, args.verify);
