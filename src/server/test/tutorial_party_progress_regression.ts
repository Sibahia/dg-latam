/// <reference types="node" />

import { strict as assert } from "assert";
import { spawnSync } from "child_process";
import * as path from "path";

const serverRoot = path.resolve(__dirname, "..");
const script = path.join(
  serverRoot,
  "scripts",
  "patch-dungeonblitz-tutorial-party-progress.js",
);

const verification = spawnSync(process.execPath, [script, "--verify"], {
  cwd: serverRoot,
  encoding: "utf8",
  env: process.env,
});

assert.equal(
  verification.status,
  0,
  `Tutorial party-progress verification failed:\n${verification.stdout}${verification.stderr}`,
);
console.log("tutorial_party_progress_regression: ok");
