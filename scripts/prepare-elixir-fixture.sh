#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
extension_dir="$(cd "$script_dir/.." && pwd)"
fixture_dir="${1:-${ELIXIR_FIXTURE_OUTPUT_DIR:-$extension_dir/test/fixtures/elixir-canonical-flow}}"

if [[ -n "${CODETRACER_ELIXIR_RECORDER_PATH:-}" ]]; then
  recorder_dir="$CODETRACER_ELIXIR_RECORDER_PATH"
else
  candidates=(
    "$extension_dir/../codetracer-elixir-recorder"
    "$extension_dir/../../../metacraft/codetracer-elixir-recorder"
  )
  recorder_dir=""
  for candidate in "${candidates[@]}"; do
    if [[ -x "$candidate/scripts/prepare-elixir-fixture.sh" ]]; then
      recorder_dir="$candidate"
      break
    fi
  done
fi

[[ -n "${recorder_dir:-}" ]] ||
  fail "codetracer-elixir-recorder checkout not found; set CODETRACER_ELIXIR_RECORDER_PATH"
[[ -x "$recorder_dir/scripts/prepare-elixir-fixture.sh" ]] ||
  fail "recorder fixture script not found: $recorder_dir/scripts/prepare-elixir-fixture.sh"

exec "$recorder_dir/scripts/prepare-elixir-fixture.sh" "$fixture_dir"
