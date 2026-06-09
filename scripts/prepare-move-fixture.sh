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

source "$(dirname "${BASH_SOURCE[0]}")/recorder-shell-exec.sh"

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
if [ -d "$FIXTURE_DIR" ] && [ -z "${FORCE:-}" ]; then
  if compgen -G "$FIXTURE_DIR/*.ct" >/dev/null \
    || { [ -f "$FIXTURE_DIR/trace_metadata.json" ] && \
         { [ -f "$FIXTURE_DIR/trace.json" ] || [ -f "$FIXTURE_DIR/trace.bin" ]; }; }; then
    echo "Fixture already exists (use FORCE=1 to re-record)."
    echo "  Location: $FIXTURE_DIR"
    exit 0
  fi
fi

echo "Building codetracer-move-recorder..."
recorder_exec "$MOVE_RECORDER_DIR" cargo build --manifest-path "$MOVE_RECORDER_DIR/Cargo.toml"

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

# Step 1: Run `sui move test --trace` to produce the NDJSON trace.
# The trace files are written into <package>/build/<PackageName>/traces/.
MOVE_PACKAGE_DIR="$MOVE_RECORDER_DIR/test-programs/move/flow_test"
# The Sui CLI flag varies by version: newer versions use --trace, older
# versions use --trace-execution.  Try --trace first (matches CI Nix dev shell),
# fall back to --trace-execution if that fails.
echo "Running sui move test --trace in $MOVE_PACKAGE_DIR ..."
if ! recorder_exec "$MOVE_RECORDER_DIR" sui move test --trace --path "$MOVE_PACKAGE_DIR" 2>/dev/null; then
  echo "  --trace not recognized, trying --trace-execution..."
  recorder_exec "$MOVE_RECORDER_DIR" sui move test --trace-execution --path "$MOVE_PACKAGE_DIR"
fi

# Step 2: Find the NDJSON trace file(s).
# Newer Sui versions (≥1.68) write traces to <package>/traces/ at the package
# root.  Older versions wrote them to build/<PackageName>/traces/.  Search
# both locations.
TRACE_FILE=""

# Primary: look in <package>/traces/ (current Sui behaviour).
# Prefer the test_computation trace since that's what the WDIO smoke test expects.
TRACES_DIR="$MOVE_PACKAGE_DIR/traces"
if [ -d "$TRACES_DIR" ]; then
  # First try to find the specific test_computation trace
  for f in $(find "$TRACES_DIR" -type f -name '*test_computation*' \( -name '*.json.zst' -o -name '*.json' \) 2>/dev/null); do
    TRACE_FILE="$f"
    break
  done
  # Fall back to any trace file
  if [ -z "$TRACE_FILE" ]; then
    for f in $(find "$TRACES_DIR" -type f \( -name '*.json.zst' -o -name '*.json' \) 2>/dev/null); do
      TRACE_FILE="$f"
      break
    done
  fi
fi

# Fallback: look in build/**/traces/ (older Sui behaviour)
if [ -z "$TRACE_FILE" ]; then
  BUILD_DIR="$MOVE_PACKAGE_DIR/build"
  if [ -d "$BUILD_DIR" ]; then
    for f in $(find "$BUILD_DIR" -type f \( -name '*.json.zst' -o -name '*.json' \) -path '*/traces/*' 2>/dev/null); do
      TRACE_FILE="$f"
      break
    done
  fi
fi

# Last-resort fallback: any .json file in the build directory that starts with
# the Move trace version header ({"version":3} on the first line, NDJSON).
if [ -z "$TRACE_FILE" ]; then
  BUILD_DIR="$MOVE_PACKAGE_DIR/build"
  if [ -d "$BUILD_DIR" ]; then
    for f in $(find "$BUILD_DIR" -type f -name '*.json' \
      ! -path '*/dependencies/*' ! -path '*/disassembly/*' 2>/dev/null); do
      if head -n 1 "$f" 2>/dev/null | grep -q '"version"[[:space:]]*:[[:space:]]*3'; then
        TRACE_FILE="$f"
        break
      fi
    done
  fi
fi

if [ -z "$TRACE_FILE" ]; then
  echo "ERROR: No NDJSON trace file found after running sui move test."
  echo "  Searched: $MOVE_PACKAGE_DIR/traces/ and $MOVE_PACKAGE_DIR/build/**/traces/"
  echo "  Package directory contents:"
  find "$MOVE_PACKAGE_DIR" -type f \( -name '*.json' -o -name '*.json.zst' \) 2>/dev/null | head -20
  exit 1
fi

echo "Found trace file: $TRACE_FILE"

# Step 3: Convert the NDJSON trace into CodeTracer format using the recorder.
echo "Recording Move trace..."
recorder_exec "$MOVE_RECORDER_DIR" "$RECORDER_BIN" record \
  --source "$SOURCE_FILE" \
  --format binary \
  -o "$FIXTURE_DIR" \
  "$TRACE_FILE"

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
