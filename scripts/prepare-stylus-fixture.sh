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

# Repack the committed Stylus event stream into the canonical .ct container.
# The extension WDIO tests load this fixture; live Arbitrum deployment belongs
# to CodeTracer's recording-tier tests.
echo "Regenerating Stylus CTFS fixture from committed event data..."
if ! command -v direnv >/dev/null 2>&1; then
  echo "ERROR: direnv is required to run the Stylus fixture command in $CODETRACER_DIR"
  exit 1
fi
if [ ! -f "$CODETRACER_DIR/.envrc" ]; then
  echo "ERROR: codetracer repo has no .envrc; refusing bare cargo execution."
  exit 1
fi

direnv allow "$CODETRACER_DIR" 2>/dev/null || true
direnv exec "$CODETRACER_DIR" bash -c '
  set -euo pipefail
  cd "$1/src/db-backend"
  cargo test --test stylus_fixture_rebuild -- --ignored --nocapture rebuild_stylus_ctfs_fixture
' _ "$CODETRACER_DIR"

SOURCE_FIXTURE_DIR="$CODETRACER_DIR/src/db-backend/tests/fixtures/stylus-fund-trace"
SOURCE_CT="$SOURCE_FIXTURE_DIR/stylus_fund_tracking_demo.ct"
if [ ! -f "$SOURCE_CT" ]; then
  echo "ERROR: CodeTracer Stylus fixture generation did not produce $SOURCE_CT"
  exit 1
fi

rm -rf "$FIXTURE_DIR"
mkdir -p "$FIXTURE_DIR"
cp -a "$SOURCE_FIXTURE_DIR/." "$FIXTURE_DIR/"

if [ -z "$(find "$FIXTURE_DIR" -maxdepth 1 -name '*.ct' -type f -print -quit)" ]; then
  echo "ERROR: Fixture generation failed — no CTFS bundle (*.ct) found in $FIXTURE_DIR"
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
