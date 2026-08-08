import * as fs from "fs";
import * as path from "path";
import {
  applyPatchesToBody,
  BytePatch,
  classIndexByName,
  disassemble,
  ensureBackup,
  methodIdxForTrait,
  parseAbc,
  parseSwf,
  PatchError,
  u30OperandName,
  writeSwf,
  writeU30,
} from "./swfPatchUtils";

const DEFAULT_SWF_CANDIDATES = [
  path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p", "cbp", "DungeonBlitz.swf"),
  path.resolve(__dirname, "..", "..", "..", "client", "content", "localhost", "p", "cbp", "DungeonBlitz.swf"),
];
const DEFAULT_SWF = DEFAULT_SWF_CANDIDATES.find((candidate) => fs.existsSync(candidate)) ?? DEFAULT_SWF_CANDIDATES[0];
const PING_PREFIX = "/ping";

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
        "  ts-node src/server/scripts/patch-dungeonblitz-chat-ping-pcode.ts [--verify] [--swf <path>]",
        "",
        "Adds /ping passthrough to class_127.method_1940 with a surgical AVM2 patch.",
      ].join("\n"));
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { swfPath, verify };
}

function writeS24(value: number): Buffer {
  if (value < -0x800000 || value > 0x7fffff) {
    throw new PatchError(`s24 branch offset out of range: ${value}`);
  }
  const encoded = value < 0 ? value + 0x1000000 : value;
  const out = Buffer.alloc(3);
  out.writeUIntLE(encoded, 0, 3);
  return out;
}

function findMethod(swfPath: string) {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);
  const classIndex = classIndexByName(abc, "class_127");
  if (classIndex === null) {
    throw new PatchError("class_127 not found");
  }
  const methodIdx = methodIdxForTrait(abc.instances[classIndex].traits, abc, "method_1940");
  if (methodIdx === null) {
    throw new PatchError("class_127.method_1940 not found");
  }
  const methodBody = abc.methodBodies.get(methodIdx);
  if (!methodBody) {
    throw new PatchError("class_127.method_1940 has no method body");
  }
  const code = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
  const instructions = disassemble(code, "class_127.method_1940");
  return { ctx, abc, methodBody, instructions };
}

function hasPingGuard(swfPath: string): boolean {
  const { abc, instructions } = findMethod(swfPath);
  return instructions.some((inst, index) => {
    if (inst.opcode !== 0x2c || inst.operands[0]?.[0] !== "u30") {
      return false;
    }
    const stringIndex = inst.operands[0][1];
    if (abc.stringValues[stringIndex] !== PING_PREFIX) {
      return false;
    }
    const call = instructions[index + 1];
    return call?.opcode === 0x46 && u30OperandName(call, abc.multinameNames) === "indexOf";
  });
}

function patchSwf(swfPath: string, verify: boolean): void {
  if (hasPingGuard(swfPath)) {
    console.log("Chat /ping passthrough patch verified.");
    return;
  }
  if (verify) {
    throw new PatchError("Chat /ping passthrough patch is missing");
  }

  const { ctx, abc, methodBody, instructions } = findMethod(swfPath);
  if (abc.stringValues.includes(PING_PREFIX)) {
    throw new PatchError("Unexpected pre-existing /ping string outside method_1940");
  }

  const returnInstruction = instructions[instructions.length - 1];
  if (!returnInstruction || returnInstruction.opcode !== 0x48) {
    throw new PatchError("method_1940 does not end with returnvalue");
  }

  const indexOfInstruction = [...instructions].reverse().find(
    (inst) => inst.opcode === 0x46 && u30OperandName(inst, abc.multinameNames) === "indexOf",
  );
  if (!indexOfInstruction || indexOfInstruction.operands[0]?.[0] !== "u30") {
    throw new PatchError("method_1940 indexOf multiname was not found");
  }

  const pingStringIndex = abc.stringCount;
  const pingString = Buffer.from(PING_PREFIX, "utf8");
  const callIndexOf = Buffer.concat([
    Buffer.from([0x46]),
    writeU30(indexOfInstruction.operands[0][1]),
    writeU30(1),
  ]);
  const predicate = Buffer.concat([
    Buffer.from([0x2a, 0x11]),
    Buffer.alloc(3),
    Buffer.from([0x29, 0xd2, 0x2c]),
    writeU30(pingStringIndex),
    callIndexOf,
    Buffer.from([0x24, 0x00, 0xab, 0x76]),
  ]);
  writeS24(predicate.length - 5).copy(predicate, 2);

  const patches: BytePatch[] = [
    {
      key: "abc.stringCount",
      start: abc.stringCountPos,
      end: abc.stringCountPos + writeU30(abc.stringCount).length,
      data: writeU30(abc.stringCount + 1),
      detail: "add the /ping constant-pool entry",
    },
    {
      key: "abc.pingString",
      start: abc.stringPoolEnd,
      end: abc.stringPoolEnd,
      data: Buffer.concat([writeU30(pingString.length), pingString]),
      detail: "append the /ping constant-pool string",
    },
    {
      key: "method_1940.codeLength",
      start: methodBody.codeLenPos,
      end: methodBody.codeStart,
      data: writeU30(methodBody.codeLen + predicate.length),
      detail: "extend method_1940 for the /ping predicate",
    },
    {
      key: "method_1940.pingPredicate",
      start: methodBody.codeStart + returnInstruction.offset,
      end: methodBody.codeStart + returnInstruction.offset,
      data: predicate,
      detail: "append /ping to the passthrough OR chain",
    },
  ];

  const branchesToReturn = instructions.filter((inst) =>
    inst.opcode === 0x11 &&
    inst.operands[0]?.[0] === "s24" &&
    inst.offset + inst.size + inst.operands[0][1] === returnInstruction.offset
  );
  if (branchesToReturn.length !== 1) {
    throw new PatchError(`Expected one method_1940 branch to returnvalue, found ${branchesToReturn.length}`);
  }
  for (const branch of branchesToReturn) {
    patches.push({
      key: `method_1940.returnBranch.${branch.offset}`,
      start: methodBody.codeStart + branch.offset + 1,
      end: methodBody.codeStart + branch.offset + 4,
      data: writeS24(branch.operands[0][1] + predicate.length),
      detail: "retarget the final OR short-circuit around the /ping predicate",
    });
  }

  ensureBackup(swfPath);
  const { body, delta } = applyPatchesToBody(ctx.body, patches);
  writeSwf(ctx, body, delta);

  if (!hasPingGuard(swfPath)) {
    throw new PatchError("Chat /ping passthrough patch did not verify after write");
  }
  console.log("Chat /ping passthrough patch applied.");
}

const args = parseArgs(process.argv);
patchSwf(args.swfPath, args.verify);
