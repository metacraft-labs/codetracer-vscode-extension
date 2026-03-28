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
if [ -d "$FIXTURE_DIR" ] && [ -f "$FIXTURE_DIR/trace_metadata.json" ] && [ -z "${FORCE:-}" ]; then
  if [ -f "$FIXTURE_DIR/trace.json" ] || [ -f "$FIXTURE_DIR/trace.bin" ]; then
    echo "Fixture already exists (use FORCE=1 to re-record)."
    echo "  Location: $FIXTURE_DIR"
    exit 0
  fi
fi

# Check prerequisites
if ! command -v solc >/dev/null 2>&1; then
  echo "ERROR: solc not found on PATH."
  echo "  Install solc or enter nix develop in $EVM_RECORDER_DIR."
  exit 1
fi
if ! command -v anvil >/dev/null 2>&1; then
  echo "ERROR: anvil not found on PATH."
  echo "  Install Foundry (https://getfoundry.sh) or enter nix develop in $EVM_RECORDER_DIR."
  exit 1
fi
if ! command -v cargo >/dev/null 2>&1; then
  echo "ERROR: cargo not found on PATH."
  exit 1
fi

# Create the fixture directory
rm -rf "$FIXTURE_DIR"
mkdir -p "$FIXTURE_DIR"

echo "Running EVM recorder e2e test with fixture export..."
cd "$EVM_RECORDER_DIR"

# Run the ignored e2e test with the fixture output directory set.
# The test compiles FlowTest.sol, deploys to anvil, calls compute(), and
# writes trace files to SOLIDITY_FIXTURE_OUTPUT_DIR.
SOLIDITY_FIXTURE_OUTPUT_DIR="$FIXTURE_DIR" \
  cargo test --test test_e2e_trace -- --ignored --nocapture test_e2e_trace

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

# The test program for the trace is FlowTest.sol; copy it alongside the trace
# files so the DAP server can resolve source references.
if [ ! -f "$FIXTURE_DIR/FlowTest.sol" ]; then
  cp "$CONTRACT_SOL" "$FIXTURE_DIR/FlowTest.sol"
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
