#!/usr/bin/env bash
# Starts the API against $DATABASE_URL, runs the three demo clients through the
# engine with -report-to, and checks the runs and findings arrived.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${DATABASE_URL:?set DATABASE_URL}"
API=http://127.0.0.1:3000

(cd api && PORT=3000 LOG_REQUESTS=false exec node --import tsx src/server.ts) & api_pid=$!
trap 'kill $api_pid 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do curl -sf "$API/api/health" >/dev/null && break; sleep 0.2; done

project=$(curl -sf -XPOST "$API/api/projects" -H 'content-type: application/json' -d "{\"name\":\"e2e-$RANDOM\"}")
pid=$(echo "$project" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
token=$(curl -sf -XPOST "$API/api/projects/$pid/tokens" -H 'content-type: application/json' -d '{"label":"e2e"}' \
  | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')

PAYCHAOS_TOKEN=$token REPORT_TO=$API N=10 ./scripts/demo.sh

runs=$(curl -sf "$API/api/projects/$pid/runs")
echo "$runs"
finished=$(echo "$runs" | grep -o '"status":"finished"' | wc -l)
[ "$finished" -eq 3 ] || { echo "expected 3 finished runs, got $finished"; exit 1; }
echo "$runs" | grep -q '"name":"demo: naive"' || { echo "naive run missing"; exit 1; }
naive_high=$(echo "$runs" | python3 -c 'import json,sys; print([r["high"] for r in json.load(sys.stdin)["runs"] if r["name"]=="demo: naive"][0])')
safe_total=$(echo "$runs" | python3 -c 'import json,sys; r=[r for r in json.load(sys.stdin)["runs"] if r["name"]=="demo: safe"][0]; print(r["high"]+r["medium"]+r["low"])')
[ "$naive_high" -gt 0 ] || { echo "naive client should have HIGH findings"; exit 1; }
[ "$safe_total" -eq 0 ] || { echo "safe client should have no findings"; exit 1; }
echo "end-to-end OK"
