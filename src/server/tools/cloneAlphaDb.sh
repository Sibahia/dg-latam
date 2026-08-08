#!/usr/bin/env bash
set -euo pipefail

# Clones the production Mongo database into the alpha database. Reads from the source
# (mongodump) and writes only to the destination, so production data is never modified.
#
# Usage: bash tools/cloneAlphaDb.sh
# Env:  GAME_MONGODB_URI (default mongodb://127.0.0.1:27017)
#       GAME_MONGODB_DB_NAME (source, default dungeonblitz)
#       GAME_MONGODB_DB_NAME_ALPHA (destination, default dungeonblitz_alpha)

MONGO_URI="${GAME_MONGODB_URI:-mongodb://127.0.0.1:27017}"
SRC="${GAME_MONGODB_DB_NAME:-dungeonblitz}"
DST="${GAME_MONGODB_DB_NAME_ALPHA:-dungeonblitz_alpha}"

echo "Dropping ${DST} ..."
docker exec dungeon-blitz-mongo mongosh --quiet "${MONGO_URI}/${DST}" --eval 'db.dropDatabase()'

echo "Copying ${SRC} -> ${DST} ..."
docker exec dungeon-blitz-mongo sh -c \
  "mongodump --uri '${MONGO_URI}' --db '${SRC}' --archive | mongorestore --uri '${MONGO_URI}' --nsFrom '${SRC}.*' --nsTo '${DST}.*' --archive"

echo "Alpha DB cloned: ${SRC} -> ${DST}"
