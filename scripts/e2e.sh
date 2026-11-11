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
naive_money=$(echo "$runs" | python3 -c 'import json,sys; r=[r for r in json.load(sys.stdin)["runs"] if r["name"]=="demo: naive"][0]; print(len(r["money_at_risk"] or []))')
[ "$naive_money" -gt 0 ] || { echo "naive run should have money at risk"; exit 1; }
# The naive run opens problems; the safe run, last, exercises the same
# operations under the same faults and so marks them fixed.
statuses=$(curl -sf "$API/api/projects/$pid/issues?status=all" | python3 -c 'import json,sys; print(" ".join(sorted({i["status"] for i in json.load(sys.stdin)["issues"]})))')
[ "$statuses" = "fixed" ] || { echo "after the safe run every problem should be fixed, got: $statuses"; exit 1; }

# Pull-request flow: a scenario saved in the dashboard, loaded by name; a
# clean run on main as the baseline; then two pull requests judged against it.
curl -sf -XPOST "$API/api/projects/$pid/scenarios" -H 'content-type: application/json' \
  -d "{\"name\":\"lost-responses\",\"config\":$(cat examples/scenarios/lost-responses.json)}" >/dev/null
tmp=$(mktemp -d)
echo '{"repository":{"default_branch":"main"}}' > "$tmp/push.json"
echo '{"pull_request":{"number":7,"head":{"ref":"feature","sha":"feedface"},"base":{"ref":"main"}},"repository":{"default_branch":"main"}}' > "$tmp/pr.json"
ci() { # event-file client expected-exit
  local code=0
  (cd "$tmp" && env GITHUB_ACTIONS=true GITHUB_REPOSITORY=acme/shop GITHUB_SHA=c0ffee GITHUB_REF_NAME=main GITHUB_EVENT_PATH="$tmp/$1" \
    GITHUB_STEP_SUMMARY= PAYCHAOS_TOKEN="$token" "$OLDPWD/bin/paychaos" ci -listen 127.0.0.1:0 -upstream mock -scenario lost-responses \
    -report-to "$API" -report report.json -pr-comment=false -- "$OLDPWD/bin/$2-client" -n 5 \
    > "$tmp/out.txt" 2> "$tmp/err.txt") || code=$?
  [ "$code" -eq "$3" ] || { echo "ci $1 $2: exit $code, want $3"; cat "$tmp/out.txt" "$tmp/err.txt"; exit 1; }
  grep -q "paychaos verdict" "$tmp/out.txt" || { echo "no verdict printed"; cat "$tmp/out.txt"; exit 1; }
}
ci push.json safe 0
ci pr.json naive 2
grep -q "new problem" "$tmp/out.txt" || { echo "PR verdict should list new problems"; exit 1; }
ci pr.json safe 0
grep -q "No new payment-safety problems" "$tmp/out.txt" || { echo "clean PR should pass"; exit 1; }
rm -rf "$tmp"
echo "end-to-end OK"
