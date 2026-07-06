#!/usr/bin/env bash
# Prepare a pre-recorded Solana trace fixture for WDIO tests.
#
# This script builds the codetracer-solana-recorder, runs it against a Solana
# BPF test program, and copies the resulting trace to the fixture directory
# used by the VS Code extension's WDIO smoke tests.
#
# The fixture trace covers:
#   - process_instruction() entrypoint
#   - Arithmetic on u64 values (sum_val, doubled, final_result)
#   - solana_msg::msg! log output
#
# Prerequisites:
#   - cargo (Rust toolchain) on PATH
#   - codetracer-solana-recorder repo at ../codetracer-solana-recorder (relative
#     to this extension repo) or at $SOLANA_RECORDER_DIR
#
# Usage:
#   ./scripts/prepare-solana-fixture.sh
#
# Environment variables:
#   SOLANA_RECORDER_DIR  — override path to codetracer-solana-recorder repo
#   FORCE=1              — re-record even if fixture already exists

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/recorder-shell-exec.sh"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_DIR="$(dirname "$SCRIPT_DIR")"
FIXTURE_DIR="$EXTENSION_DIR/test/traces/solana-flow-test"

# Locate the codetracer-solana-recorder repo (sibling directory)
SOLANA_RECORDER_DIR="${SOLANA_RECORDER_DIR:-$(cd "$EXTENSION_DIR/../codetracer-solana-recorder" 2>/dev/null && pwd || true)}"
if [ -z "$SOLANA_RECORDER_DIR" ] || [ ! -f "$SOLANA_RECORDER_DIR/Cargo.toml" ]; then
  echo "ERROR: codetracer-solana-recorder repo not found."
  echo "  Tried: $EXTENSION_DIR/../codetracer-solana-recorder"
  echo "  Set SOLANA_RECORDER_DIR to the path of the codetracer-solana-recorder repository."
  exit 1
fi

SOURCE_FILE="$SOLANA_RECORDER_DIR/test-programs/src/solana_flow_test.rs"
if [ ! -f "$SOURCE_FILE" ]; then
  echo "ERROR: Solana test program not found at $SOURCE_FILE"
  exit 1
fi

echo "=== Preparing Solana trace fixture ==="
echo "  Solana recorder: $SOLANA_RECORDER_DIR"
echo "  Test program:    $SOURCE_FILE"
echo "  Fixture output:  $FIXTURE_DIR"
echo ""

# Skip if fixture already exists and FORCE is not set
if [ -d "$FIXTURE_DIR" ] && [ -z "${FORCE:-}" ]; then
  if [ -n "$(find $FIXTURE_DIR/*.ct -maxdepth 0 -print -quit 2>/dev/null)" ] \
    || { [ -f "$FIXTURE_DIR/trace_metadata.json" ] && \
         { [ -f "$FIXTURE_DIR/trace.json" ] || [ -f "$FIXTURE_DIR/trace.bin" ]; }; }; then
    echo "Fixture already exists (use FORCE=1 to re-record)."
    echo "  Location: $FIXTURE_DIR"
    exit 0
  fi
fi

echo "Building codetracer-solana-recorder..."
RECORDER_TARGET_DIR="$(recorder_target_dir "$SOLANA_RECORDER_DIR")"
recorder_exec "$SOLANA_RECORDER_DIR" env CARGO_TARGET_DIR="$RECORDER_TARGET_DIR" \
  cargo build --manifest-path "$SOLANA_RECORDER_DIR/Cargo.toml"

# Locate the built binary
RECORDER_BIN="$RECORDER_TARGET_DIR/debug/codetracer-solana-recorder"
if [ ! -x "$RECORDER_BIN" ]; then
  echo "ERROR: Recorder binary not found at $RECORDER_BIN"
  echo "  Build may have failed — check the cargo output above."
  exit 1
fi

# Compile the Solana test program to an SBF ELF binary.
# This requires cargo-build-sbf from the Solana SDK (available in the dev shell).
echo "Compiling Solana test program to SBF ELF..."
TEST_PROGRAM_DIR="$SOLANA_RECORDER_DIR/test-programs"
recorder_exec "$SOLANA_RECORDER_DIR" bash -c \
  "cd \"$TEST_PROGRAM_DIR\" && cargo build-sbf 2>&1"

# Locate the compiled ELF.  Prefer the *unstripped* ELF under
# ``target/sbpf-solana-solana/release/`` -- ``cargo-build-sbf`` runs
# ``llvm-objcopy --strip-all`` to produce the smaller
# ``target/deploy/test_programs.so`` it advertises for ``solana
# program deploy``, but the strip removes ``.debug_info`` / line
# tables and the recorder then can't map any PC back to
# ``solana_flow_test.rs``.  The unstripped variant carries the full
# DWARF (verified locally: ``llvm-dwarfdump --debug-info`` returns a
# populated ``Compile Unit`` against
# ``target/sbpf-solana-solana/release/test_programs.so`` while the
# ``deploy/`` copy is empty), executes identically (same bytecode --
# only debug sections differ), and is what the recorder needs to
# emit step/locals/event events in the CTFS trace that the WDIO
# smoke test expects.  Falls back to the stripped ``deploy/`` copy
# if the unstripped artefact is not present (older builds or a
# cargo-build-sbf version that doesn't write the intermediate path).
ELF_FILE="$TEST_PROGRAM_DIR/target/sbpf-solana-solana/release/test_programs.so"
if [ ! -f "$ELF_FILE" ]; then
  ELF_FILE="$TEST_PROGRAM_DIR/target/deploy/test_programs.so"
fi
if [ ! -f "$ELF_FILE" ]; then
  # Try alternative locations
  ELF_FILE="$(find "$TEST_PROGRAM_DIR/target" -name "*.so" -path "*/deploy/*" 2>/dev/null | head -1)"
  if [ -z "$ELF_FILE" ] || [ ! -f "$ELF_FILE" ]; then
    echo "ERROR: Compiled .so ELF not found after cargo build-sbf."
    echo "  Expected: $TEST_PROGRAM_DIR/target/sbpf-solana-solana/release/test_programs.so"
    echo "  Fallback: $TEST_PROGRAM_DIR/target/deploy/test_programs.so"
    exit 1
  fi
fi

echo "  Compiled ELF: $ELF_FILE"

# Create the fixture directory
rm -rf "$FIXTURE_DIR"
mkdir -p "$FIXTURE_DIR"

echo "Recording Solana trace..."
recorder_exec "$SOLANA_RECORDER_DIR" "$RECORDER_BIN" record -o "$FIXTURE_DIR" "$ELF_FILE"

# Verify the fixture was created.  The recorder may write either the
# legacy JSON-only layout (``trace_metadata.json`` + ``trace.json|.bin``)
# or the CTFS binary container layout (a single ``trace.bin`` or one or
# more ``*.ct`` files with embedded meta.dat).  Accept either, matching
# the early-skip check at the top of this script.
if [ -n "$(find $FIXTURE_DIR/*.ct -maxdepth 0 -print -quit 2>/dev/null)" ]; then
  echo "Recorder produced CTFS trace container (*.ct)."
elif [ -f "$FIXTURE_DIR/trace_metadata.json" ]; then
  echo "Recorder produced legacy JSON metadata."
  if [ ! -f "$FIXTURE_DIR/trace.json" ] && [ ! -f "$FIXTURE_DIR/trace.bin" ]; then
    echo "NOTE: Solana recorder produced metadata only (placeholder mode)."
    echo "  Full trace support requires a --regs register trace file."
  fi
elif [ -f "$FIXTURE_DIR/trace.bin" ]; then
  echo "Recorder produced CTFS trace container (trace.bin with embedded meta.dat)."
else
  echo "ERROR: Fixture generation failed — no trace_metadata.json, *.ct, or trace.bin found in $FIXTURE_DIR."
  echo "  Check the recorder output above for errors."
  ls -la "$FIXTURE_DIR" 2>&1 || true
  exit 1
fi

# Copy the source file alongside the trace so the DAP server can resolve
# source references.
if [ ! -f "$FIXTURE_DIR/solana_flow_test.rs" ]; then
  cp "$SOURCE_FILE" "$FIXTURE_DIR/solana_flow_test.rs"
fi

echo ""
echo "=== Solana trace fixture ready ==="
echo "  Location: $FIXTURE_DIR"
echo "  Files:"
ls -la "$FIXTURE_DIR"
echo ""
echo "You can now run the WDIO smoke test:"
echo "  npm run test:wdio:solana"
