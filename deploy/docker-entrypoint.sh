#!/bin/sh
# Container entrypoint: `api` (default) applies pending Prisma migrations then
# serves; `workers` runs the BullMQ worker set from the compiled dist/.
set -e

case "${1:-api}" in
  api)
    npx prisma migrate deploy
    exec node dist/app.js
    ;;
  workers)
    exec node scripts/run-workers.mjs
    ;;
  migrate)
    exec npx prisma migrate deploy
    ;;
  *)
    exec "$@"
    ;;
esac
