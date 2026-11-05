#!/usr/bin/env bash
# Exercise the real preparer and Rust repacker: mocking either boundary would
# hide the tracked-sibling write this regression protects against.
set -euo pipefail

EXTENSION_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CODETRACER_DIR="$(cd "${CODETRACER_DIR:-$EXTENSION_DIR/../codetracer}" && pwd)"
export CODETRACER_DIR
snapshot_dir="$(mktemp -d)"
trap 'rm -rf "$snapshot_dir"' EXIT
export CODETRACER_HOME="$snapshot_dir/codetracer-home"

snapshot() {
  (
    cd "$CODETRACER_DIR"
    while IFS= read -r -d '' path; do
      object_id="$(git hash-object -- "$path")"
      printf '%s %s\n' "$object_id" "$path"
    done < <(git ls-files -z -- src/db-backend/tests/fixtures/stylus-fund-trace)
  )
}

snapshot > "$snapshot_dir/before"
test -s "$snapshot_dir/before"
bash "$EXTENSION_DIR/scripts/prepare-stylus-fixture.sh"
snapshot > "$snapshot_dir/after"
if ! diff -u "$snapshot_dir/before" "$snapshot_dir/after"; then
  echo "ERROR: Stylus fixture preparation changed tracked CodeTracer inputs" >&2
  exit 1
fi

fixture="$EXTENSION_DIR/test/fixtures/stylus-fund-trace/stylus_fund_tracking_demo.ct"
test -s "$fixture"
git -C "$EXTENSION_DIR" check-ignore --quiet "$fixture"
echo "Stylus fixture preparation preserved tracked inputs and produced an ignored CTFS fixture"
