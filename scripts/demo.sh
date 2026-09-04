#!/usr/bin/env bash
# Builds a self-contained demo of the Altovix Terminal with NO network and NO API key.
# Everything it produces is synthetic: random-walk prices, a fabricated book, and an
# offline mock model. It exists to show the machinery working, not to say anything
# about markets. The demo lives in its own database file and never touches ./altovix.db
set -euo pipefail
cd "$(dirname "$0")/.."

export ALTOVIX_DB=./data/demo.db
export ALTOVIX_MARKET_PROVIDER=csv
export ALTOVIX_CSV_DIR=./data/demo-prices
export ALTOVIX_LLM=mock

N="node --experimental-strip-types"
rm -f data/demo.db data/demo.db-*

$N scripts/generate-demo-prices.ts --days 520 --out data/demo-prices
$N src/cli/init.ts NVDA AAPL MSFT AMD COST --fund 60000 --date 2025-01-02
$N src/cli/ingest.ts > /dev/null
echo "ingested price history"
$N scripts/seed-demo-book.ts

for d in 2025-09-15 2025-11-04 2026-01-08 2026-03-17 2026-05-05; do
  for t in NVDA AAPL MSFT; do
    $N src/cli/committee.ts "$t" --mock --as-of "$d" > /dev/null
  done
done
echo "ran 15 offline committee dry runs"

$N src/cli/calibrate.ts --mechanical-only --include-mock
$N src/cli/report.ts

cat <<'EOF'

  Everything above is synthetic. The calibration scorecard is measuring a random
  forecaster against random walks, which is why it lands near 50% with negative
  Brier skill - that is the engine working correctly, not a result.
EOF
