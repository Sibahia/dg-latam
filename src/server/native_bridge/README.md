# Discord Social SDK native bridge

This optional C++ bridge connects the TypeScript game server to Discord's Social SDK. It is not required for local single-player development or ordinary server work.

The bridge can authorize a Discord user through device flow, create or join a lobby, relay public game chat to Discord, and send inbound Discord messages back to the game as status lines.

## Architecture and trust boundary

```text
Flash client -- public chat --> TypeScript game server -- JSONL/stdin --> native bridge --> Discord Social SDK
Discord Social SDK -- JSONL/stdout --> native bridge --> TypeScript game server -- status line --> online game clients
```

The bridge is a local child process. Keep its executable, SDK files, token cache, configuration, and stdout logs private. Chat messages and Discord account metadata may pass through this process.

Inbound Discord messages are status lines, not world-chat bubbles: the Flash client expects a world entity ID for public chat, and Discord users do not necessarily have matching game entities.

## Prerequisites

- Git and Git LFS. The SDK installer fetches binary SDK files through Git LFS.
- Access to the repository branch configured by `DISCORD_SOCIAL_SDK_BRANCH` (the default is `neodevils/discord-social-sdk-files`).
- A C++17 build environment.
  - macOS: Xcode Command Line Tools/`clang++`.
  - Windows: CMake plus Ninja, Visual Studio Build Tools, or another supported CMake generator.
- A Discord application ID. Bot/channel-link workflows also need the appropriate Discord bot credentials and permissions.

Do not commit the SDK directory, token cache, channel-link cache, `.env`, or bot/OAuth credentials.

## Install the SDK files

From the repository root:

```bash
npm run install:discord-social-sdk
```

The files are installed in `src/server/native_bridge/discord_social_sdk/`. To replace an existing local SDK copy, run:

```bash
npm run install:discord-social-sdk -- --force
```

If the command reports that Git LFS is missing, install and initialize Git LFS before retrying.

## Build

### macOS

```bash
cd src/server/native_bridge
./build-macos.sh
```

This creates `build/discord_social_bridge` and copies the required SDK dynamic library beside it when available.

### Windows

Run `src/server/native_bridge/build-windows.bat`, or start `dev-windows.bat` after the SDK and a supported C++ toolchain are installed. The build creates `build\\discord_social_bridge.exe` and copies its SDK DLL beside it.

### Other CMake environments

From `src/server/native_bridge/`:

```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release
```

The server searches for `native_bridge/build/discord_social_bridge` on macOS/Linux and `native_bridge/build/discord_social_bridge.exe` on Windows. Override the path with `DISCORD_SOCIAL_BRIDGE_EXECUTABLE` when needed.

## Configure and start

The bridge reads `src/server/discord-social-bridge.config.json`; environment variables take precedence for supported settings. Keep secrets in `src/server/.env` or a protected deployment environment, not in the committed JSON file.

| Setting | Purpose |
| --- | --- |
| `DISCORD_SOCIAL_BRIDGE_ENABLED` | Enables the TypeScript bridge integration. |
| `DISCORD_SOCIAL_NATIVE_BRIDGE_ENABLED` | Allows the TypeScript server to spawn the native executable. |
| `DISCORD_SOCIAL_APP_ID` | Discord application ID. Required by the native bridge. |
| `DISCORD_SOCIAL_BRIDGE_CHANNEL_ID` | Optional Discord channel used for linked-channel operations. |
| `DISCORD_SOCIAL_CHAT_RELAY_MODE` | `native`, `bot`, `both`, or `off`. `native` sends public game chat through the SDK lobby; `bot` uses the Discord server API. |
| `DISCORD_SOCIAL_DEVICE_FLOW` | Enables device authorization when a saved SDK session cannot be restored. |
| `DISCORD_SOCIAL_LOBBY_SECRET` | Reuses a known lobby; treat it as sensitive configuration. |
| `DISCORD_SOCIAL_ENABLE_CHANNEL_LINKING` | Enables Discord channel-to-lobby linking. It requires the relevant bot/server API configuration. |
| `DISCORD_SOCIAL_BRIDGE_EXECUTABLE` | Overrides the native executable location. |
| `DISCORD_SOCIAL_CHANNEL_LINK_CACHE_PATH` | Overrides the local channel-link cache location. |
| `DISCORD_SOCIAL_BRIDGE_LOG_PAYLOADS` | Logs bridge payloads for debugging. Leave it disabled outside controlled debugging because payloads include chat content. |

For a local development session, build the bridge, set the required variables in `src/server/.env` or your shell, then run `npm run dev` from the repository root. The macOS and Windows launchers detect a built bridge and enable it automatically; without the SDK or executable, they leave the optional bridge disabled.

## Bridge protocol

The TypeScript server and native executable exchange one JSON object per line over standard input/output (JSONL). The native bridge accepts commands such as `initialize`, `outbound_chat`, `use_lobby`, and `link_channel`. It emits events including `ready`, `auth`, `chat`, `status`, `lobby_ready`, and channel-link results.

The process protocol is internal. If you modify it, update both `BridgeMain.cpp` and `DiscordSocialBridge.ts`, preserve one-object-per-line framing, and add focused verification. Do not write unrelated output to stdout; it is parsed as bridge data.

## Verify and troubleshoot

1. Start the server with bridge debugging disabled first.
2. Confirm the server logs that the native Social SDK bridge is ready.
3. If device flow is enabled, complete authorization only at the displayed Discord verification URL and code.
4. Send a public game-chat message and confirm the expected Discord relay path. Send a controlled Discord message and confirm it appears as a game status line.

| Symptom | Check |
| --- | --- |
| Executable is not found | Build the bridge or set `DISCORD_SOCIAL_BRIDGE_EXECUTABLE` to the built binary. |
| Missing library/DLL at launch | Confirm the SDK library was copied next to the executable and matches the host architecture. |
| SDK installer fails | Confirm Git LFS is installed, the configured branch is accessible, and there is sufficient disk space. |
| Device authorization never appears | Confirm the bridge is enabled, an application ID is configured, and `DISCORD_SOCIAL_DEVICE_FLOW=true` when no saved session exists. |
| Discord channel already linked (`50237`) | A channel can belong to only one lobby. Reuse the matching `DISCORD_SOCIAL_LOBBY_SECRET` or unlink the previous association before retrying. |
| Inbound messages are not chat bubbles | This is the current design limitation; inbound Discord messages use status lines. |

To force a fresh authorization, stop the server and remove the local SDK token cache only after confirming its configured location. Treat cache deletion as sign-out, not as a repair for unrelated lobby/channel configuration errors.

## Current limitations

- Only public game chat is forwarded to the native bridge by default.
- Inbound Discord messages are status lines rather than entity-backed world chat.
- Native lobby/chat requires `DISCORD_SOCIAL_NATIVE_BRIDGE_ENABLED=true`.
- Bot and linked-channel workflows require additional Discord server API configuration, including a bot token where applicable.
- The SDK files are intentionally untracked and optional; a normal local game session works without them.

## Protocol research

When investigating Flash chat behavior, use a controlled test server and test accounts. Typical steps are to inspect the SWF in JPEXS FFDec, identify the socket write chain and packet IDs, capture test traffic, confirm encoding/endianness, then update `PacketParser` with verified schema details. Do not capture or publish other players' traffic.
