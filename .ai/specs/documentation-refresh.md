# Documentation refresh specification

## Goal

Make repository documentation sufficient for a new local player, a self-hosting operator, a security reporter, and an optional Discord bridge developer without requiring them to infer behavior from source code.

## Requirements

- Keep user-facing documentation in English and distinguish local-only workflows from multiplayer/production workflows.
- Document only commands, paths, ports, environment variables, and behavior supported by the current repository.
- Explain persistence, dependencies, security boundaries, limitations, and troubleshooting where relevant.
- Keep `docs/` public/operator-facing and `.ai/` internal to AI-assisted SDD work.
- Preserve accurate fan-project, asset, and licensing disclaimers.
- Do not expose secrets or imply that unimplemented hardening is present.

## Affected documents

- `README.md`
- `docs/HOSTING.md`
- `docs/SECURITY.md`
- `src/server/native_bridge/README.md`

## Acceptance criteria

- A local player can install prerequisites, start the game, create or seed a character, find saves, and diagnose common startup failures.
- An operator can identify required services, persisted paths, exposed ports, relevant environment configuration, and the distinction between development/local and production hosting.
- A reporter can submit a private vulnerability report with the needed information and understand supported-version expectations.
- A bridge developer can identify the architecture, prerequisites, configuration, build path, current limitations, and safe troubleshooting checks.

## Outcome

All acceptance criteria were addressed in the repository documentation refresh. Validation covered local Markdown links, referenced paths, package scripts, container entrypoint behavior, persistence paths, and the current configuration defaults.
