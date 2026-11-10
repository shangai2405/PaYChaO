#!/usr/bin/env bash
# Builds the dashboard, starts the API serving it against $DATABASE_URL, and
# runs the Playwright browser tests (desktop and phone) against it.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${DATABASE_URL:?set DATABASE_URL}"
PORT=${PORT:-3100}
(cd web && npm run build >/dev/null)
(cd api && PORT=$PORT LOG_REQUESTS=false exec node --import tsx src/server.ts) & api_pid=$!
trap 'kill $api_pid 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null && break; sleep 0.2; done
cd web && BASE_URL="http://127.0.0.1:$PORT" npx playwright test --trace off "$@"
