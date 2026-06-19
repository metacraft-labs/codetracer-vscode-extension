#!/usr/bin/env bash
# Prepare a pre-recorded MASM (Miden) trace fixture for WDIO tests.
#
# This script builds the codetracer-miden-recorder, runs it against the
# compute.masm test program, and copies the resulting trace to the fixture
# directory used by the VS Code extension's WDIO smoke tests.
#
# The fixture trace covers:
#   - compute procedure in Miden Assembly
#   - Stack-based arithmetic operations
#   - Miden VM execution path
#
# Prerequisites:
#   - cargo (Rust toolchain) on PATH
#   - codetracer-miden-recorder repo at ../codetracer-miden-recorder (relative
#     to this extension repo) or at $MIDEN_RECORDER_DIR
#
# Usage:
#   ./scripts/prepare-masm-fixture.sh
#
# Environment variables:
#   MIDEN_RECORDER_DIR  — override path to codetracer-miden-recorder repo
#   FORCE=1             — re-record even if fixture already exists

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/recorder-shell-exec.sh"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_DIR="$(dirname "$SCRIPT_DIR")"
FIXTURE_DIR="$EXTENSION_DIR/test/traces/masm-flow-test"

# Locate the codetracer-miden-recorder repo (sibling directory)
MIDEN_RECORDER_DIR="${MIDEN_RECORDER_DIR:-$(cd "$EXTENSION_DIR/../codetracer-miden-recorder" 2>/dev/null && pwd || true)}"
if [ -z "$MIDEN_RECORDER_DIR" ] || [ ! -f "$MIDEN_RECORDER_DIR/Cargo.toml" ]; then
  echo "ERROR: codetracer-miden-recorder repo not found."
  echo "  Tried: $EXTENSION_DIR/../codetracer-miden-recorder"
  echo "  Set MIDEN_RECORDER_DIR to the path of the codetracer-miden-recorder repository."
  exit 1
fi

SOURCE_FILE="$MIDEN_RECORDER_DIR/test-programs/masm/compute.masm"
if [ ! -f "$SOURCE_FILE" ]; then
  echo "ERROR: MASM test program not found at $SOURCE_FILE"
  exit 1
fi

echo "=== Preparing MASM (Miden) trace fixture ==="
echo "  Miden recorder:  $MIDEN_RECORDER_DIR"
echo "  Test program:    $SOURCE_FILE"
echo "  Fixture output:  $FIXTURE_DIR"
echo ""

# Skip if fixture already exists and FORCE is not set
if [ -d "$FIXTURE_DIR" ] && [ -z "${FORCE:-}" ]; then
  if [ -n "$(find $FIXTURE_DIR/*.ct -maxdepth 0 -print -quit 2>/dev/null)" ] \
    || { [ -f "$FIXTURE_DIR/trace_metadata.json" ] && \
         { [ -f "$FIXTURE_DIR/trace.json" ] || [ -f "$FIXTURE_DIR/trace.bin" ]; }; }; then
    echo "Fixture already exists (use FORCE=1 to re-record)."
    echo "  Location: $FIXTURE_DIR"
    exit 0
  fi
fi

echo "Building codetracer-miden-recorder..."
recorder_exec "$MIDEN_RECORDER_DIR" cargo build --manifest-path "$MIDEN_RECORDER_DIR/Cargo.toml"

# Locate the built binary
RECORDER_BIN="$MIDEN_RECORDER_DIR/target/debug/codetracer-miden-recorder"
if [ ! -x "$RECORDER_BIN" ]; then
  echo "ERROR: Recorder binary not found at $RECORDER_BIN"
  echo "  Build may have failed — check the cargo output above."
  exit 1
fi

# Create the fixture directory
rm -rf "$FIXTURE_DIR"
mkdir -p "$FIXTURE_DIR"

echo "Recording MASM trace..."
recorder_exec "$MIDEN_RECORDER_DIR" "$RECORDER_BIN" record "$SOURCE_FILE" --out-dir "$FIXTURE_DIR"

# Verify the fixture was created.  Recorders now emit CTFS
# bundles (a *.ct directory or file) instead of the legacy
# trace_metadata.json + trace.json/trace.bin shape.  Accept
# either layout for backwards compatibility while consumers
# migrate.
if [ -n "$(find $FIXTURE_DIR/*.ct -maxdepth 0 -print -quit 2>/dev/null)" ]; then
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
if [ ! -f "$FIXTURE_DIR/compute.masm" ]; then
  cp "$SOURCE_FILE" "$FIXTURE_DIR/compute.masm"
fi

echo ""
echo "=== MASM trace fixture ready ==="
echo "  Location: $FIXTURE_DIR"
echo "  Files:"
ls -la "$FIXTURE_DIR"
echo ""
echo "You can now run the WDIO smoke test:"
echo "  npm run test:wdio:masm"
