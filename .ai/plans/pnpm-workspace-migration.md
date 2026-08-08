# pnpm workspace migration

## Status

Implemented on 2026-08-08 as patch release 1.28.3. The workspace uses pnpm 11.9.0 and retains the existing `discord-rpc` Git-hosted optional dependency through an explicit pnpm compatibility setting and build allowlist.

## Goal

Replace the repository's separate npm installs and lockfiles with one pnpm workspace, while preserving the existing root orchestration package and server package behavior.

## Scope

- Add a root pnpm workspace and lockfile, pinned to pnpm 11.9.0 through Corepack.
- Convert development launchers, CI, container builds, project tooling, and contributor documentation to pnpm commands.
- Preserve Node 22 production support, dependency versions, gameplay behavior, and the compiled production startup path.

## Verification

- Immutable workspace install.
- Server typecheck, full regression suite, client-patch verification, and production build.
- Diff and launcher syntax checks, plus a production Docker build when Docker is available.

## Outcome

- Immutable pnpm install, server typecheck, production build, production-startup regression, JavaScript syntax checks, macOS launcher syntax, and diff validation passed.
- The full regression suite completed with four existing failures, and client-patch verification remains blocked by unavailable FFDec plus existing patch-state failures.
- Docker is installed on the host but its Linux engine was unavailable, so the production image could not be built locally.

## Alpha integration verification

- After merging `origin/alpha`, the immutable pnpm install, typecheck, and production build passed.
- The expanded regression suite passed 98 of 100 tests. The remaining failures require client-asset remediation (`forge_tutorial_persistence_regression`) and a local FFDec installation (`tutorial_party_progress_regression`).
