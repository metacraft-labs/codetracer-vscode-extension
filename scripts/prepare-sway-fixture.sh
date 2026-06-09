#!/usr/bin/env bash
# Prepare a pre-recorded Sway (Fuel) trace fixture for WDIO tests.
#
# The Fuel recorder's Sway project mode is not yet implemented, so this script
# uses the export_fixture test which builds a FuelVM bytecode program using
# fuel-asm (no Sway/forc compiler needed), records the trace, and writes it
# to the fixture directory.
#
# The fixture trace covers:
#   - Arithmetic operations: r16=10, r17=32, r18=42, r19=84, r20=94
#   - FuelVM instruction execution with register tracking
#   - Log and return operations
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

source "$(dirname "${BASH_SOURCE[0]}")/recorder-shell-exec.sh"

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

echo "=== Preparing Sway (Fuel) trace fixture ==="
echo "  Fuel recorder:  $FUEL_RECORDER_DIR"
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

# Create the fixture directory
rm -rf "$FIXTURE_DIR"
mkdir -p "$FIXTURE_DIR"

# The export_fixture test builds a FuelVM bytecode program using fuel-asm
# (avoiding the need for the forc compiler), records the trace, and writes
# the output to SWAY_FIXTURE_OUTPUT_DIR.
echo "Running Fuel recorder export_fixture test..."
recorder_exec "$FUEL_RECORDER_DIR" bash -c \
  "cd \"$FUEL_RECORDER_DIR\" && SWAY_FIXTURE_OUTPUT_DIR=\"$FIXTURE_DIR\" cargo test --test test_tracer -- --ignored export_fixture --nocapture"

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

# Copy the Sway source file alongside the trace so the DAP server can resolve
# source references.  The trace embeds a relative path "flow_test.sw", so we
# copy the real test-program source under that name.
SWAY_SOURCE="$FUEL_RECORDER_DIR/test-programs/flow_test/src/main.sw"
if [ -f "$SWAY_SOURCE" ] && [ ! -f "$FIXTURE_DIR/flow_test.sw" ]; then
  cp "$SWAY_SOURCE" "$FIXTURE_DIR/flow_test.sw"
fi

# Patch trace_metadata.json so that "workdir" points to the fixture directory.
# The recorder writes the CWD at recording time, but the db-backend joins
# workdir + relative source path to resolve files.  After copying the source
# file above, the fixture directory is the correct workdir.
if command -v python3 &>/dev/null; then
  python3 -c "
import json, sys
p = '$FIXTURE_DIR/trace_metadata.json'
with open(p) as f:
    meta = json.load(f)
meta['workdir'] = '$FIXTURE_DIR'
with open(p, 'w') as f:
    json.dump(meta, f)
"
  echo "Patched trace_metadata.json workdir → $FIXTURE_DIR"
elif command -v jq &>/dev/null; then
  tmp="$FIXTURE_DIR/trace_metadata.tmp.json"
  jq --arg w "$FIXTURE_DIR" '.workdir = $w' "$FIXTURE_DIR/trace_metadata.json" > "$tmp"
  mv "$tmp" "$FIXTURE_DIR/trace_metadata.json"
  echo "Patched trace_metadata.json workdir → $FIXTURE_DIR"
else
  echo "WARNING: neither python3 nor jq found — cannot patch trace_metadata.json workdir."
  echo "  The DAP server may fail to resolve source files."
fi

echo ""
echo "=== Sway trace fixture ready ==="
echo "  Location: $FIXTURE_DIR"
echo "  Files:"
ls -la "$FIXTURE_DIR"
echo ""
echo "You can now run the WDIO smoke test:"
echo "  npm run test:wdio:sway"
