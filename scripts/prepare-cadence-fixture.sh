#!/usr/bin/env bash
# Prepare a pre-recorded Cadence (Flow) trace fixture for WDIO tests.
#
# This script builds the codetracer-cadence-recorder, runs it against the
# flow_test.cdc test program, and copies the resulting trace to the fixture
# directory used by the VS Code extension's WDIO smoke tests.
#
# The fixture trace covers:
#   - compute function in Cadence
#   - Resource-oriented operations
#   - Cadence/Flow VM tracer
#
# Prerequisites:
#   - go toolchain on PATH (Cadence recorder is written in Go)
#   - codetracer-cadence-recorder repo at ../codetracer-cadence-recorder (relative
#     to this extension repo) or at $CADENCE_RECORDER_DIR
#
# Usage:
#   ./scripts/prepare-cadence-fixture.sh
#
# Environment variables:
#   CADENCE_RECORDER_DIR  — override path to codetracer-cadence-recorder repo
#   FORCE=1               — re-record even if fixture already exists

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_DIR="$(dirname "$SCRIPT_DIR")"
FIXTURE_DIR="$EXTENSION_DIR/test/traces/cadence-flow-test"

# Locate the codetracer-cadence-recorder repo (sibling directory)
CADENCE_RECORDER_DIR="${CADENCE_RECORDER_DIR:-$(cd "$EXTENSION_DIR/../codetracer-cadence-recorder" 2>/dev/null && pwd || true)}"
if [ -z "$CADENCE_RECORDER_DIR" ] || [ ! -d "$CADENCE_RECORDER_DIR" ]; then
  echo "ERROR: codetracer-cadence-recorder repo not found."
  echo "  Tried: $EXTENSION_DIR/../codetracer-cadence-recorder"
  echo "  Set CADENCE_RECORDER_DIR to the path of the codetracer-cadence-recorder repository."
  exit 1
fi

SOURCE_FILE="$CADENCE_RECORDER_DIR/test-programs/cadence/flow_test.cdc"
if [ ! -f "$SOURCE_FILE" ]; then
  echo "ERROR: Cadence test program not found at $SOURCE_FILE"
  exit 1
fi

echo "=== Preparing Cadence (Flow) trace fixture ==="
echo "  Cadence recorder:  $CADENCE_RECORDER_DIR"
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

# The Cadence recorder may be Go-based or Rust-based depending on version.
# Try to build with the available toolchain.
if [ -f "$CADENCE_RECORDER_DIR/Cargo.toml" ]; then
  if ! command -v cargo >/dev/null 2>&1; then
    echo "ERROR: cargo not found on PATH."
    echo "  Install the Rust toolchain or enter nix develop in $CADENCE_RECORDER_DIR."
    exit 1
  fi

  echo "Building codetracer-cadence-recorder (Rust)..."
  if command -v direnv >/dev/null 2>&1 && [ -f "$CADENCE_RECORDER_DIR/.envrc" ]; then
    direnv exec "$CADENCE_RECORDER_DIR" cargo build --manifest-path "$CADENCE_RECORDER_DIR/Cargo.toml"
  else
    cargo build --manifest-path "$CADENCE_RECORDER_DIR/Cargo.toml"
  fi
  RECORDER_BIN="$CADENCE_RECORDER_DIR/target/debug/codetracer-cadence-recorder"
elif [ -f "$CADENCE_RECORDER_DIR/go.mod" ]; then
  if ! command -v go >/dev/null 2>&1; then
    echo "ERROR: go not found on PATH."
    echo "  Install the Go toolchain or enter nix develop in $CADENCE_RECORDER_DIR."
    exit 1
  fi

  echo "Building codetracer-cadence-recorder (Go)..."
  if command -v direnv >/dev/null 2>&1 && [ -f "$CADENCE_RECORDER_DIR/.envrc" ]; then
    direnv exec "$CADENCE_RECORDER_DIR" go build -o "$CADENCE_RECORDER_DIR/codetracer-cadence-recorder" "$CADENCE_RECORDER_DIR/cmd/recorder"
  else
    (cd "$CADENCE_RECORDER_DIR" && go build -o codetracer-cadence-recorder ./cmd/recorder)
  fi
  RECORDER_BIN="$CADENCE_RECORDER_DIR/codetracer-cadence-recorder"
else
  echo "ERROR: No Cargo.toml or go.mod found in $CADENCE_RECORDER_DIR."
  exit 1
fi

if [ ! -x "$RECORDER_BIN" ]; then
  echo "ERROR: Recorder binary not found at $RECORDER_BIN"
  echo "  Build may have failed — check the output above."
  exit 1
fi

# Create the fixture directory
rm -rf "$FIXTURE_DIR"
mkdir -p "$FIXTURE_DIR"

echo "Recording Cadence trace..."
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
if [ ! -f "$FIXTURE_DIR/flow_test.cdc" ]; then
  cp "$SOURCE_FILE" "$FIXTURE_DIR/flow_test.cdc"
fi

echo ""
echo "=== Cadence trace fixture ready ==="
echo "  Location: $FIXTURE_DIR"
echo "  Files:"
ls -la "$FIXTURE_DIR"
echo ""
echo "You can now run the WDIO smoke test:"
echo "  npm run test:wdio:cadence"
