#!/usr/bin/env bash
# Prepare a pre-recorded PolkaVM trace fixture for WDIO tests.
#
# PolkaVM test programs are built programmatically using polkavm-common's
# ProgramBlobBuilder (avoiding the need for a RISC-V cross-compiler). This
# script runs the recorder's export_fixture test which constructs a compute
# program blob, records the trace, and writes it to the fixture directory.
#
# The fixture trace covers:
#   - compute function: (10 + 32) * 2 + 10 = 94
#   - Register-based arithmetic operations (A0, A1, S0, S1)
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

source "$(dirname "${BASH_SOURCE[0]}")/recorder-shell-exec.sh"

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

echo "=== Preparing PolkaVM trace fixture ==="
echo "  PolkaVM recorder:  $POLKAVM_RECORDER_DIR"
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

# Create the fixture directory
rm -rf "$FIXTURE_DIR"
mkdir -p "$FIXTURE_DIR"

# The export_fixture test builds a compute program blob programmatically using
# ProgramBlobBuilder (no RISC-V cross-compiler needed), runs the tracer on it,
# and writes the output to POLKAVM_FIXTURE_OUTPUT_DIR.
echo "Running PolkaVM recorder export_fixture test..."
recorder_exec "$POLKAVM_RECORDER_DIR" bash -c \
  "cd \"$POLKAVM_RECORDER_DIR\" && POLKAVM_FIXTURE_OUTPUT_DIR=\"$FIXTURE_DIR\" cargo test --test test_tracer -- --ignored export_fixture --nocapture"

# Verify the fixture was created
if [ ! -f "$FIXTURE_DIR/trace_metadata.json" ]; then
  echo "ERROR: Fixture generation failed — trace_metadata.json not found."
  echo "  Check the cargo test output above for errors."
  exit 1
fi

if [ ! -f "$FIXTURE_DIR/trace.json" ] && [ ! -f "$FIXTURE_DIR/trace.bin" ]; then
  echo "ERROR: Fixture generation failed — neither trace.json nor trace.bin found."
  exit 1
fi

echo ""
echo "=== PolkaVM trace fixture ready ==="
echo "  Location: $FIXTURE_DIR"
echo "  Files:"
ls -la "$FIXTURE_DIR"
echo ""
echo "You can now run the WDIO smoke test:"
echo "  npm run test:wdio:polkavm"
