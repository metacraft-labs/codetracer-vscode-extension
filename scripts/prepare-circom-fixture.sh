#!/usr/bin/env bash
# Prepare a pre-recorded Circom trace fixture for WDIO tests.
#
# This script builds the codetracer-circom-recorder, runs it against the
# flow_test.circom test circuit, and copies the resulting trace to the fixture
# directory used by the VS Code extension's WDIO smoke tests.
#
# The fixture trace covers:
#   - compute template in Circom
#   - Signal constraint operations
#   - Circom Wasm witness generation tracer
#
# Prerequisites:
#   - cargo (Rust toolchain) on PATH
#   - codetracer-circom-recorder repo at ../codetracer-circom-recorder (relative
#     to this extension repo) or at $CIRCOM_RECORDER_DIR
#
# Usage:
#   ./scripts/prepare-circom-fixture.sh
#
# Environment variables:
#   CIRCOM_RECORDER_DIR  — override path to codetracer-circom-recorder repo
#   FORCE=1              — re-record even if fixture already exists

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/recorder-shell-exec.sh"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_DIR="$(dirname "$SCRIPT_DIR")"
FIXTURE_DIR="$EXTENSION_DIR/test/traces/circom-flow-test"

# Locate the codetracer-circom-recorder repo (sibling directory)
CIRCOM_RECORDER_DIR="${CIRCOM_RECORDER_DIR:-$(cd "$EXTENSION_DIR/../codetracer-circom-recorder" 2>/dev/null && pwd || true)}"
if [ -z "$CIRCOM_RECORDER_DIR" ] || [ ! -f "$CIRCOM_RECORDER_DIR/Cargo.toml" ]; then
  echo "ERROR: codetracer-circom-recorder repo not found."
  echo "  Tried: $EXTENSION_DIR/../codetracer-circom-recorder"
  echo "  Set CIRCOM_RECORDER_DIR to the path of the codetracer-circom-recorder repository."
  exit 1
fi

SOURCE_FILE="$CIRCOM_RECORDER_DIR/test-programs/circom/flow_test.circom"
if [ ! -f "$SOURCE_FILE" ]; then
  echo "ERROR: Circom test circuit not found at $SOURCE_FILE"
  exit 1
fi

echo "=== Preparing Circom trace fixture ==="
echo "  Circom recorder:  $CIRCOM_RECORDER_DIR"
echo "  Test circuit:     $SOURCE_FILE"
echo "  Fixture output:   $FIXTURE_DIR"
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

echo "Building codetracer-circom-recorder..."
recorder_exec "$CIRCOM_RECORDER_DIR" cargo build --manifest-path "$CIRCOM_RECORDER_DIR/Cargo.toml"

# Locate the built binary
RECORDER_BIN="$CIRCOM_RECORDER_DIR/target/debug/codetracer-circom-recorder"
if [ ! -x "$RECORDER_BIN" ]; then
  echo "ERROR: Recorder binary not found at $RECORDER_BIN"
  echo "  Build may have failed — check the cargo output above."
  exit 1
fi

# Create the fixture directory
rm -rf "$FIXTURE_DIR"
mkdir -p "$FIXTURE_DIR"

echo "Recording Circom trace..."
recorder_exec "$CIRCOM_RECORDER_DIR" "$RECORDER_BIN" record "$SOURCE_FILE" --out-dir "$FIXTURE_DIR"

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
if [ ! -f "$FIXTURE_DIR/flow_test.circom" ]; then
  cp "$SOURCE_FILE" "$FIXTURE_DIR/flow_test.circom"
fi

echo ""
echo "=== Circom trace fixture ready ==="
echo "  Location: $FIXTURE_DIR"
echo "  Files:"
ls -la "$FIXTURE_DIR"
echo ""
echo "You can now run the WDIO smoke test:"
echo "  npm run test:wdio:circom"
