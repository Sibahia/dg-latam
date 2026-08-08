#!/usr/bin/env bash
set -euo pipefail

IMAGE="${IMAGE:-ghcr.io/sibahia/dg-latam:latest}"
MONGO_URI="${GAME_MONGODB_URI:-mongodb://mongo:27017}"
DB_NAME="${GAME_MONGODB_DB_NAME:-dungeonblitz}"
BASE_IP="${MULTIPLAYER_BASE_IP:-dgblitzlatam.duckdns.org}"
DATA_ROOT="${DATA_ROOT:-/opt/dungeon-blitz-r/data}"
DOCKER_NETWORK="${DOCKER_NETWORK:-dungeon-blitz-r}"

sudo install -d -o 10001 -g 10001 -m 0700 "${DATA_ROOT}/saves"
if [[ ! -f "${DATA_ROOT}/Accounts.json" ]]; then
  printf '[]\n' | sudo tee "${DATA_ROOT}/Accounts.json" >/dev/null
fi
sudo chown 10001:10001 "${DATA_ROOT}/Accounts.json" "${DATA_ROOT}/saves"
sudo chmod 0600 "${DATA_ROOT}/Accounts.json"
sudo docker network inspect "${DOCKER_NETWORK}" >/dev/null 2>&1 || sudo docker network create "${DOCKER_NETWORK}" >/dev/null

echo "Pulling ${IMAGE} ..."
sudo docker pull "${IMAGE}"

echo "Recreating dungeon-blitz-r ..."
sudo docker rm -f dungeon-blitz-r 2>/dev/null || true
sudo docker run -d \
  --name dungeon-blitz-r \
  --restart unless-stopped \
  --network "${DOCKER_NETWORK}" \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --pids-limit 256 \
  --memory "${CONTAINER_MEMORY_LIMIT:-1g}" \
  --cpus "${CONTAINER_CPU_LIMIT:-1}" \
  -p 80:8000/tcp \
  -p 8080:8080/tcp \
  -p 843:8843/tcp \
  -v "${DATA_ROOT}/Accounts.json:/opt/games/dungeon-blitz-r/src/server/data/Accounts.json" \
  -v "${DATA_ROOT}/saves:/opt/games/dungeon-blitz-r/src/server/data/saves" \
  -e MULTIPLAYER_MODE=true \
  -e ENABLE_POLICY_SERVER=true \
  -e STATIC_PORT=8000 \
  -e POLICY_PORT=8843 \
  -e MULTIPLAYER_BASE_IP="${BASE_IP}" \
  -e GAME_MONGODB_URI="${MONGO_URI}" \
  -e GAME_MONGODB_DB_NAME="${DB_NAME}" \
  -e ADMIN_API_SECRET="$(cat /opt/dungeon-blitz-r/.admin_api_secret)" \
  -e DUNGEON_DIAG=1 \
  "${IMAGE}"

echo "Waiting for health ..."
for i in $(seq 1 30); do
  if curl -sf http://127.0.0.1/healthz >/dev/null 2>&1; then
    echo "Server is up after ${i}s"
    break
  fi
  sleep 1
done
if ! curl --fail --silent --show-error http://127.0.0.1/healthz >/dev/null; then
  echo "Health check failed; recent container logs follow." >&2
  sudo docker logs --tail 100 dungeon-blitz-r >&2 || true
  sudo docker rm -f dungeon-blitz-r >/dev/null 2>&1 || true
  exit 1
fi
sudo docker inspect --format 'user={{.Config.User}} health={{.State.Health.Status}} readonly={{.HostConfig.ReadonlyRootfs}}' dungeon-blitz-r
echo "Deploy complete."
