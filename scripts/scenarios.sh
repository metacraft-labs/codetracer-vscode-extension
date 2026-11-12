#!/usr/bin/env bash
# scripts/scenarios.sh — CodeTracer's scenarios on VS Code: build the runner
# and stage the arm, lint the scenarios, run the lane or one scenario.
#
#   scripts/scenarios.sh build              the runner (dvs) and the staged arm
#   scripts/scenarios.sh lint               every scenario against the pack
#   scripts/scenarios.sh lane               the vscode lane (needs a display)
#   scripts/scenarios.sh run <scenario.yaml> [dvs run args…]
#
# The scenarios are under test/scenarios/ and run with the extension's
# WebDriverIO binding (test/scenarios/codetracer-binding.ts). What they run
# with comes from the sibling checkouts:
#
#   ../codetracer                   the pack (src/tests/scenarios/pack), `ct`,
#                                   the replay server and `ct-scenario-stage`
#                                   (CODETRACER_DIR)
#   ../DemoVideoScript              the format, the linter and the one runner
#                                   (DVS_ROOT)
#   ../DemoVideoScript-WebDriverIO  the arm (DVS_WEBDRIVERIO_ROOT)
#
# The arm is staged under build/scenario-arm beside a link to this
# repository's WebDriverIO (node_modules, from `npm ci`), so the arm and the
# binding's launch (wdio-vscode-service) drive one WebDriverIO. The runner is
# built with `nim` (DemoVideoScript's or codetracer's dev shell has it; this
# repository's does not), or DVS_BIN names a built one. CT_SCENARIO_PACK names
# another pack file (a pack change not landed in codetracer yet).
#
# A scenario's stage records its program with the recorder `ct record` uses
# (codetracer's dev shell provides them, or .ct-bin on PATH), and VS Code is
# the dev shell's (VSCODE_INSIDERS_EXECUTABLE, with CHROMEDRIVER_PATH).
#
# Recordings of runs go under build/scenario-runs/<scenario>/<backend>/<run-id>/
# (kept on failure; `--record always` keeps passing ones too): read the run's
# manifest.json first, then failure/observation.json and failure/surface.*.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${root}"
ws="$(cd "${root}/.." && pwd)"
S=test/scenarios
build_dir="${CT_SCENARIO_BUILD:-${root}/build}"
bin="${build_dir}/bin"
ct_dir="$(cd "${CODETRACER_DIR:-${ws}/codetracer}" && pwd)"
dvs_root="${DVS_ROOT:-${ws}/DemoVideoScript}"
arm_root="${DVS_WEBDRIVERIO_ROOT:-${ws}/DemoVideoScript-WebDriverIO}"
pack="${CT_SCENARIO_PACK:-${ct_dir}/src/tests/scenarios/pack/codetracer.pack.yaml}"
backend="cmd:node ${build_dir}/scenario-arm/src/main.ts --binding ${root}/${S}/codetracer-binding.ts"

require() {
	local what="$1" path="$2"
	if [ ! -e "${path}" ]; then
		echo "scenarios: ${what} is missing at ${path}" >&2
		exit 2
	fi
}

build() {
	require "DemoVideoScript" "${dvs_root}/src/dvs.nim"
	require "DemoVideoScript-WebDriverIO" "${arm_root}/src/main.ts"
	require "webdriverio (node_modules: npm ci)" "${root}/node_modules/webdriverio"
	require "wdio-vscode-service (node_modules: npm ci)" "${root}/node_modules/wdio-vscode-service"
	mkdir -p "${bin}"
	if [ -n "${DVS_BIN:-}" ]; then
		require "the runner named by DVS_BIN" "${DVS_BIN}"
		ln -sfn "${DVS_BIN}" "${bin}/dvs"
	elif command -v nim >/dev/null 2>&1; then
		rm -f "${bin}/dvs"
		nim c --hints:off -d:release --path:"${dvs_root}/src" \
			--nimcache:"${build_dir}/nimcache/scenario-dvs" -o:"${bin}/dvs" "${dvs_root}/src/dvs.nim"
	else
		echo "scenarios: building the runner needs nim (DemoVideoScript's dev shell), or DVS_BIN" >&2
		exit 2
	fi
	mkdir -p "${build_dir}/scenario-arm/node_modules"
	ln -sfn "${root}/node_modules/webdriverio" "${build_dir}/scenario-arm/node_modules/webdriverio"
	rm -rf "${build_dir}/scenario-arm/src"
	cp -r "${arm_root}/src" "${build_dir}/scenario-arm/src"
	printf '{ "type": "module", "private": true }\n' >"${build_dir}/scenario-arm/package.json"
}

ensure_built() {
	[ -x "${bin}/dvs" ] && [ -f "${build_dir}/scenario-arm/src/main.ts" ] || build
}

# The extension's panels and the replay server it runs: `just build` (or the
# media built from ../codetracer), and `ct` with its replay server.
check_runtime() {
	require "the panels' bundle (just build)" "${root}/media/vscode_panel.js"
	require "the extension's host bundle (just build)" "${root}/media/vscode_host.js"
	require "the extension (npm run compile:ts)" "${root}/out/extension.js"
	require "ct-scenario-stage (codetracer: just scenario-build)" \
		"${CT_SCENARIO_STAGE:-${ct_dir}/build/bin/ct-scenario-stage}"
}

case "${1:-}" in
build)
	build
	;;
lint)
	ensure_built
	mapfile -t files < <(find "${S}" -name '*.yaml' -not -path '*/lanes/*' | sort)
	set +e
	"${bin}/dvs" lint "${files[@]}" --pack "${pack}"
	rc=$?
	set -e
	echo "scenarios: linted ${#files[@]} scenario(s), exit ${rc}"
	# Warnings (ordinals, timing) are allowed; an error fails.
	[ "${rc}" -le 1 ]
	;;
lane)
	ensure_built
	check_runtime
	lane="${S}/lanes/vscode.lane.yaml"
	if [ -n "${CT_SCENARIO_PACK:-}" ] || [ -n "${CODETRACER_DIR:-}" ]; then
		# The lane names the sibling's pack by a relative path: write a copy
		# whose pack and scenarios are absolute.
		mkdir -p "${build_dir}/scenario-lanes"
		python3 - "${lane}" "${pack}" "${build_dir}/scenario-lanes/vscode.lane.yaml" <<'PY'
import os, re, sys
src, pack, out = sys.argv[1:]
base = os.path.dirname(os.path.abspath(src))
lines = []
for line in open(src):
    if line.startswith("pack:"):
        line = f"pack: {pack}\n"
    else:
        m = re.match(r"^(\s*-\s+)(\S+\.yaml)\s*$", line)
        if m:
            line = f"{m.group(1)}{os.path.normpath(os.path.join(base, m.group(2)))}\n"
    lines.append(line)
open(out, "w").writelines(lines)
PY
		lane="${build_dir}/scenario-lanes/vscode.lane.yaml"
	fi
	"${bin}/dvs" lane "${lane}" --build "${build_dir}"
	;;
run)
	scenario="${2:?usage: scenarios.sh run <scenario.yaml> [dvs run args]}"
	shift 2
	ensure_built
	check_runtime
	"${bin}/dvs" run "${scenario}" --pack "${pack}" --backend "${backend}" --build "${build_dir}" "$@"
	;;
*)
	sed -n '2,27p' "$0"
	exit 64
	;;
esac
