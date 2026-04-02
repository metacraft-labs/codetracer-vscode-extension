#!/usr/bin/env bash
# Prepare a pre-recorded Cadence (Flow) trace fixture for WDIO tests.
#
# This script builds the codetracer-flow-recorder, runs it against the
# flow_test.cdc test program, and copies the resulting trace to the fixture
# directory used by the VS Code extension's WDIO smoke tests.
#
# The fixture trace covers:
#   - compute function in Cadence
#   - Resource-oriented operations
#   - Cadence/Flow VM tracer
#
# Prerequisites:
#   - cargo (Rust toolchain) on PATH
#   - codetracer-flow-recorder repo at ../codetracer-flow-recorder (relative
#     to this extension repo) or at $CADENCE_RECORDER_DIR
#
# Usage:
#   ./scripts/prepare-cadence-fixture.sh
#
# Environment variables:
#   CADENCE_RECORDER_DIR  — override path to codetracer-flow-recorder repo
#   FORCE=1               — re-record even if fixture already exists

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/recorder-shell-exec.sh"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_DIR="$(dirname "$SCRIPT_DIR")"
FIXTURE_DIR="$EXTENSION_DIR/test/traces/cadence-flow-test"

# Locate the codetracer-flow-recorder repo (sibling directory)
CADENCE_RECORDER_DIR="${CADENCE_RECORDER_DIR:-$(cd "$EXTENSION_DIR/../codetracer-flow-recorder" 2>/dev/null && pwd || true)}"
if [ -z "$CADENCE_RECORDER_DIR" ] || [ ! -d "$CADENCE_RECORDER_DIR" ]; then
  echo "ERROR: codetracer-flow-recorder repo not found."
  echo "  Tried: $EXTENSION_DIR/../codetracer-flow-recorder"
  echo "  Set CADENCE_RECORDER_DIR to the path of the codetracer-flow-recorder repository."
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

# The Flow recorder is Rust-based with a Go helper binary (cadence-trace-helper)
# that uses the real Cadence runtime to execute Cadence programs and emit NDJSON
# trace events for the Rust recorder to consume.
if [ ! -f "$CADENCE_RECORDER_DIR/Cargo.toml" ]; then
  echo "ERROR: No Cargo.toml found in $CADENCE_RECORDER_DIR."
  exit 1
fi

# Build the Go helper first — the recorder needs it to execute Cadence programs.
if [ -d "$CADENCE_RECORDER_DIR/go-helper" ]; then
  echo "Building cadence-trace-helper (Go helper)..."
  recorder_exec "$CADENCE_RECORDER_DIR" bash -c \
    "cd \"$CADENCE_RECORDER_DIR/go-helper\" && go mod download && go build -o cadence-trace-helper ."
  HELPER_BIN="$CADENCE_RECORDER_DIR/go-helper/cadence-trace-helper"
  if [ ! -x "$HELPER_BIN" ]; then
    echo "ERROR: cadence-trace-helper binary not found at $HELPER_BIN"
    echo "  Go build may have failed — check the output above."
    exit 1
  fi
  export CADENCE_HELPER_BIN="$HELPER_BIN"
  echo "  Go helper built: $HELPER_BIN"
fi

echo "Building codetracer-flow-recorder (Rust)..."
recorder_exec "$CADENCE_RECORDER_DIR" cargo build --manifest-path "$CADENCE_RECORDER_DIR/Cargo.toml"
RECORDER_BIN="$CADENCE_RECORDER_DIR/target/debug/codetracer-flow-recorder"

if [ ! -x "$RECORDER_BIN" ]; then
  echo "ERROR: Recorder binary not found at $RECORDER_BIN"
  echo "  Build may have failed — check the output above."
  exit 1
fi

# Create the fixture directory
rm -rf "$FIXTURE_DIR"
mkdir -p "$FIXTURE_DIR"

echo "Recording Cadence trace..."
recorder_exec "$CADENCE_RECORDER_DIR" "$RECORDER_BIN" record "$SOURCE_FILE" --out-dir "$FIXTURE_DIR"

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
