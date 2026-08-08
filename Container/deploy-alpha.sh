#!/usr/bin/env bash
set -euo pipefail

IMAGE="${IMAGE:-ghcr.io/sibahia/dg-latam:alpha}"
MONGO_URI="${GAME_MONGODB_URI:-mongodb://127.0.0.1:27017}"
DB_NAME="${GAME_MONGODB_DB_NAME:-dungeonblitz_alpha}"
BASE_IP="${MULTIPLAYER_BASE_IP:-alpha.dgblitzlatam.duckdns.org}"

echo "Pulling ${IMAGE} ..."
sudo docker pull "${IMAGE}"

echo "Recreating dungeon-blitz-r-alpha ..."
sudo docker rm -f dungeon-blitz-r-alpha 2>/dev/null || true
sudo docker run -d \
  --name dungeon-blitz-r-alpha \
  --restart unless-stopped \
  --network host \
  -v /opt/dungeon-blitz-r-alpha/src/server/data:/opt/games/dungeon-blitz-r/src/server/data \
  -e MULTIPLAYER_MODE=true \
  -e ENABLE_POLICY_SERVER=true \
  -e MULTIPLAYER_BASE_IP="${BASE_IP}" \
  -e STATIC_PORT=8081 \
  -e GAME_PORT=8082 \
  -e POLICY_PORT=844 \
  -e GAME_MONGODB_URI="${MONGO_URI}" \
  -e GAME_MONGODB_DB_NAME="${DB_NAME}" \
  -e ADMIN_API_SECRET="$(cat /opt/dungeon-blitz-r/.admin_api_secret)" \
  "${IMAGE}"

echo "Waiting for alpha health ..."
for i in $(seq 1 30); do
  if curl -sf http://127.0.0.1:8081/healthz >/dev/null 2>&1; then
    echo "Alpha server is up after ${i}s"
    break
  fi
  sleep 1
done
curl -s -o /dev/null -w "alpha healthz http_code=%{http_code}\n" http://127.0.0.1:8081/healthz || echo "alpha healthz unreachable"
echo "Alpha deploy complete."
