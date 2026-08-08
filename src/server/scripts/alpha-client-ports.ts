import * as crypto from "crypto";
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
  writeSwf,
  writeU30,
} from "./swfPatchUtils";

/**
 * Re-points the client's game-server socket at the alpha port.
 *
 * The Flash client connects to the game socket on a hardcoded port (8080) that lives as a
 * single `pushshort 8080` operand inside `m1516` (the only occurrence of 8080 in the whole
 * SWF). The alpha environment runs on 8082, so this patch rewrites that one operand. The
 * policy port is left alone: Flash requests the socket policy from the default port 843, and
 * the production policy server answers `<allow-access-from domain="*" to-ports="1-65535"/>`,
 * so the alpha socket is covered.
 *
 * Only the operand byte(s) change (u30 keeps the same length for 8080 -> 8082), so the ABC
 * and the SWF body keep their exact size. `--verify` confirms the alpha port is in place.
 *
 * Usage:
 *   npx tsx src/server/scripts/alpha-client-ports.ts [--verify] [--swf <path>]
 */
const DEFAULT_SWF = path.resolve(
  __dirname, "..", "..", "client", "content", "localhost", "p", "cbp", "DungeonBlitz.swf",
);
const INDEX_HTML = path.resolve(
  __dirname, "..", "..", "client", "content", "localhost", "index.html",
);

const METHOD_INDEX = 1516;
const INSTRUCTION_OFFSET = 497;
const FROM_PORT = 8080;
const TO_PORT = 8082;

function syncClientRev(swfPath: string): void {
  if (path.resolve(swfPath) !== DEFAULT_SWF || !fs.existsSync(INDEX_HTML)) return;
  const digest = crypto.createHash("sha1").update(fs.readFileSync(swfPath)).digest("hex").slice(0, 12);
  const html = fs.readFileSync(INDEX_HTML, "utf8");
  const updated = html.replace(/clientrev=[^&`"'$]+/, `clientrev=swf-${digest}`);
  if (updated !== html) {
    fs.writeFileSync(INDEX_HTML, updated);
    console.log(`  index.html clientrev -> swf-${digest} (alpha cache buster)`);
  }
}

function findPortOperand(instructions: Instruction[]): number {
  for (const instruction of instructions) {
    if (instruction.opcode !== 0x25) continue; // pushshort
    if (instruction.offset !== INSTRUCTION_OFFSET) continue;
    const [kind, value] = instruction.operands[0] ?? [];
    if (kind !== "u30") continue;
    return value;
  }
  throw new PatchError(`m${METHOD_INDEX} pushshort @${INSTRUCTION_OFFSET} not found`);
}

function currentPort(swfPath: string): number {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);
  const body = abc.methodBodies.get(METHOD_INDEX);
  if (!body) throw new PatchError(`m${METHOD_INDEX} has no body`);
  const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
  const instructions = disassemble(code, `m${METHOD_INDEX}`);
  return findPortOperand(instructions);
}

function patchSwf(swfPath: string, verifyOnly: boolean): void {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);
  const body = abc.methodBodies.get(METHOD_INDEX);
  if (!body) throw new PatchError(`m${METHOD_INDEX} has no body`);

  const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
  const instructions = disassemble(code, `m${METHOD_INDEX}`);

  const target = instructions.find((instruction) => instruction.opcode === 0x25 && instruction.offset === INSTRUCTION_OFFSET);
  if (!target) throw new PatchError(`m${METHOD_INDEX} pushshort @${INSTRUCTION_OFFSET} not found`);

  const [kind, value] = target.operands[0] ?? [];
  if (kind !== "u30") throw new PatchError(`m${METHOD_INDEX} operand is not u30`);

  if (value === TO_PORT) {
    console.log(`Game server port already patched to ${TO_PORT} (alpha).`);
    if (!verifyOnly) syncClientRev(swfPath);
    return;
  }
  if (value !== FROM_PORT) {
    throw new PatchError(`m${METHOD_INDEX} pushshort @${INSTRUCTION_OFFSET} is ${value}, expected ${FROM_PORT}`);
  }
  if (verifyOnly) throw new PatchError(`m${METHOD_INDEX} still carries the ${FROM_PORT} game port`);

  const operandStart = body.codeStart + target.offset + 1;
  const operandEnd = operandStart + (target.size - 1);
  const newOperand = writeU30(TO_PORT);

  const patches: BytePatch[] = [
    {
      key: "alpha_ports.game_port",
      start: operandStart,
      end: operandEnd,
      data: newOperand,
      detail: `pushshort ${FROM_PORT} -> ${TO_PORT}`,
    },
  ];

  const { body: patchedBody, delta } = applyPatchesToBody(ctx.body, patches);

  ensureBackup(swfPath);
  writeSwf(ctx, patchedBody, delta);

  const after = currentPort(swfPath);
  if (after !== TO_PORT) throw new PatchError(`Port patch did not take (now ${after})`);

  console.log(`Patched ${path.basename(swfPath)}: game port ${FROM_PORT} -> ${TO_PORT}.`);
  syncClientRev(swfPath);
}

function main(): void {
  const args = process.argv.slice(2);
  const verifyOnly = args.includes("--verify");
  const swfIndex = args.indexOf("--swf");
  const swfPath = swfIndex >= 0 ? path.resolve(process.cwd(), args[swfIndex + 1]) : DEFAULT_SWF;
  patchSwf(swfPath, verifyOnly);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[alpha-client-ports] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
