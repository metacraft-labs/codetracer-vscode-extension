#!/usr/bin/env bash
# Prepare a pre-recorded Move trace fixture for WDIO tests.
#
# This script builds the codetracer-move-recorder, runs it against the
# flow_test Move module, and copies the resulting trace to the fixture
# directory used by the VS Code extension's WDIO smoke tests.
#
# The fixture trace covers:
#   - test_computation() function in the flow_test module
#   - Arithmetic on u64 values (sum_val)
#   - Move VM execution and variable tracking
#
# Prerequisites:
#   - cargo (Rust toolchain) on PATH
#   - codetracer-move-recorder repo at ../codetracer-move-recorder (relative
#     to this extension repo) or at $MOVE_RECORDER_DIR
#
# Usage:
#   ./scripts/prepare-move-fixture.sh
#
# Environment variables:
#   MOVE_RECORDER_DIR  — override path to codetracer-move-recorder repo
#   FORCE=1            — re-record even if fixture already exists

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_DIR="$(dirname "$SCRIPT_DIR")"
FIXTURE_DIR="$EXTENSION_DIR/test/traces/move-flow-test"

# Locate the codetracer-move-recorder repo (sibling directory)
MOVE_RECORDER_DIR="${MOVE_RECORDER_DIR:-$(cd "$EXTENSION_DIR/../codetracer-move-recorder" 2>/dev/null && pwd || true)}"
if [ -z "$MOVE_RECORDER_DIR" ] || [ ! -f "$MOVE_RECORDER_DIR/Cargo.toml" ]; then
  echo "ERROR: codetracer-move-recorder repo not found."
  echo "  Tried: $EXTENSION_DIR/../codetracer-move-recorder"
  echo "  Set MOVE_RECORDER_DIR to the path of the codetracer-move-recorder repository."
  exit 1
fi

SOURCE_FILE="$MOVE_RECORDER_DIR/test-programs/move/flow_test/sources/flow_test.move"
if [ ! -f "$SOURCE_FILE" ]; then
  echo "ERROR: Move flow_test source not found at $SOURCE_FILE"
  exit 1
fi

echo "=== Preparing Move trace fixture ==="
echo "  Move recorder:  $MOVE_RECORDER_DIR"
echo "  Test program:   $SOURCE_FILE"
echo "  Fixture output: $FIXTURE_DIR"
echo ""

# Skip if fixture already exists and FORCE is not set
if [ -d "$FIXTURE_DIR" ] && [ -f "$FIXTURE_DIR/trace_metadata.json" ] && [ -z "${FORCE:-}" ]; then
  if [ -f "$FIXTURE_DIR/trace.json" ] || [ -f "$FIXTURE_DIR/trace.bin" ]; then
    echo "Fixture already exists (use FORCE=1 to re-record)."
    echo "  Location: $FIXTURE_DIR"
    exit 0
  fi
fi

# Check prerequisites
if ! command -v cargo >/dev/null 2>&1; then
  echo "ERROR: cargo not found on PATH."
  echo "  Install the Rust toolchain or enter nix develop in $MOVE_RECORDER_DIR."
  exit 1
fi

# Build the recorder binary
echo "Building codetracer-move-recorder..."
if command -v direnv >/dev/null 2>&1 && [ -f "$MOVE_RECORDER_DIR/.envrc" ]; then
  direnv exec "$MOVE_RECORDER_DIR" cargo build --manifest-path "$MOVE_RECORDER_DIR/Cargo.toml"
else
  cargo build --manifest-path "$MOVE_RECORDER_DIR/Cargo.toml"
fi

# Locate the built binary
RECORDER_BIN="$MOVE_RECORDER_DIR/target/debug/codetracer-move-recorder"
if [ ! -x "$RECORDER_BIN" ]; then
  echo "ERROR: Recorder binary not found at $RECORDER_BIN"
  echo "  Build may have failed — check the cargo output above."
  exit 1
fi

# Create the fixture directory
rm -rf "$FIXTURE_DIR"
mkdir -p "$FIXTURE_DIR"

# The Move recorder expects a raw NDJSON trace file as input. To produce one,
# we need to run the Move VM with tracing enabled. For now, use the recorder's
# built-in record subcommand which handles this end-to-end.
echo "Recording Move trace..."
"$RECORDER_BIN" record -o "$FIXTURE_DIR" "$SOURCE_FILE"

# Verify the fixture was created
if [ ! -f "$FIXTURE_DIR/trace_metadata.json" ]; then
  echo "ERROR: Fixture generation failed — trace_metadata.json not found."
  echo "  Check the recorder output above for errors."
  exit 1
fi

if [ ! -f "$FIXTURE_DIR/trace.json" ] && [ ! -f "$FIXTURE_DIR/trace.bin" ]; then
  echo "ERROR: Fixture generation failed — neither trace.json nor trace.bin found."
  exit 1
fi

# Copy the source file alongside the trace so the DAP server can resolve
# source references.
if [ ! -f "$FIXTURE_DIR/flow_test.move" ]; then
  cp "$SOURCE_FILE" "$FIXTURE_DIR/flow_test.move"
fi

echo ""
echo "=== Move trace fixture ready ==="
echo "  Location: $FIXTURE_DIR"
echo "  Files:"
ls -la "$FIXTURE_DIR"
echo ""
echo "You can now run the WDIO smoke test:"
echo "  npm run test:wdio:move"
