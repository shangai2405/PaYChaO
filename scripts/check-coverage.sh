#!/usr/bin/env bash
# Fails when total statement coverage in a Go cover profile is below a threshold.
#   scripts/check-coverage.sh coverage.out 75
set -euo pipefail
profile=$1 min=$2
total=$(go tool cover -func="$profile" | awk '/^total:/ {sub("%","",$3); print $3}')
echo "total coverage: ${total}% (minimum ${min}%)"
awk -v t="$total" -v m="$min" 'BEGIN { exit (t + 0 < m + 0) ? 1 : 0 }' || { echo "coverage below ${min}%"; exit 1; }
