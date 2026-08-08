# Client patch static-recovery and runtime-validation plan

## Purpose

This plan records the work that remains after static recovery of AUD-018 client assets. It separates deterministic asset checks from the behavior that can only be proved with a real Flash-compatible client.

## Completed without a Flash client

- Recovered and structurally verified 14 compatible `DungeonBlitz.swf` patches. Their scripts and the served asset digest are recorded in `src/server/tools/client-patch-provenance.json`.
- Replaced the client-patch failure allowlist with `client-patch-baseline.json`, a non-authoritative triage ledger. Missing patches always fail `verifyClientPatches.js`.
- Required FFDec in CI and added a digest/provenance check to detect a rebuilt or replaced SWF before release.

## Deferred: Forge tutorial persistence

`patch-dungeonblitz-forge-tutorial-persistence.ts` must **not** be applied to the served SWF until the following manual validation is complete. Static analysis can prove the ABC structure but cannot prove that the AVM2 player accepts it while entering a world.

1. Start from a clean Flash Projector/debug-player profile with no existing `dbSavedGameData` SharedObject.
2. Apply the candidate patch to a disposable `DungeonBlitz.swf` and run its `--verify` check.
3. Enter a world, complete the Forge interactive tutorial, and confirm there is no disconnect, AVM2 verification exception, or corrupted UI.
4. Exit fully, restart the client, re-enter the same character, and confirm the tutorial remains complete.
5. Repeat with an existing `dbSavedGameData` object and with two characters to prove the value is neither rejected nor shared incorrectly.
6. Capture projector/debug logs, the candidate SHA-256, and a short reproduction record. Only then promote the binary, update provenance, and remove this entry from `pendingDefects`.

## Static compatibility follow-up

The Room 4 legacy scripts are superseded by `patch-levelsnr-room4-current-tutorial-flow.ts`, which structurally verifies the shipped jump/drop state machine. Story Zone Locks remains the only static blocker; Forge persistence remains runtime-only.

| Patch | Current static evidence | Next action |
| --- | --- | --- |
| `patch-dungeonblitz-story-zone-locks.js` | FFDec exports `class_119`, but the expected mission-loop source text is absent. | Compare the current decompile with the intended story-lock behavior; update the source transform and add a focused structural verifier. |

## Release rule

`REQUIRE_FFDEC=1 npm run verify:client-patches` and `npm run verify:client-patch-provenance` must both pass before release. Story Zone Locks and Forge persistence remain release blockers until resolved with current-asset evidence. A script may be marked superseded only when its replacement is tracked, its verifier passes, and the ledger names that replacement.
