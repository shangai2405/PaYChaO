#!/usr/bin/env bash
# Runs the naive, rotating-id and safe example clients through paychaos against
# the bundled PayPal-shaped mock and prints what the upstream actually created.
# No PayPal account needed.
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p bin
go build -o bin/paychaos ./cmd/paychaos
go build -o bin/naive-client ./examples/naive-client
go build -o bin/rotating-id-client ./examples/rotating-id-client
go build -o bin/safe-client ./examples/safe-client

N=${N:-20}
MOCK=127.0.0.1:12111
PROXY=127.0.0.1:8080
REPORT_TO=${REPORT_TO:-}

stats() { curl -s "http://$MOCK/__mock/stats"; }
count() { stats | sed -n "s/.*\"$1\":\([0-9]*\).*/\1/p"; }

run_case() {
  local name=$1
  local extra=()
  if [ -n "$REPORT_TO" ]; then extra=(-report-to "$REPORT_TO" -run-name "demo: $name"); fi
  ./bin/paychaos mock -listen "$MOCK" 2>/dev/null & local mock_pid=$!
  sleep 0.5
  ./bin/paychaos -listen "$PROXY" -upstream "http://$MOCK" -allow-upstream "$MOCK" \
    -config examples/scenarios/lost-responses.json "${extra[@]}" \
    -report "paychaos-report-$name.json" -fail-on-high=false 2>/dev/null > "paychaos-$name.txt" & local px_pid=$!
  sleep 0.5
  "./bin/$name-client" -base "http://$PROXY" -n "$N"
  echo "  upstream created $(count orders) orders, $(count captures) captures, $(count refunds) refunds for $N checkouts"
  kill -INT "$px_pid"; wait "$px_pid" || true
  kill "$mock_pid"; wait "$mock_pid" 2>/dev/null || true
  sed -n '/^Findings/,$p' "paychaos-$name.txt" | head -10
  echo
}

echo "== naive client (no PayPal-Request-Id, instant retries, no token refresh) =="
run_case naive
echo "== rotating-id client (sends PayPal-Request-Id, but a new one per attempt) =="
run_case rotating-id
echo "== safe client (one UUID per step reused on retries, backoff, GET after 422) =="
run_case safe
