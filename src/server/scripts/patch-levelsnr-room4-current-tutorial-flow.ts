import * as path from "path";
import {
  classIndexByName,
  defaultLevelsNrPath,
  disassemble,
  methodIdxForTrait,
  parseAbc,
  parseSwf,
  PatchError,
  u30OperandName,
} from "./swfPatchUtils";

const CLASS_NAME = "a_Room_Tutorial_04";

function argumentPath(): string {
  const index = process.argv.indexOf("--swf-path");
  return index >= 0 && process.argv[index + 1]
    ? path.resolve(process.argv[index + 1])
    : defaultLevelsNrPath();
}

function methodNames(abc: ReturnType<typeof parseAbc>, ctx: ReturnType<typeof parseSwf>, name: string): Set<string> {
  const classIndex = classIndexByName(abc, CLASS_NAME);
  if (classIndex === null) throw new PatchError(`${CLASS_NAME} class not found`);
  const methodIndex = methodIdxForTrait(abc.instances[classIndex].traits, abc, name);
  const body = methodIndex === null ? undefined : abc.methodBodies.get(methodIndex);
  if (!body) throw new PatchError(`${CLASS_NAME}.${name} body not found`);
  return new Set(disassemble(ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen), name)
    .filter((instruction) => [0x2c, 0x46, 0x4f, 0x61, 0x66].includes(instruction.opcode))
    .map((instruction) => u30OperandName(instruction, instruction.opcode === 0x2c ? abc.stringValues : abc.multinameNames) || ""));
}

function requireNames(names: Set<string>, method: string, expected: string[]): void {
  for (const name of expected) {
    if (!names.has(name)) throw new PatchError(`${CLASS_NAME}.${method} is missing ${name}`);
  }
}

try {
  const ctx = parseSwf(argumentPath());
  const abc = parseAbc(ctx);
  requireNames(methodNames(abc, ctx, "WaitingForJump"), "WaitingForJump", ["am_Trigger_Fall2", "BeginJumpTracking", "CompleteJumpTutorial", "jumpCompleted"]);
  requireNames(methodNames(abc, ctx, "WaitingForDrop"), "WaitingForDrop", ["dropPhaseState", "COMPLETE_DROPPING", "CompleteDroppingTutorial", "dropCompleted"]);
  console.log("Verified current Room 4 jump/drop tutorial state machine.");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
