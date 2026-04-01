#!/usr/bin/env bash
# Prepare a pre-recorded Stylus trace fixture for WDIO tests.
#
# This script runs the Tier 1+2 Stylus integration test in the codetracer repo
# with STYLUS_FIXTURE_OUTPUT_DIR set, so the trace is exported to the fixture
# directory used by the VS Code extension's WDIO tests.
#
# Prerequisites:
#   - Arbitrum devnode running at localhost:8547
#   - cargo-stylus, cast (Foundry), wazero on PATH
#   - wasm32-unknown-unknown Rust target installed
#   - codetracer repo at ../codetracer (relative to this script's location)
#
# Usage:
#   ./scripts/prepare-stylus-fixture.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_DIR="$(dirname "$SCRIPT_DIR")"
FIXTURE_DIR="$EXTENSION_DIR/test/fixtures/stylus-fund-trace"

# Locate the codetracer repo (sibling directory)
CODETRACER_DIR="${CODETRACER_DIR:-$(cd "$EXTENSION_DIR/../codetracer" 2>/dev/null && pwd)}"
if [ ! -d "$CODETRACER_DIR/src/db-backend" ]; then
  echo "ERROR: codetracer repo not found at $CODETRACER_DIR"
  echo "Set CODETRACER_DIR to the path of the codetracer repository."
  exit 1
fi

echo "=== Preparing Stylus trace fixture ==="
echo "  CodeTracer repo: $CODETRACER_DIR"
echo "  Fixture output:  $FIXTURE_DIR"
echo ""

# Check devnode is running
if ! curl -sf -o /dev/null --max-time 2 http://localhost:8547; then
  echo "ERROR: Arbitrum devnode not reachable at http://localhost:8547"
  echo "Start the devnode first (see docs/book/src/getting_started/stylus.md)."
  exit 1
fi

# Create the fixture directory
mkdir -p "$FIXTURE_DIR"

# Run the Tier 1+2 test with fixture export
echo "Running Stylus integration test with fixture export..."
cd "$CODETRACER_DIR/src/db-backend"
STYLUS_FIXTURE_OUTPUT_DIR="$FIXTURE_DIR" \
  cargo nextest run --no-capture --run-ignored all test_stylus_dap_analysis

# Verify the fixture was created
if [ ! -f "$FIXTURE_DIR/trace_metadata.json" ]; then
  echo "ERROR: Fixture generation failed — trace_metadata.json not found"
  exit 1
fi

if [ ! -f "$FIXTURE_DIR/trace.json" ] && [ ! -f "$FIXTURE_DIR/trace.bin" ]; then
  echo "ERROR: Fixture generation failed — neither trace.json nor trace.bin found"
  exit 1
fi

echo ""
echo "=== Stylus trace fixture ready ==="
echo "  Location: $FIXTURE_DIR"
echo "  Files:"
ls -la "$FIXTURE_DIR"
echo ""
echo "You can now run the WDIO tests:"
echo "  npm run test:wdio:stylus"
