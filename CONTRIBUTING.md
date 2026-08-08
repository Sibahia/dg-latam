# Contributing to Dungeon Blitz R

Thanks for helping improve Dungeon Blitz R. This project restores and maintains a legacy Flash game client with a Node.js/TypeScript server, so small, well-tested changes are much easier to review and safer for players than broad rewrites.

## Before you begin

- Read the [README](README.md) to set up a local game session.
- Read [AGENTS.md](AGENTS.md) for repository rules, versioning, and the AI-assisted workflow.
- Read [SKILL.md](SKILL.md) before changing gameplay, cutscenes, combat, dungeon sequencing, display scaling, or client patches.
- For hosting, Discord Social SDK, or security-sensitive work, also read the relevant guide in [docs](docs/) or [`src/server/native_bridge`](src/server/native_bridge/README.md).

Use a dedicated local account and saves for development. Never test against another player's account or a public server you do not control.

## Choose the right scope

- Fix the smallest code path that explains the problem. Preserve original gameplay and client-protocol behavior unless the change intentionally updates it.
- Add or update a focused regression for server, protocol, persistence, gameplay, and client-patch defects.
- Keep player-facing localization data intact unless the contribution is specifically about localization.
- Do not directly edit `dist/`, `node_modules/`, generated save data, or served SWF/SWZ binaries. Change TypeScript source, canonical data, or a verified patch script instead.
- Use `.ai/plans/` and `.ai/specs/` for multi-step, cross-system, security-sensitive, or behavior-changing specification-driven work. Keep routine, single-file maintenance concise.

## Local development

Enable pnpm through Corepack and install the workspace dependencies from the repository root:

```bash
corepack enable pnpm
pnpm install --frozen-lockfile
```

Start the local development session:

```bash
pnpm run dev
```

The development server binds to `127.0.0.1`, uses JSON persistence, disables multiplayer mode, and normally serves the client at `http://localhost:8000/`.

## Verification

Run the checks that prove your change. At minimum, review the diff and run:

```bash
git diff --check
pnpm --filter server run typecheck
```

Use additional checks when their scope applies:

```bash
# All server regression tests
pnpm --filter server run test:regression

# Scripted client-patch validation
pnpm run verify:client-patches

# Production server build
pnpm run build
```

For gameplay changes, test the affected state transitions rather than only compilation. Depending on the change, that can include windowed and fullscreen play, solo and party sessions, dungeon cutscenes, boss visibility/targetability, reconnects, and persistence after restart.

If a required check cannot run, say why in the pull request and provide the strongest available alternative evidence.

## Pull requests

Keep each pull request focused. Explain:

1. The problem or player/operator need.
2. The cause or relevant behavior.
3. The change and any compatibility impact.
4. Tests and manual verification performed.
5. Known limitations or follow-up work.

Use the repository pull-request template. Do not include unrelated formatting, generated files, credentials, player data, or local save files.

Every committed change requires a semantic-version bump, synchronized across the root and `src/server` manifests/lockfiles:

- `patch` for compatible fixes, documentation, data, tooling, and maintenance.
- `minor` for compatible gameplay, server, client, or substantial content features.
- `major` for breaking protocol, save-data, deployment, or gameplay-contract changes.

Do not create a commit unless the maintainer or task explicitly calls for one. When preparing a commit, include the version bump in that same change.

## Security and privacy

Report vulnerabilities privately using the process in [docs/SECURITY.md](docs/SECURITY.md). Do not open public issues for vulnerabilities or publish exploit details, tokens, credentials, account files, character saves, logs with player data, or Discord cache files.

The current multiplayer stack is for trusted testing while security hardening continues. Do not use a contribution to test against untrusted players or publicly expose a server without the maintainers' explicit direction.

## License and assets

Contributions to the repository's original code and modifications are provided under the [GNU GPL v3.0](LICENSE). Original Dungeon Blitz assets, trademarks, artwork, audio, characters, and other intellectual property remain with their respective owners.
