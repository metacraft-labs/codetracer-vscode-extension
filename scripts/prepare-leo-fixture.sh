#!/usr/bin/env bash
# Prepare a pre-recorded Leo (Aleo) trace fixture for WDIO tests.
#
# This script builds the codetracer-leo-recorder, runs it against the
# flow_test.leo test program, and copies the resulting trace to the fixture
# directory used by the VS Code extension's WDIO smoke tests.
#
# The fixture trace covers:
#   - compute transition in Leo
#   - Field-element arithmetic operations
#   - Leo interpreter tracer on the Aleo VM
#
# Prerequisites:
#   - cargo (Rust toolchain) on PATH
#   - codetracer-leo-recorder repo at ../codetracer-leo-recorder (relative
#     to this extension repo) or at $LEO_RECORDER_DIR
#
# Usage:
#   ./scripts/prepare-leo-fixture.sh
#
# Environment variables:
#   LEO_RECORDER_DIR  — override path to codetracer-leo-recorder repo
#   FORCE=1           — re-record even if fixture already exists

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/recorder-shell-exec.sh"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_DIR="$(dirname "$SCRIPT_DIR")"
FIXTURE_DIR="$EXTENSION_DIR/test/traces/leo-flow-test"

# Locate the codetracer-leo-recorder repo (sibling directory)
LEO_RECORDER_DIR="${LEO_RECORDER_DIR:-$(cd "$EXTENSION_DIR/../codetracer-leo-recorder" 2>/dev/null && pwd || true)}"
if [ -z "$LEO_RECORDER_DIR" ] || [ ! -f "$LEO_RECORDER_DIR/Cargo.toml" ]; then
  echo "ERROR: codetracer-leo-recorder repo not found."
  echo "  Tried: $EXTENSION_DIR/../codetracer-leo-recorder"
  echo "  Set LEO_RECORDER_DIR to the path of the codetracer-leo-recorder repository."
  exit 1
fi

SOURCE_FILE="$LEO_RECORDER_DIR/test-programs/leo/flow_test.leo"
if [ ! -f "$SOURCE_FILE" ]; then
  echo "ERROR: Leo test program not found at $SOURCE_FILE"
  exit 1
fi

echo "=== Preparing Leo (Aleo) trace fixture ==="
echo "  Leo recorder:  $LEO_RECORDER_DIR"
echo "  Test program:  $SOURCE_FILE"
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

echo "Building codetracer-leo-recorder..."
recorder_exec "$LEO_RECORDER_DIR" cargo build --manifest-path "$LEO_RECORDER_DIR/Cargo.toml"

# Locate the built binary
RECORDER_BIN="$LEO_RECORDER_DIR/target/debug/codetracer-leo-recorder"
if [ ! -x "$RECORDER_BIN" ]; then
  echo "ERROR: Recorder binary not found at $RECORDER_BIN"
  echo "  Build may have failed — check the cargo output above."
  exit 1
fi

# Create the fixture directory
rm -rf "$FIXTURE_DIR"
mkdir -p "$FIXTURE_DIR"

echo "Recording Leo trace..."
recorder_exec "$LEO_RECORDER_DIR" "$RECORDER_BIN" record "$SOURCE_FILE" --out-dir "$FIXTURE_DIR"

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
if [ ! -f "$FIXTURE_DIR/flow_test.leo" ]; then
  cp "$SOURCE_FILE" "$FIXTURE_DIR/flow_test.leo"
fi

echo ""
echo "=== Leo trace fixture ready ==="
echo "  Location: $FIXTURE_DIR"
echo "  Files:"
ls -la "$FIXTURE_DIR"
echo ""
echo "You can now run the WDIO smoke test:"
echo "  npm run test:wdio:leo"
