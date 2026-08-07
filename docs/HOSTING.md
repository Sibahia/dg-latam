# Hosting and operations

## Read this first

The current multiplayer stack is an advanced, **trusted-test** workflow, not a public production deployment recipe. Review [Security](SECURITY.md) before exposing the server. The server should not be made reachable by untrusted clients until the outstanding multiplayer security work is resolved and independently verified.

For local single-player development, use the launchers or commands in the [README](../README.md) instead. They bind to `127.0.0.1`, use JSON files, and do not require a container or MongoDB.

## Deployment model

The container runs the compiled TypeScript server with:

- `MULTIPLAYER_MODE=true`
- `ENABLE_POLICY_SERVER=true`
- HTTP on port `80`
- game TCP on port `8080`
- Flash policy TCP on port `843`

The application serves HTTP and the game protocol over TCP. Although the container metadata also lists UDP ports, this repository does not document a UDP listener; do not open UDP ports unless a separately verified deployment requirement needs them.

For JSON persistence, persist only the mutable account file and saves directory—not a whole source checkout or the entire `src/server/data` directory. A broad bind mount masks the image's required static game data and can prevent startup.

## Prerequisites

- A Linux host you control, with Docker or Podman, Git, and a firewall.
- A DNS name and TLS-capable reverse proxy if browser/OAuth traffic will be public.
- A MongoDB instance if you set `ENABLE_MONGO_GAME_DATA=true`; keep it on a private network.
- A protected location for an environment file and data backups.

`tmux` is optional. A detached container with a restart policy continues after SSH disconnects.

## Prepare configuration

Create a private environment file outside the repository, for example `/etc/dungeon-blitz-r/server.env`, and restrict it to the account that runs the container:

```ini
MULTIPLAYER_MODE=true
ENABLE_POLICY_SERVER=true
MULTIPLAYER_BASE_IP=play.example.invalid
PUBLIC_BASE_URL=https://play.example.invalid
STATIC_PORT=80
GAME_PORT=8080
POLICY_PORT=843

# Generate once with a cryptographically secure tool and retain it securely.
# The value must be 32-128 hexadecimal characters and have an even length.
DUNGEONBLITZ_KEY_HEX=replace-with-a-32-or-more-character-hex-secret
ADMIN_API_SECRET=replace-with-a-long-random-admin-secret

# Use JSON persistence for a private test server.
ENABLE_MONGO_GAME_DATA=false

# Replace the preceding line with these values only when using MongoDB.
# ENABLE_MONGO_GAME_DATA=true
# GAME_MONGODB_URI=mongodb://username:password@mongo.internal:27017/?authSource=admin
# GAME_MONGODB_DB_NAME=dungeonblitz
```

Do not put real values in a committed `.env` file. When Discord OAuth, account linking, or the optional Social SDK bridge is enabled, add its credentials and exact public redirect URL to this protected file; see [the bridge guide](../src/server/native_bridge/README.md).

## Build the image

Run the build from the **repository root**. The container definition copies `src/server`, `src/client`, and root files, so building from `Container/` is not valid.

```bash
podman build -f Container/Containerfile -t dungeon-blitz-r:local .
# or: docker build -f Container/Containerfile -t dungeon-blitz-r:local .
```

The image already has an entrypoint that starts the server. Do not start an interactive shell and then run `entrypoint.sh` manually.

## Run a trusted test server

Create dedicated JSON-persistence paths and start the image detached. `Accounts.json` must contain a JSON array before it is mounted:

```bash
sudo install -d -m 0700 /srv/dungeon-blitz-r/saves
printf '[]\n' | sudo tee /srv/dungeon-blitz-r/Accounts.json >/dev/null
sudo chmod 0600 /srv/dungeon-blitz-r/Accounts.json

podman run -d \
  --name dungeon-blitz-r \
  --replace \
  --restart=unless-stopped \
  --env-file /etc/dungeon-blitz-r/server.env \
  -v /srv/dungeon-blitz-r/Accounts.json:/opt/games/dungeon-blitz-r/src/server/data/Accounts.json:Z \
  -v /srv/dungeon-blitz-r/saves:/opt/games/dungeon-blitz-r/src/server/data/saves:Z \
  -p 80:80/tcp \
  -p 8080:8080/tcp \
  -p 843:843/tcp \
  dungeon-blitz-r:local
```

For Docker, remove the Podman-specific `:Z` volume label. Rootless Podman or Docker may require different host paths and ownership; verify that the process can read/write the mounted data directory before inviting testers.

If you use MongoDB for accounts and saves, omit those JSON-persistence mounts and back up MongoDB separately. Add a narrowly scoped persistent mount only for another file-backed feature after confirming its path and recovery requirements; never mount an empty directory over the image's complete `data` directory.

## Verify and operate

```bash
# Follow startup logs
podman logs --follow dungeon-blitz-r

# Confirm the HTTP service is alive on the host
curl --fail --show-error http://127.0.0.1/healthz

# Inspect status, then stop cleanly
podman ps --filter name=dungeon-blitz-r
podman stop dungeon-blitz-r
```

The health endpoint confirms only that the HTTP listener responds. It does not prove that TCP gameplay, persistence, Flash assets, Discord integration, or authentication flows are healthy. Test those paths with controlled accounts before each deployment.

## Networking and TLS

- Permit TCP `80`, `8080`, and `843` only if the intended clients need them. Restrict all management and database ports.
- Put `PUBLIC_BASE_URL` behind HTTPS when OAuth or browser account flows are enabled. The game container itself serves HTTP; terminate TLS at a trusted reverse proxy.
- Set `MULTIPLAYER_BASE_IP` to the public host name or address advertised to clients. Set `PUBLIC_BASE_URL` separately when the external scheme or port differs.
- Do not rely on unverified proxy-header behavior for identity or authentication. Keep the game server inaccessible except through the proxy where feasible.

## Backups, upgrades, and rollback

1. Announce maintenance and stop the container.
2. Back up `/srv/dungeon-blitz-r/data` (and MongoDB, if enabled) to protected storage.
3. Build or pull the new image, review the release notes and configuration changes, then start the replacement container.
4. Check `/healthz`, server logs, and a controlled gameplay session.
5. If rollback is required, stop the replacement, restore the prior image and compatible data backup, then verify again.

Do not copy a live JSON data directory while the server is writing it. Stop the server first or use a filesystem/database snapshot with equivalent consistency guarantees.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Build cannot find `src/server` or `src/client` | Run the build from the repository root with `-f Container/Containerfile`. |
| Container exits immediately | Inspect `podman logs dungeon-blitz-r`; confirm the environment file, mounted data permissions, and required MongoDB settings. |
| `healthz` fails | Confirm port `80` is not occupied and that the container is running. Test from inside the host before checking DNS/proxy configuration. |
| Client cannot connect | Confirm TCP `8080` is reachable, `MULTIPLAYER_BASE_IP` is correct, and any firewall/NAT rules forward the same port. |
| Flash policy requests fail | Enable the policy server only when required and confirm TCP `843` is reachable. |
| Changes disappear after restart | Verify that the intended data directory or MongoDB database is persistent, writable, and included in backups. |
