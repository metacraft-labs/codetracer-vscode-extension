#!/usr/bin/env bash
# Prepare a pre-recorded Solidity (EVM) trace fixture for WDIO tests.
#
# This script compiles the FlowTest.sol contract with solc, deploys it to a
# local anvil devnode, sends a compute() transaction, and records the EVM trace
# via the codetracer-evm-recorder. The resulting fixture is written to the
# directory used by the VS Code extension's WDIO tests.
#
# The fixture trace covers:
#   - compute() calling the internal add() helper
#   - Two SSTORE operations (storedA, storedResult)
#   - One LOG operation (Computed event)
#
# Prerequisites:
#   - solc (Solidity compiler) on PATH
#   - anvil (Foundry devnode) on PATH
#   - cargo (Rust toolchain) on PATH
#   - codetracer-evm-recorder repo at ../codetracer-evm-recorder (relative to
#     this extension repo) or at $EVM_RECORDER_DIR
#
# Usage:
#   ./scripts/prepare-solidity-fixture.sh
#
# Environment variables:
#   EVM_RECORDER_DIR  — override path to codetracer-evm-recorder repo
#   FORCE=1           — re-record even if fixture already exists

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/recorder-shell-exec.sh"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_DIR="$(dirname "$SCRIPT_DIR")"
FIXTURE_DIR="$EXTENSION_DIR/test/traces/solidity-flow-test"

# Locate the codetracer-evm-recorder repo (sibling directory)
EVM_RECORDER_DIR="${EVM_RECORDER_DIR:-$(cd "$EXTENSION_DIR/../codetracer-evm-recorder" 2>/dev/null && pwd || true)}"
if [ -z "$EVM_RECORDER_DIR" ] || [ ! -d "$EVM_RECORDER_DIR/contracts" ]; then
  echo "ERROR: codetracer-evm-recorder repo not found."
  echo "  Tried: $EXTENSION_DIR/../codetracer-evm-recorder"
  echo "  Set EVM_RECORDER_DIR to the path of the codetracer-evm-recorder repository."
  exit 1
fi

CONTRACT_SOL="$EVM_RECORDER_DIR/contracts/FlowTest.sol"
if [ ! -f "$CONTRACT_SOL" ]; then
  echo "ERROR: FlowTest.sol not found at $CONTRACT_SOL"
  exit 1
fi

echo "=== Preparing Solidity (EVM) trace fixture ==="
echo "  EVM recorder:   $EVM_RECORDER_DIR"
echo "  Contract:       $CONTRACT_SOL"
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

echo "Building codetracer-evm-recorder..."
recorder_exec "$EVM_RECORDER_DIR" cargo build --manifest-path "$EVM_RECORDER_DIR/Cargo.toml"

# Locate the built binary
RECORDER_BIN="$EVM_RECORDER_DIR/target/debug/codetracer-evm-recorder"
if [ ! -x "$RECORDER_BIN" ]; then
  echo "ERROR: Recorder binary not found at $RECORDER_BIN"
  echo "  Build may have failed — check the cargo output above."
  exit 1
fi

# Create the fixture directory
rm -rf "$FIXTURE_DIR"
mkdir -p "$FIXTURE_DIR"

# The CLI record command does the full pipeline:
#   1. Compile the Solidity file with solc
#   2. Spin up a local Anvil node (with --steps-tracing)
#   3. Deploy the contract
#   4. Call the specified function (compute)
#   5. Fetch debug_traceTransaction structlogs
#   6. Run the EVM recorder pipeline
#   7. Write trace.bin, trace_metadata.json, trace_paths.json
#   8. Copy the source file into the trace directory
echo "Recording Solidity trace..."
recorder_exec "$EVM_RECORDER_DIR" "$RECORDER_BIN" record "$CONTRACT_SOL" \
  --trace-dir "$FIXTURE_DIR" --function compute

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

echo ""
echo "=== Solidity trace fixture ready ==="
echo "  Location: $FIXTURE_DIR"
echo "  Files:"
ls -la "$FIXTURE_DIR"
echo ""
echo "You can now run the WDIO smoke test:"
echo "  npm run test:wdio:solidity"
echo ""
echo "Or the full deep test:"
echo "  npm run test:wdio:solidity:deep"
