#!/usr/bin/env bash
# Prepare a pre-recorded PolkaVM trace fixture for WDIO tests.
#
# This script builds the codetracer-polkavm-recorder, runs it against the
# flow_test.pvm test program, and copies the resulting trace to the fixture
# directory used by the VS Code extension's WDIO smoke tests.
#
# The fixture trace covers:
#   - compute function in PolkaVM assembly
#   - Register-based arithmetic operations
#   - PolkaVM execution path with step tracing
#
# Prerequisites:
#   - cargo (Rust toolchain) on PATH
#   - codetracer-polkavm-recorder repo at ../codetracer-polkavm-recorder (relative
#     to this extension repo) or at $POLKAVM_RECORDER_DIR
#
# Usage:
#   ./scripts/prepare-polkavm-fixture.sh
#
# Environment variables:
#   POLKAVM_RECORDER_DIR  — override path to codetracer-polkavm-recorder repo
#   FORCE=1               — re-record even if fixture already exists

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_DIR="$(dirname "$SCRIPT_DIR")"
FIXTURE_DIR="$EXTENSION_DIR/test/traces/polkavm-flow-test"

# Locate the codetracer-polkavm-recorder repo (sibling directory)
POLKAVM_RECORDER_DIR="${POLKAVM_RECORDER_DIR:-$(cd "$EXTENSION_DIR/../codetracer-polkavm-recorder" 2>/dev/null && pwd || true)}"
if [ -z "$POLKAVM_RECORDER_DIR" ] || [ ! -f "$POLKAVM_RECORDER_DIR/Cargo.toml" ]; then
  echo "ERROR: codetracer-polkavm-recorder repo not found."
  echo "  Tried: $EXTENSION_DIR/../codetracer-polkavm-recorder"
  echo "  Set POLKAVM_RECORDER_DIR to the path of the codetracer-polkavm-recorder repository."
  exit 1
fi

SOURCE_FILE="$POLKAVM_RECORDER_DIR/test-programs/polkavm/flow_test.pvm"
if [ ! -f "$SOURCE_FILE" ]; then
  echo "ERROR: PolkaVM test program not found at $SOURCE_FILE"
  exit 1
fi

echo "=== Preparing PolkaVM trace fixture ==="
echo "  PolkaVM recorder:  $POLKAVM_RECORDER_DIR"
echo "  Test program:      $SOURCE_FILE"
echo "  Fixture output:    $FIXTURE_DIR"
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
  echo "  Install the Rust toolchain or enter nix develop in $POLKAVM_RECORDER_DIR."
  exit 1
fi

# Build the recorder binary.
echo "Building codetracer-polkavm-recorder..."
if command -v direnv >/dev/null 2>&1 && [ -f "$POLKAVM_RECORDER_DIR/.envrc" ]; then
  direnv exec "$POLKAVM_RECORDER_DIR" cargo build --manifest-path "$POLKAVM_RECORDER_DIR/Cargo.toml"
else
  cargo build --manifest-path "$POLKAVM_RECORDER_DIR/Cargo.toml"
fi

# Locate the built binary
RECORDER_BIN="$POLKAVM_RECORDER_DIR/target/debug/codetracer-polkavm-recorder"
if [ ! -x "$RECORDER_BIN" ]; then
  echo "ERROR: Recorder binary not found at $RECORDER_BIN"
  echo "  Build may have failed — check the cargo output above."
  exit 1
fi

# Create the fixture directory
rm -rf "$FIXTURE_DIR"
mkdir -p "$FIXTURE_DIR"

echo "Recording PolkaVM trace..."
"$RECORDER_BIN" record "$SOURCE_FILE" --out-dir "$FIXTURE_DIR"

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
if [ ! -f "$FIXTURE_DIR/flow_test.pvm" ]; then
  cp "$SOURCE_FILE" "$FIXTURE_DIR/flow_test.pvm"
fi

echo ""
echo "=== PolkaVM trace fixture ready ==="
echo "  Location: $FIXTURE_DIR"
echo "  Files:"
ls -la "$FIXTURE_DIR"
echo ""
echo "You can now run the WDIO smoke test:"
echo "  npm run test:wdio:polkavm"
