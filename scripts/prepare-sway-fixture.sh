#!/usr/bin/env bash
# Prepare a pre-recorded Sway (Fuel) trace fixture for WDIO tests.
#
# This script builds the codetracer-fuel-recorder, runs it against the Sway
# flow_test contract, and copies the resulting trace to the fixture directory
# used by the VS Code extension's WDIO smoke tests.
#
# The fixture trace covers:
#   - main() entrypoint of the Sway flow_test contract
#   - Arithmetic on u64 values (sum_val)
#   - Fuel VM execution path
#
# Prerequisites:
#   - cargo (Rust toolchain) on PATH
#   - codetracer-fuel-recorder repo at ../codetracer-fuel-recorder (relative
#     to this extension repo) or at $FUEL_RECORDER_DIR
#
# Usage:
#   ./scripts/prepare-sway-fixture.sh
#
# Environment variables:
#   FUEL_RECORDER_DIR  — override path to codetracer-fuel-recorder repo
#   FORCE=1            — re-record even if fixture already exists

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_DIR="$(dirname "$SCRIPT_DIR")"
FIXTURE_DIR="$EXTENSION_DIR/test/traces/sway-flow-test"

# Locate the codetracer-fuel-recorder repo (sibling directory)
FUEL_RECORDER_DIR="${FUEL_RECORDER_DIR:-$(cd "$EXTENSION_DIR/../codetracer-fuel-recorder" 2>/dev/null && pwd || true)}"
if [ -z "$FUEL_RECORDER_DIR" ] || [ ! -f "$FUEL_RECORDER_DIR/Cargo.toml" ]; then
  echo "ERROR: codetracer-fuel-recorder repo not found."
  echo "  Tried: $EXTENSION_DIR/../codetracer-fuel-recorder"
  echo "  Set FUEL_RECORDER_DIR to the path of the codetracer-fuel-recorder repository."
  exit 1
fi

PROJECT_DIR="$FUEL_RECORDER_DIR/test-programs/flow_test"
SOURCE_FILE="$PROJECT_DIR/src/main.sw"
if [ ! -f "$SOURCE_FILE" ]; then
  echo "ERROR: Sway flow_test source not found at $SOURCE_FILE"
  exit 1
fi

echo "=== Preparing Sway (Fuel) trace fixture ==="
echo "  Fuel recorder:  $FUEL_RECORDER_DIR"
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
  echo "  Install the Rust toolchain or enter nix develop in $FUEL_RECORDER_DIR."
  exit 1
fi

# Build the recorder binary
echo "Building codetracer-fuel-recorder..."
if command -v direnv >/dev/null 2>&1 && [ -f "$FUEL_RECORDER_DIR/.envrc" ]; then
  direnv exec "$FUEL_RECORDER_DIR" cargo build --manifest-path "$FUEL_RECORDER_DIR/Cargo.toml"
else
  cargo build --manifest-path "$FUEL_RECORDER_DIR/Cargo.toml"
fi

# Locate the built binary
RECORDER_BIN="$FUEL_RECORDER_DIR/target/debug/codetracer-fuel-recorder"
if [ ! -x "$RECORDER_BIN" ]; then
  echo "ERROR: Recorder binary not found at $RECORDER_BIN"
  echo "  Build may have failed — check the cargo output above."
  exit 1
fi

# Create the fixture directory
rm -rf "$FIXTURE_DIR"
mkdir -p "$FIXTURE_DIR"

echo "Recording Sway trace..."
"$RECORDER_BIN" record "$PROJECT_DIR" -o "$FIXTURE_DIR"

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
if [ ! -f "$FIXTURE_DIR/main.sw" ]; then
  cp "$SOURCE_FILE" "$FIXTURE_DIR/main.sw"
fi

echo ""
echo "=== Sway trace fixture ready ==="
echo "  Location: $FIXTURE_DIR"
echo "  Files:"
ls -la "$FIXTURE_DIR"
echo ""
echo "You can now run the WDIO smoke test:"
echo "  npm run test:wdio:sway"
