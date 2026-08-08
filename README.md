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

## More documentation

- [Hosting and operations](docs/HOSTING.md)
- [Security policy and deployment boundaries](docs/SECURITY.md)
- [Optional Discord Social SDK bridge](src/server/native_bridge/README.md)
- [Contributing](CONTRIBUTING.md)
- [Project wiki](https://github.com/theminesastudios/dungeon-blitz-r/wiki/How-to-play-Dungeon-Blitz) — community walkthroughs and additional project material

## License and original assets

The original code and modifications in this repository are licensed under the [GNU General Public License v3.0](LICENSE). Dungeon Blitz and its original assets, artwork, audio, characters, trademarks, and other intellectual property remain the property of their respective owners. This is a fan-made restoration project and is not affiliated with the original rights holders.
