#!/usr/bin/env bash
# =============================================================================
# Thin wrapper: dispatch to the recorder-owned BEAM fixture preparation script.
#
# The real script lives in codetracer-beam-recorder/scripts/prepare-beam-
# fixtures.sh (the recorder repo owns the test programs, the recorder binary,
# the BEAM toolchain wiring, and the no-silent-skip guard). This wrapper:
#
#   - Discovers the codetracer-beam-recorder sibling via detect-siblings.sh.
#   - Forwards arguments and environment unchanged.
#   - Fails loudly if the sibling is not present, so CI sees the diagnostic
#     rather than a silently-skipped recording.
#
# Usage matches the underlying script:
#   scripts/prepare-beam-fixture.sh [ELIXIR_OUT_DIR] [ERLANG_OUT_DIR]
#
# Defaults (when args are omitted) place the bundles under
# <repo>/test/traces/elixir-canonical-flow and erlang-canonical-flow so that
# WDIO smoke + deep specs pick them up via test/wdio/helpers/trace-utils.ts.
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

# shellcheck source=detect-siblings.sh
source "$SCRIPT_DIR/detect-siblings.sh" "$REPO_ROOT"

if [ -z "${CODETRACER_BEAM_RECORDER_ROOT:-}" ]; then
  printf 'FAIL: codetracer-beam-recorder sibling not found; cannot prepare BEAM fixtures.\n' >&2
  printf 'Hint: clone codetracer-beam-recorder next to this repo or set CODETRACER_BEAM_RECORDER_PATH.\n' >&2
  exit 1
fi

beam_script="$CODETRACER_BEAM_RECORDER_ROOT/scripts/prepare-beam-fixtures.sh"
if [ ! -x "$beam_script" ]; then
  printf 'FAIL: prepare-beam-fixtures.sh missing or not executable: %s\n' "$beam_script" >&2
  exit 1
fi

elixir_out="${1:-$REPO_ROOT/test/traces/elixir-canonical-flow}"
erlang_out="${2:-$REPO_ROOT/test/traces/erlang-canonical-flow}"

mkdir -p "$(dirname "$elixir_out")"
mkdir -p "$(dirname "$erlang_out")"

exec "$beam_script" "$elixir_out" "$erlang_out"
