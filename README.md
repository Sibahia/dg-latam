# Dungeon Blitz R

Dungeon Blitz R is an open-source fan restoration project for the original Dungeon Blitz experience. It provides a local game server, restored client assets, gameplay fixes, optional Discord integrations, and work in progress toward multiplayer support.

> **Project status:** local play is the supported starting point. Multiplayer and hosting are advanced workflows; read [Hosting](docs/HOSTING.md) and [Security](docs/SECURITY.md) before exposing a server to anyone else.

## What you need

- [Node.js 22 LTS](https://nodejs.org/) (the production container uses Node 22). `node` and Corepack must be available on your `PATH`; enable the bundled pnpm shim once with `corepack enable pnpm`.
- A Flash-capable browser or standalone player. The launchers support [FlashBrowser](https://github.com/radubirsan/FlashBrowser/releases/tag/v0.8); modern browsers no longer run Flash content.
- Git is recommended. The macOS and Windows launchers use it to update the checkout, but manual local play does not require it after the repository is available.

## Quick start: local play

Clone or download this repository, then use the launcher for your platform:

| Platform | Start command | What it does |
| --- | --- | --- |
| macOS | Double-click `dev-mac.command`, or run `./dev-mac.command` in Terminal | Updates the checkout when Git is available, installs dependencies, starts the local server, and opens FlashBrowser when ready. |
| Windows | Double-click `dev-windows.bat` | Performs the equivalent local setup and prints the Flash player/browser URLs. |

The launchers may stash local changes, including untracked files, before pulling updates. If a stash needs attention, inspect it with `git stash list` and restore it with `git stash pop`.

Keep the launcher window open while playing. Closing it stops the server.

### Manual start

From the repository root:

```bash
corepack enable pnpm
pnpm install --frozen-lockfile
pnpm run dev
```

Open `http://localhost:8000/` in your Flash-capable browser after the server is listening. The local development command deliberately binds to loopback, uses JSON storage, and disables multiplayer mode.

## Accounts, characters, and backups

For local play, create an account from the login screen. Account data and character saves are stored only on your computer:

- `src/server/data/Accounts.json` — local account records
- `src/server/data/saves/` — character-save files

Both locations are ignored by Git. They will not be included in normal commits or repository updates, but they are still your responsibility to back up. Stop the server before copying them, and never share account files or save data publicly.

If you configure MongoDB for a multiplayer-oriented environment, persistence moves to the configured Mongo database instead. See [Hosting](docs/HOSTING.md) before changing storage settings.

## Local playtest account

The optional seeder creates `test@theminesa.studio` with six characters: a level-50 and a level-1 Mage, Paladin, and Rogue.

```bash
cd src/server
pnpm --filter server run seed:test-account
```

The default password is `testtest`. Set `TEST_ACCOUNT_PASSWORD` to use a different local password:

```bash
TEST_ACCOUNT_PASSWORD='choose-a-local-password' pnpm --filter server run seed:test-account
```

Re-running the seeder replaces those six test characters. It refuses to run with `MULTIPLAYER_MODE` enabled because its known credentials and all-unlock characters are intended for local testing only.

## Common problems

| Symptom | What to check |
| --- | --- |
| `node` or `pnpm` is not found | Install Node.js 22 LTS, reopen the terminal, then run `corepack enable pnpm`. |
| The game page opens but the game is blank | Use FlashBrowser or another Flash-capable player; modern browsers cannot run the client. |
| `EADDRINUSE` or the server says a port is already in use | Stop the previous server, or choose another `STATIC_PORT`. Local HTTP defaults to `8000`; the game TCP port defaults to `8080`. |
| The launcher cannot update | Check your network and Git installation. You can still start the current checkout manually. |
| A launcher update leaves a stash or reports a conflict | Run `git stash list`, resolve any conflict in the checkout, then restore the stash only after checking the changed files. |
| A local session crashes | Check the newest file in `src/server/logs/` for the development session log and include the relevant excerpt in a bug report. |

## For contributors

Run these commands from the indicated directory:

```bash
# Type-check the server
pnpm --filter server run typecheck

# Run all server regressions
pnpm --filter server run test:regression

# Verify scripted client patches
pnpm run verify:client-patches

# Compile the production server output
pnpm run build
```

Keep changes focused and include a regression when fixing server, protocol, gameplay, or client-patch behavior. Read the full [contribution guide](CONTRIBUTING.md), [AGENTS.md](AGENTS.md) for repository workflow, and [SKILL.md](SKILL.md) for gameplay-specific debugging guidance.

## Alpha and stable environments

The project runs two live environments from the same repository:

| | Stable (`main`) | Alpha (`alpha`) |
|---|---|---|
| URL | `https://dgblitzlatam.duckdns.org` | `https://alpha.dgblitzlatam.duckdns.org` |
| Container | `dungeon-blitz-r` | `dungeon-blitz-r-alpha` |
| Ports | 80 / 8080 / 843 | 8081 / 8082 / 844 |
| Mongo DB | `dungeonblitz` | `dungeonblitz_alpha` |
| Client game port | 8080 | 8082 (patched SWF) |
| Deploy trigger | push to `main` | push to `alpha` |

Workflow:

1. **Daily changes** land on `alpha` (PRs target `alpha`). Pushing to `alpha` builds a `:alpha` image with the client game-port patch (`alpha-client-ports.ts`, 8080 → 8082) and deploys it to the isolated alpha container via `Container/deploy-alpha.sh`. A few testers validate there.
2. **Promotion**: when the alpha build is validated, open a PR `alpha` → `main` (squash) with the version bump. That deploys to the stable container. **`main` never receives untested feature changes directly**, and alpha activity never restarts or touches the stable container, its ports, its Mongo DB, or its image tag (`latest`).

Operations:

- `alpha` uses its own checkout `/opt/dungeon-blitz-r-alpha` (git branch `alpha`) so the stable checkout `/opt/dungeon-blitz-r` stays on `main`.
- The alpha Mongo DB is a clone of production (`src/server/tools/cloneAlphaDb.sh`); it evolves independently and can be re-cloned on demand.
- The alpha admin panel runs separately on port 8789 (`https://alpha.dgblitzlatam.duckdns.org/admin`), authenticating against the alpha DB.
- `alpha-client-ports.ts` changes only the game-server port in the client SWF (the single `pushshort 8080` operand in `m1516`). The policy port stays on Flash's default 843, which the production policy server answers permissively. It is an alpha-environment, deploy-time patch, so it is intentionally not part of the served-asset `verify:client-patches` gate.

## More documentation

- [Hosting and operations](docs/HOSTING.md)
- [Security policy and deployment boundaries](docs/SECURITY.md)
- [Optional Discord Social SDK bridge](src/server/native_bridge/README.md)
- [Contributing](CONTRIBUTING.md)
- [Project wiki](https://github.com/theminesastudios/dungeon-blitz-r/wiki/How-to-play-Dungeon-Blitz) — community walkthroughs and additional project material

## License and original assets

The original code and modifications in this repository are licensed under the [GNU General Public License v3.0](LICENSE). Dungeon Blitz and its original assets, artwork, audio, characters, trademarks, and other intellectual property remain the property of their respective owners. This is a fan-made restoration project and is not affiliated with the original rights holders.
