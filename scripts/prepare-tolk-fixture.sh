#!/usr/bin/env bash
# Prepare a pre-recorded Tolk (TON) trace fixture for WDIO tests.
#
# This script builds the codetracer-ton-recorder, runs it against the
# flow_test.tolk test program, and copies the resulting trace to the fixture
# directory used by the VS Code extension's WDIO smoke tests.
#
# The fixture trace covers:
#   - compute function in Tolk
#   - Stack-based TVM operations
#   - Tolk/TON VM tracer
#
# Prerequisites:
#   - cargo (Rust toolchain) on PATH
#   - codetracer-ton-recorder repo at ../codetracer-ton-recorder (relative
#     to this extension repo) or at $TOLK_RECORDER_DIR
#
# Usage:
#   ./scripts/prepare-tolk-fixture.sh
#
# Environment variables:
#   TOLK_RECORDER_DIR  — override path to codetracer-ton-recorder repo
#   FORCE=1            — re-record even if fixture already exists

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/recorder-shell-exec.sh"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_DIR="$(dirname "$SCRIPT_DIR")"
FIXTURE_DIR="$EXTENSION_DIR/test/traces/tolk-flow-test"

# Locate the codetracer-ton-recorder repo (sibling directory)
TOLK_RECORDER_DIR="${TOLK_RECORDER_DIR:-$(cd "$EXTENSION_DIR/../codetracer-ton-recorder" 2>/dev/null && pwd || true)}"
if [ -z "$TOLK_RECORDER_DIR" ] || [ ! -f "$TOLK_RECORDER_DIR/Cargo.toml" ]; then
  echo "ERROR: codetracer-ton-recorder repo not found."
  echo "  Tried: $EXTENSION_DIR/../codetracer-ton-recorder"
  echo "  Set TOLK_RECORDER_DIR to the path of the codetracer-ton-recorder repository."
  exit 1
fi

SOURCE_FILE="$TOLK_RECORDER_DIR/test-programs/tolk/flow_test.tolk"
if [ ! -f "$SOURCE_FILE" ]; then
  echo "ERROR: Tolk test program not found at $SOURCE_FILE"
  exit 1
fi

echo "=== Preparing Tolk (TON) trace fixture ==="
echo "  Tolk recorder:  $TOLK_RECORDER_DIR"
echo "  Test program:   $SOURCE_FILE"
echo "  Fixture output: $FIXTURE_DIR"
echo ""

# Skip if fixture already exists and FORCE is not set
if [ -d "$FIXTURE_DIR" ] && [ -z "${FORCE:-}" ]; then
  if compgen -G "$FIXTURE_DIR/*.ct" >/dev/null \
    || { [ -f "$FIXTURE_DIR/trace_metadata.json" ] && \
         { [ -f "$FIXTURE_DIR/trace.json" ] || [ -f "$FIXTURE_DIR/trace.bin" ]; }; }; then
    echo "Fixture already exists (use FORCE=1 to re-record)."
    echo "  Location: $FIXTURE_DIR"
    exit 0
  fi
fi

echo "Building codetracer-ton-recorder..."
recorder_exec "$TOLK_RECORDER_DIR" cargo build --manifest-path "$TOLK_RECORDER_DIR/Cargo.toml"

# Locate the built binary
RECORDER_BIN="$TOLK_RECORDER_DIR/target/debug/codetracer-ton-recorder"
if [ ! -x "$RECORDER_BIN" ]; then
  echo "ERROR: Recorder binary not found at $RECORDER_BIN"
  echo "  Build may have failed — check the cargo output above."
  exit 1
fi

# Create the fixture directory
rm -rf "$FIXTURE_DIR"
mkdir -p "$FIXTURE_DIR"

echo "Recording Tolk trace..."
recorder_exec "$TOLK_RECORDER_DIR" "$RECORDER_BIN" record "$SOURCE_FILE" --out-dir "$FIXTURE_DIR"

# Verify the fixture was created.  Recorders now emit CTFS
# bundles (a *.ct directory or file) instead of the legacy
# trace_metadata.json + trace.json/trace.bin shape.  Accept
# either layout for backwards compatibility while consumers
# migrate.
if compgen -G "$FIXTURE_DIR/*.ct" >/dev/null; then
  : # CTFS bundle present
elif [ -f "$FIXTURE_DIR/trace_metadata.json" ] && \
     { [ -f "$FIXTURE_DIR/trace.json" ] || [ -f "$FIXTURE_DIR/trace.bin" ]; }; then
  : # legacy JSON / bin bundle present
else
  echo "ERROR: Fixture generation failed — no CTFS bundle (*.ct) and"
  echo "  no legacy trace.json / trace.bin found in $FIXTURE_DIR."
  echo "  Check the recorder output above for errors."
  exit 1
fi

# Copy the source file alongside the trace so the DAP server can resolve
# source references.
if [ ! -f "$FIXTURE_DIR/flow_test.tolk" ]; then
  cp "$SOURCE_FILE" "$FIXTURE_DIR/flow_test.tolk"
fi

echo ""
echo "=== Tolk trace fixture ready ==="
echo "  Location: $FIXTURE_DIR"
echo "  Files:"
ls -la "$FIXTURE_DIR"
echo ""
echo "You can now run the WDIO smoke test:"
echo "  npm run test:wdio:tolk"
