#!/usr/bin/env bash
# Prepare a pre-recorded Stylus trace fixture for WDIO tests.
#
# This script repacks CodeTracer's committed Stylus event stream into the CTFS
# fixture directory used by the VS Code extension's WDIO tests.
#
# Prerequisites:
#   - codetracer repo at ../codetracer (relative to this script's location)
#
# Usage:
#   ./scripts/prepare-stylus-fixture.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_DIR="$(dirname "$SCRIPT_DIR")"
FIXTURE_DIR="$EXTENSION_DIR/test/fixtures/stylus-fund-trace"

# Locate the codetracer repo (sibling directory)
CODETRACER_DIR="${CODETRACER_DIR:-$EXTENSION_DIR/../codetracer}"
if [ ! -d "$CODETRACER_DIR/src/db-backend" ]; then
  echo "ERROR: codetracer repo not found at $CODETRACER_DIR"
  echo "Set CODETRACER_DIR to the path of the codetracer repository."
  exit 1
fi
CODETRACER_DIR="$(cd "$CODETRACER_DIR" && pwd)"

echo "=== Preparing Stylus trace fixture ==="
echo "  CodeTracer repo: $CODETRACER_DIR"
echo "  Fixture output:  $FIXTURE_DIR"
echo ""

# Repack the committed Stylus event stream into the canonical .ct container.
# The extension WDIO tests load this fixture; live Arbitrum deployment belongs
# to CodeTracer's recording-tier tests.
echo "Regenerating Stylus CTFS fixture from committed event data..."
if ! command -v repro >/dev/null 2>&1; then
  echo "ERROR: repro is required to run the Stylus fixture command in $CODETRACER_DIR"
  exit 1
fi
if [ ! -f "$CODETRACER_DIR/repro.nim" ] && [ ! -f "$CODETRACER_DIR/.envrc" ]; then
  echo "ERROR: codetracer repo has no environment declaration; refusing bare cargo execution."
  exit 1
fi

# A fresh destination proves this invocation produced the container. Keep the
# previous usable fixture until generation succeeds, and clean up on failure.
mkdir -p "$FIXTURE_DIR"
STAGING_DIR="$(mktemp -d "$FIXTURE_DIR/.prepare-XXXXXX")"
trap 'rm -rf "$STAGING_DIR"' EXIT
# The child shell expands its own positional argument after entering the environment.
# shellcheck disable=SC2016
repro exec "$CODETRACER_DIR" -- env STYLUS_FIXTURE_OUTPUT_DIR="$STAGING_DIR" bash -c '
  set -euo pipefail
  cd "$1/src/db-backend"
  cargo test --test stylus_fixture_rebuild -- --ignored --nocapture rebuild_stylus_ctfs_fixture
' _ "$CODETRACER_DIR"

GENERATED_CT="$STAGING_DIR/stylus_fund_tracking_demo.ct"
if [ ! -s "$GENERATED_CT" ]; then
  echo "ERROR: CodeTracer Stylus fixture generation did not produce a nonempty $GENERATED_CT"
  exit 1
fi
mv "$GENERATED_CT" "$FIXTURE_DIR/stylus_fund_tracking_demo.ct"
rm -rf "$STAGING_DIR"

echo ""
echo "=== Stylus trace fixture ready ==="
echo "  Location: $FIXTURE_DIR"
echo "  Files:"
ls -la "$FIXTURE_DIR"
echo ""
echo "You can now run the WDIO tests:"
echo "  npm run test:wdio:stylus"
