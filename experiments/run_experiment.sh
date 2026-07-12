#!/usr/bin/env sh
# Full pre-registered internal experiment (docs/05). Deterministic, offline, ~1s.
set -e
cd "$(dirname "$0")/.."
npm run build
./bin/oculory experiment
echo ""
echo "Machine-readable metrics: .oculory/reports/experiment-metrics.json"
