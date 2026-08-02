import * as path from "path";
import {
  classIndexByName,
  disassemble,
  ensureBackup,
  Instruction,
  methodIdxForTrait,
  parseAbc,
  parseSwf,
  writeSwf,
} from "./swfPatchUtils";

const DEFAULT_SWF = path.resolve(
  __dirname,
  "..",
  "..",
  "client",
  "content",
  "localhost",
  "p",
  "cbp",
  "DungeonBlitz.swf",
);

export type TooltipStatMode = "original" | "applied";

function parseArgs(argv: string[]): { swfPath: string; verify: boolean; mode: TooltipStatMode } {
  let swfPath = DEFAULT_SWF;
  let verify = false;
  let mode: TooltipStatMode = "original";

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--swf" || arg === "-s") {
      swfPath = path.resolve(argv[++index] || "");
      continue;
    }
    if (arg === "--verify") {
      verify = true;
      continue;
    }
    if (arg === "--mode") {
      const value = argv[++index];
      if (value !== "original" && value !== "applied") {
        throw new Error(`Unknown mode: ${value}`);
      }
      mode = value;
      continue;
    }
    if (arg === "--original") {
      mode = "original";
      continue;
    }
    if (arg === "--applied") {
      mode = "applied";
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log([
        "Usage:",
        "  npx ts-node src/server/scripts/patch-dungeonblitz-gear-tooltip-stat-values.ts [--verify] [--mode original|applied] [--swf <path>]",
        "",
        "Patches GearType.method_121 gear tooltip stat display.",
        "",
        "Modes:",
        "  original  Restore the original client formula that subtracts baseline stats.",
        "  applied   Show the full Attack, Expertise, and Defense values applied to character statistics.",
      ].join("\n"));
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { swfPath, verify, mode };
}

function localIndex(inst: Instruction | undefined): number | null {
  if (!inst) {
    return null;
  }
  if (inst.opcode >= 0xd0 && inst.opcode <= 0xd3) {
    return inst.opcode - 0xd0;
  }
  const operand = inst.operands[0];
  if (inst.opcode === 0x62 && operand?.[0] === "u30") {
    return operand[1];
  }
  return null;
}

function getGearTypeMethod121(swfPath: string) {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);
  const classIndex = classIndexByName(abc, "GearType");
  if (classIndex === null) {
    throw new Error("Could not find GearType class.");
  }

  const methodIdx = methodIdxForTrait(abc.instances[classIndex].traits, abc, "method_121");
  if (methodIdx === null) {
    throw new Error("Could not find GearType.method_121.");
  }

  const methodBody = abc.methodBodies.get(methodIdx);
  if (!methodBody) {
    throw new Error(`Could not find method body for GearType.method_121 (${methodIdx}).`);
  }

  const code = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
  const instructions = disassemble(code, `GearType.method_121:${methodIdx}`);
  return { ctx, methodBody, instructions };
}

function findTooltipSubtract(instructions: Instruction[]): number | null {
  for (let index = 0; index < instructions.length - 3; index += 1) {
    if (
      localIndex(instructions[index]) === 7 &&
      localIndex(instructions[index + 1]) === 8 &&
      instructions[index + 2].opcode === 0xa1 &&
      instructions[index + 3].opcode === 0x48
    ) {
      return index + 1;
    }
  }
  return null;
}

function findDirectTooltipReturn(instructions: Instruction[]): number | null {
  for (let index = 0; index < instructions.length - 3; index += 1) {
    if (
      localIndex(instructions[index]) === 7 &&
      instructions[index + 1].opcode === 0x2a &&
      instructions[index + 2].opcode === 0x29 &&
      instructions[index + 3].opcode === 0x02 &&
      instructions[index + 4]?.opcode === 0x48
    ) {
      return index + 1;
    }
  }
  return null;
}

export function patchSwf(swfPath: string, verify: boolean, mode: TooltipStatMode): void {
  const { ctx, methodBody, instructions } = getGearTypeMethod121(swfPath);
  const subtractIndex = findTooltipSubtract(instructions);
  const directReturnIndex = findDirectTooltipReturn(instructions);

  if (mode === "original") {
    if (subtractIndex !== null) {
      console.log(`${swfPath}: already original (gear tooltips subtract baseline stat values).`);
      return;
    }
    if (directReturnIndex === null) {
      throw new Error("Could not find GearType.method_121 applied tooltip bytecode.");
    }

    if (verify) {
      throw new Error(`${swfPath}: verify failed; gear tooltips still show applied stat values.`);
    }

    const dup = instructions[directReturnIndex];
    const pop = instructions[directReturnIndex + 1];
    const nop = instructions[directReturnIndex + 2];
    if (dup.size + pop.size + nop.size !== 3) {
      throw new Error("Unexpected GearType.method_121 applied byte width.");
    }

    ensureBackup(swfPath);
    const patchOffset = methodBody.codeStart + dup.offset;
    ctx.body[patchOffset] = 0x62; // getlocal
    ctx.body[patchOffset + 1] = 0x08; // local 8: hidden baseline stat value
    ctx.body[patchOffset + 2] = 0xa1; // subtract
    writeSwf(ctx, ctx.body, 0);
    console.log(`${swfPath}: restored original gear tooltip stat values.`);
    return;
  }

  if (directReturnIndex !== null) {
      console.log(`${swfPath}: already patched (gear tooltips show applied stat values).`);
      return;
  }
  if (subtractIndex === null) {
    throw new Error("Could not find GearType.method_121 tooltip subtraction bytecode.");
  }

  if (verify) {
    throw new Error(`${swfPath}: verify failed; gear tooltips still subtract hidden baseline stat values.`);
  }

  const getLocal8 = instructions[subtractIndex];
  const subtract = instructions[subtractIndex + 1];
  if (getLocal8.size + subtract.size !== 3) {
    throw new Error("Unexpected GearType.method_121 subtraction byte width.");
  }

  ensureBackup(swfPath);
  const patchOffset = methodBody.codeStart + getLocal8.offset;
  ctx.body[patchOffset] = 0x2a; // dup
  ctx.body[patchOffset + 1] = 0x29; // pop
  ctx.body[patchOffset + 2] = 0x02; // nop
  writeSwf(ctx, ctx.body, 0);
  console.log(`${swfPath}: patched gear tooltip stat values.`);
}

if (require.main === module) {
  const { swfPath, verify, mode } = parseArgs(process.argv);
  patchSwf(swfPath, verify, mode);
}
