# Dungeon Blitz R — Agent Instructions

## Authority and objectives

- This repository restores and maintains the Dungeon Blitz experience. Preserve original gameplay, client compatibility, and multiplayer correctness while fixing defects at their source.
- `README.md` describes how the project is run. `CONTRIBUTING.md` defines the contributor workflow. `SKILL.md` contains domain-specific debugging rules for gameplay, cutscenes, display state, and dungeon sequencing. Read the relevant guides before making a change.
- There is no `PRODUCT.md`, Cargo workspace, Astro site, Docusaurus site, or per-component `ARCHITECTURE.md` in this repository. Do not assume those files or workflows exist.
- These instructions are authoritative when they conflict with legacy guidance elsewhere in the repository.

## Repository layout

- `src/server/` — primary Node.js/TypeScript game server.
  - `auth/`, `core/`, `handlers/`, `network/` — protocol, session, gameplay, combat, dungeon, and server-authority logic.
  - `database/` — JSON and Mongo game-data persistence.
  - `data/` — canonical gameplay data and localization loaders. Treat large JSON files as data, not documentation.
  - `integrations/` — Discord, presence, maintenance, and admin integrations.
  - `scripts/` — controlled SWF/SWZ patch tooling. Each patch must remain verifiable.
  - `test/` — regression tests, executed by the custom test runner.
  - `tools/` — development, migration, client-patch verification, admin-panel, and deployment utilities.
  - `native_bridge/` — C++ Discord Social SDK bridge; build rules and limits are documented in its `README.md`.
- `src/client/content/` — client-side game assets and XML content. Do not casually reformat, regenerate, or translate gameplay text here.
- `Container/` — production container and deployment scripts.
- `docs/` — operator and security documentation.
- `.ai/` — internal documents produced by AI-assisted, specification-driven development (SDD). Keep plans in `.ai/plans/`, implementation specifications in `.ai/specs/`, and requested reviews/audits in `.ai/audits/`.
- Root `package.json` orchestrates server commands; `src/server/package.json` owns the server build, tests, and tooling.

## AI documentation and SDD workflow

Use `.ai/` for internal planning and review artifacts. It is separate from public/operator documentation in `docs/`.

- For a multi-step, cross-system, security-sensitive, or behavior-changing task, the Terra orchestrator creates or updates a concise plan in `.ai/plans/<descriptive-slug>.md` before implementation.
- Create `.ai/specs/<descriptive-slug>.md` when the task needs an implementation contract: a new feature, protocol or persistence change, client-patch work, or a change with meaningful gameplay/design decisions. The specification should define scope, invariants, affected files/systems, acceptance criteria, and verification.
- Write `.ai/audits/<descriptive-slug>.md` only for an explicitly requested audit, code review, security review, or post-implementation assessment. Record evidence, findings, severity where applicable, and remaining risks.
- Keep each document English, scoped to one task, and named clearly enough to locate by topic. Preserve existing AI documents; do not overwrite or delete them merely to start a new task.
- Link or name the relevant plan/spec in implementation notes, and update its status or outcome after verification. Small, routine, single-file maintenance may use the task conversation alone rather than creating SDD artifacts.

## Agent orchestration

The main agent is the orchestrator. Use **Terra 5.6** as the orchestrator model and **Luna 5.6** as the implementation-subagent model.

- The Terra orchestrator owns repository inspection, task decomposition, dependency ordering, integration, verification, and final reporting.
- Delegate bounded implementation work to dynamically created Luna 5.6 subagents, one independent unit of work per subagent. End a subagent when its unit is complete; do not keep idle agents resident.
- Before implementation, each subagent must read this file, `SKILL.md`, and the relevant module, tests, and package scripts. For gameplay/client work, it must also read the applicable sections of `README.md` and `src/server/native_bridge/README.md` when relevant.
- Parallelize only independent scopes with no overlapping files or shared runtime/state assumptions. Serialize changes that cross client patches, wire protocol, entity lifecycle, persistence, shared dungeon state, or package versions.
- Reuse a subagent session only for follow-up work on the same bounded unit. Give review feedback to the original implementer when that avoids rediscovering context.
- Planning is required for multi-step, cross-system, security-sensitive, or behavior-changing work; store the resulting plan in `.ai/plans/` and create a corresponding `.ai/specs/` document when the SDD criteria apply.
- Run an audit/review subagent only when the user explicitly requests an audit, code review, or security review. Do not create audit documents by default.
- The orchestrator must review every delegated diff, resolve integration conflicts, and run the final verification. A subagent report is evidence, not completion by itself.

## Core engineering rules

- Prefer small, targeted, reversible fixes. Do not rewrite a working subsystem without evidence that a broader change is necessary.
- Preserve original gameplay behavior and client protocol expectations. Never hide a crash, skip frames, broadly swallow errors, or force entity state merely to suppress a symptom.
- Keep server authority on the server. Do not trust client-supplied identity, movement, damage, rewards, entity lifecycle, progression, or persistence state without explicit validation and an authoritative source.
- Treat session tokens, account linking, admin APIs, Discord integration, environment variables, and save data as security-sensitive. Maintain authentication, ownership, bounds, rate, and lifecycle checks when modifying them.
- Keep fullscreen/UI scaling separate from world and combat state. Display fixes must not change entity ownership, room assignment, HP/death state, targetability, or dungeon progression.
- Preserve dungeon sequencing: room scope, cutscene open/close, boss spawn/death, gates, traps, chests, and rewards must remain coherent for solo and party runs.
- Do not directly edit generated `dist/` output, `node_modules/`, save data, or binary assets unless the user explicitly requests it. Change the source or controlled patch script instead.
- Preserve localized player-facing data unless the task explicitly concerns localization. All new or edited developer comments and documentation must be English.
- Never commit secrets, `.env` files, generated build artifacts, or persistent game data. Commit only when the user explicitly asks.

## TypeScript, data, and native-bridge conventions

- Follow the existing TypeScript style and compiler settings in `src/server/tsconfig.json`. Prefer explicit, validated boundaries around packets, persistence, and untyped game data.
- Keep packet parsing and handlers defensive: validate opcode state, packet length, numeric ranges, source ownership, level/room scope, and entity lifecycle before mutating canonical state.
- When editing `src/server/data/`, retain IDs, schema shape, ordering, and localization semantics unless the task explicitly changes them. Add or update focused regression coverage for behavior derived from data.
- SWF/SWZ changes belong in a focused script under `src/server/scripts/` with a verifier/regression. Do not modify a served binary by hand or weaken `verify:client-patches` to make a change pass.
- For `src/server/native_bridge/`, preserve packet framing and newline-delimited JSON contracts. Build or test the bridge using its documented platform commands when that scope changes.

## Investigation and test workflow

For a bug fix, first reproduce or identify the failing regression, then trace the invalid state transition. Inspect the smallest relevant code path and regression before expanding scope.

Use the lightest verification that proves the change:

- Server type check: `pnpm --filter server run typecheck` from the repository root.
- Focused regression: from `src/server/`, use the same invocation as the custom runner, for example `TS_NODE_COMPILER_OPTIONS='{"types":["node"]}' node -r ts-node/register test/<name>_regression.ts`; execute JavaScript regressions with `node test/<name>_regression.js`.
- Full server regression suite: `pnpm --filter server run test:regression` from the repository root for cross-cutting gameplay, protocol, persistence, authentication, or shared-state changes.
- Client patch verification: `pnpm run verify:client-patches` from the repository root whenever `src/server/scripts/`, client assets, or patch baselines change.
- Production/server build: `pnpm run build` from the repository root when compiled output or deployment behavior is affected.

Before finalizing, inspect the diff, run `git diff --check`, and state exactly what was verified and what could not be verified. For gameplay changes, verify the relevant windowed/fullscreen, solo/party, cutscene, boss, and persistence cases rather than claiming unrelated coverage.

## Documentation and versioning

- Update `README.md`, `CONTRIBUTING.md`, `docs/`, or inline documentation whenever a user-facing run/deploy workflow, security assumption, protocol contract, or operator procedure changes.
- Every committed project change requires a semantic-version bump:
  - `patch` — bug fixes, small data/content edits, documentation, tooling, and compatible maintenance.
  - `minor` — backward-compatible gameplay, server, client, or meaningful content features.
  - `major` — breaking protocol, save-data, deployment, or gameplay-contract changes.
- Keep the root and server `package.json` versions synchronized, and keep `pnpm-lock.yaml` current, unless a change demonstrably applies to only one package.
- Do not change versions for an uncommitted edit unless the user requests a release/version bump. When preparing a commit, apply the required bump as part of that same change.
- In commit/PR/final summaries, state the selected bump level and resulting version, the behavior changed, the reason, and the verification performed.
