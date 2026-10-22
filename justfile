# Build the extension from the codetracer checkout beside it (CODETRACER_DIR,
# default `../codetracer`, the workspace layout). codetracer builds the Nim
# and Rust artefacts into `media/` and `backend/` (its `build_for_extension.sh`):
#
#   media/vscode_panel.js   every panel webview's script: one panel's view over
#                           a mirror of the session the extension host owns
#   media/vscode_host.js    the extension host's sessions (`src/sessionHost.ts`)
#   media/ct_vscode.js      the extension host's middleware
#   backend/replay-server   the replay backend
#
# and this recipe adds the theme CSS (compiled from codetracer's stylus
# sources), the icons and fonts it refers to, and the TypeScript.
build:
    #!/usr/bin/env bash
    set -euo pipefail
    ct_dir="${CODETRACER_DIR:-../codetracer}"
    if [[ ! -f "${ct_dir}/build_for_extension.sh" ]]; then
        echo "codetracer checkout not found at '${ct_dir}' (set CODETRACER_DIR)" >&2
        exit 1
    fi
    ct_dir="$(cd "${ct_dir}" && pwd)"
    ext_dir="$(pwd)"
    mkdir -p ./media ./backend
    npm install

    rm -f ./backend/replay-server ./backend/db-backend ./media/vscode_panel.js ./media/vscode_host.js ./media/ct_vscode.js
    (
        cd "${ct_dir}"
        nix develop \
            --extra-experimental-features nix-command \
            --extra-experimental-features flakes \
            .#devShells.x86_64-linux.default --command \
            ./build_for_extension.sh "${ext_dir}/media" "${ext_dir}/backend/replay-server"
    )

    # The theme. A webview may load only from `media/` (`localResourceRoots`),
    # so the icons and fonts the stylesheet refers to are copied there and its
    # URLs rewritten to point at the copies:
    #   ../../public/resources/, ../../../public/resources/  -> ../resources/
    #   ../../../../libs/codetracer-design-system/           -> ../design-system/
    mkdir -p ./media/styles
    (
        cd "${ct_dir}"
        node node_modules/stylus/bin/stylus \
            -o "${ext_dir}/media/styles/default_dark_theme_extension.css" \
            src/frontend/styles/default_dark_theme_extension.styl
    )
    sed -i \
        -e 's#\.\./\.\./\.\./public/resources/#../resources/#g' \
        -e 's#\.\./\.\./public/resources/#../resources/#g' \
        -e 's#\.\./\.\./\.\./\.\./libs/codetracer-design-system/#../design-system/#g' \
        ./media/styles/default_dark_theme_extension.css
    rm -rf ./media/resources ./media/design-system
    cp -r "${ct_dir}/src/public/resources" ./media/resources
    if [[ -d "${ct_dir}/libs/codetracer-design-system/SpaceGrotesk_Complete" ]]; then
        cp -r "${ct_dir}/libs/codetracer-design-system" ./media/design-system
    else
        echo "warning: ${ct_dir}/libs/codetracer-design-system is not checked out; the panels fall back to system fonts" >&2
    fi

    npm run compile:ts
    cp ./media/ct_vscode.js out/ct_vscode.js

# TypeScript-only build (no Nim/Rust dependencies)
build-npm:
    npm run compile:ts
    cp ./media/ct_vscode.js out/ct_vscode.js

# --- CI targets ---

# Install npm dependencies
install:
    npm ci

# Run ESLint
lint:
    npm run lint

# Compile TypeScript and verify output
compile-ts:
    npm run compile:ts
    test -f out/extension.js

# Compile/typecheck WDIO config, helpers, and specs.
compile-wdio:
    npm run compile:wdio

# Run the VS Code extension host tests from src/test under Xvfb.
test-vscode:
    just _xvfb-run "npx vscode-test"

# Helper: start Xvfb and run a command with DISPLAY set.
# Usage: just _xvfb-run "npx wdio run wdio.conf.ts --spec ..."
[private]
_xvfb-run +CMD:
    #!/usr/bin/env bash
    set -euo pipefail
    # The previous "scan /tmp/.X<n>-lock then Xvfb :<n>" loop raced
    # when multiple cross-repo runners launched Xvfb on the same host:
    # two jobs would see the same lock file missing, pick the same
    # display number, and the second Xvfb would fail with::
    #
    #   Fatal server error:
    #   (EE) Cannot establish any listening sockets - Make sure an X
    #        server isn't already running
    #
    # Then chrome/electron would start with ``$DISPLAY=:N`` pointing
    # at the dead server and emit::
    #
    #   ERROR:ui/ozone/platform/x11/ozone_platform_x11.cc:250]
    #   Missing X server or $DISPLAY
    #
    # which chromedriver in turn misreports as "user data directory is
    # already in use".
    #
    # Pick a random high display number (10000-65535) per invocation
    # so the collision odds drop from "two parallel jobs always race"
    # to "1 in 55 thousand", and additionally retry a few times in
    # case we DO hit a collision -- O_EXCL on the lock file via Xvfb's
    # own startup is the race-free piece.
    pick_display() {
        for _attempt in $(seq 1 8); do
            local n=$((RANDOM % 55535 + 10000))
            if [ ! -e "/tmp/.X${n}-lock" ]; then
                echo "$n"; return 0
            fi
        done
        return 1
    }
    XVFB_LOG="$(mktemp)"
    for _attempt in $(seq 1 5); do
        DISPLAY_NUM="$(pick_display)" || {
            echo "_xvfb-run: could not pick a free display number" >&2; exit 1
        }
        Xvfb ":${DISPLAY_NUM}" -screen 0 1920x1080x24 -nolisten tcp >"$XVFB_LOG" 2>&1 &
        XVFB_PID=$!
        # Xvfb prints "Fatal server error" within ~100ms when the
        # display is taken; give it a moment and verify it's actually
        # listening before we hand $DISPLAY to chrome.
        sleep 1
        if kill -0 "$XVFB_PID" 2>/dev/null && ! grep -q "Fatal server error" "$XVFB_LOG"; then
            break
        fi
        kill "$XVFB_PID" 2>/dev/null || true
        wait "$XVFB_PID" 2>/dev/null || true
        : >"$XVFB_LOG"
        if [ "$_attempt" = "5" ]; then
            echo "_xvfb-run: Xvfb failed to start after 5 attempts; last log:" >&2
            cat "$XVFB_LOG" >&2
            rm -f "$XVFB_LOG"
            exit 1
        fi
    done
    trap "kill $XVFB_PID 2>/dev/null || true; rm -f $XVFB_LOG" EXIT
    export DISPLAY=":${DISPLAY_NUM}"
    # Chromium sandbox workarounds for NixOS CI runners where the
    # chrome-sandbox binary lacks the SUID bit and unprivileged user
    # namespaces may be disabled.
    #
    # CHROME_DEVEL_SANDBOX="" tells Chromium to skip the setuid sandbox
    # helper entirely (it normally expects a SUID chrome-sandbox binary).
    #
    # --no-zygote tells Chromium to skip the zygote process and fork
    # renderer processes directly without namespace sandboxing. Without
    # this, the zygote attempts clone(CLONE_NEWPID) which fails on
    # runners without user namespace support, causing immediate crash.
    #
    # The wdio-vscode-service already passes --no-sandbox via its FAKE
    # binary, but that alone is insufficient when user namespaces are
    # unavailable.
    export CHROME_DEVEL_SANDBOX=""
    # Font preflight.
    #
    # Chromium hard-requires at least one resolvable font. With zero fonts the
    # renderer does not degrade -- it hits a Blink NOTREACHED in
    # remote_font_face_source.cc and aborts via __builtin_trap, so VS Code dies
    # with "renderer process gone (reason: crashed, code: 133)" (133 = 128+5,
    # SIGTRAP). The workbench never renders, and WDIO only reports it ~60s later
    # as "invalid session id" / "Connection timeout exceeded" -- a failure that
    # says nothing about fonts, buried under thousands of lines of chromedriver
    # INFO output. Check up front and name the actual cause.
    #
    # NOTE ON WHAT THIS ASSERTS. A naive "fc-list | wc -l -gt 0" does NOT work:
    # nixpkgs' fontconfig is built with dejavu-fonts-minimal compiled in as a
    # last-resort fallback, so `fc-list` reports 1 font even when FONTCONFIG_FILE
    # points at a file that does not exist. That threshold could never fire. The
    # invariant that actually broke in CI was "fontconfig has no config at all"
    # (Fontconfig error: Cannot load default config file), so assert that
    # directly, then assert that sans and monospace resolve to files that exist.
    font_preflight_failed=""
    if [ -z "${FONTCONFIG_FILE:-}" ]; then
        echo "_xvfb-run: FATAL: FONTCONFIG_FILE is unset." >&2
        font_preflight_failed=1
    elif [ ! -f "${FONTCONFIG_FILE}" ]; then
        echo "_xvfb-run: FATAL: FONTCONFIG_FILE=${FONTCONFIG_FILE} does not exist." >&2
        font_preflight_failed=1
    elif command -v fc-match >/dev/null 2>&1; then
        for _family in sans monospace; do
            _file="$(fc-match -f '%{file}' "$_family" 2>/dev/null || true)"
            if [ -z "$_file" ] || [ ! -f "$_file" ]; then
                echo "_xvfb-run: FATAL: font family '$_family' resolves to '${_file:-<nothing>}', which is not a file." >&2
                font_preflight_failed=1
            else
                echo "_xvfb-run: font '$_family' -> $_file"
            fi
        done
    else
        echo "_xvfb-run: FATAL: fc-match is unavailable; cannot verify usable fonts." >&2
        font_preflight_failed=1
    fi
    if [ -n "$font_preflight_failed" ]; then
        echo "  Chromium/Electron cannot render without a font. The renderer does not" >&2
        echo "  degrade gracefully: it hits a Blink NOTREACHED in" >&2
        echo "  remote_font_face_source.cc, aborts via __builtin_trap, and VS Code" >&2
        echo "  reports 'renderer process gone (reason: crashed, code: 133)'." >&2
        echo "  WDIO then surfaces that ~60s later as an opaque 'invalid session id'" >&2
        echo "  / 'Connection timeout exceeded' that never mentions fonts." >&2
        echo "  Failing fast with the real reason instead." >&2
        echo "  Fix: run under the repo's nix dev shell, which sets FONTCONFIG_FILE" >&2
        echo "  and ships dejavu_fonts + liberation_ttf (see flake.nix)." >&2
        exit 1
    fi
    if [ -d "$(pwd)/.ct-bin" ]; then
        export PATH="$(pwd)/.ct-bin:$PATH"
    fi
    {{CMD}}

# Run WDIO hello-world smoke test (no sibling repos needed)
test-wdio-smoke:
    just _xvfb-run "npx wdio run wdio.conf.ts --spec test/wdio/specs/hello-vscode.e2e.ts"

# Record test traces from sibling repos (idempotent, skips existing)
record-test-traces *LANGS:
    #!/usr/bin/env bash
    set -euo pipefail
    bash scripts/record-test-traces.sh {{LANGS}}

# Prepare all fixture inputs needed by the full WDIO suite. Missing fixture
# prerequisites are fatal here so `just test` cannot pass via skipped suites.
prepare-wdio-fixtures:
    scripts/prepare-wdio-fixtures.sh all

prepare-wdio-traces:
    scripts/prepare-wdio-fixtures.sh traces

prepare-wdio-blockchain-fixtures:
    scripts/prepare-wdio-fixtures.sh blockchain

prepare-wdio-beam-fixtures:
    scripts/prepare-beam-fixture.sh

prepare-wdio-solidity-fixture:
    scripts/prepare-solidity-fixture.sh

prepare-wdio-stylus-fixture:
    scripts/prepare-stylus-fixture.sh

prepare-wdio-value-origin-fixtures:
    scripts/prepare-wdio-fixtures.sh value-origin

# Run per-language smoke tests (requires sibling repos + recorded traces)
test-wdio-smoke-langs: prepare-wdio-traces
    just _xvfb-run "npx wdio run wdio.conf.ts --spec 'test/wdio/specs/smoke/*.e2e.ts'"

# Run WDIO Elixir trace smoke test (generates fixture through the recorder script)
test-wdio-elixir: prepare-wdio-beam-fixtures
    #!/usr/bin/env bash
    set -euo pipefail
    scripts/prepare-wdio-codetracer-bin.sh
    export PATH="$(pwd)/.ct-bin:$PATH"
    just _xvfb-run "npx wdio run wdio.conf.ts --spec test/wdio/specs/smoke/elixir.e2e.ts"

# Run WDIO Stylus trace tests (requires fixture + Xvfb)
test-wdio-stylus: prepare-wdio-stylus-fixture
    just _xvfb-run "npx wdio run wdio.conf.ts --spec test/wdio/specs/deep/stylus-trace-load.e2e.ts"

# Run individual smoke/deep specs used by package.json aliases.
test-wdio-solidity: prepare-wdio-solidity-fixture
    just _xvfb-run "npx wdio run wdio.conf.ts --spec test/wdio/specs/smoke/solidity.e2e.ts"

test-wdio-solidity-deep: prepare-wdio-solidity-fixture
    just _xvfb-run "npx wdio run wdio.conf.ts --spec test/wdio/specs/deep/solidity-storage.e2e.ts"

test-wdio-erlang: prepare-wdio-beam-fixtures
    just _xvfb-run "npx wdio run wdio.conf.ts --spec test/wdio/specs/smoke/erlang.e2e.ts"

test-wdio-beam-deep: prepare-wdio-beam-fixtures
    just _xvfb-run "npx wdio run wdio.conf.ts --spec test/wdio/specs/deep/beam-deep.e2e.ts"

# Run WDIO deep tests (requires traces + Xvfb)
test-wdio-deep: prepare-wdio-traces prepare-wdio-blockchain-fixtures
    just _xvfb-run "npx wdio run wdio.conf.ts --spec 'test/wdio/specs/deep/*.e2e.ts'"

# Run WDIO value-origin tests (requires codetracer value-origin fixtures + Xvfb)
test-wdio-value-origin: prepare-wdio-value-origin-fixtures
    #!/usr/bin/env bash
    set -euo pipefail
    for spec in test/wdio/specs/value-origin/*.e2e.ts; do
        just _xvfb-run "npx wdio run wdio.conf.ts --spec $spec"
    done

# Run all WDIO tests
test-wdio: prepare-wdio-fixtures
    just _xvfb-run "npx wdio run wdio.conf.ts"

# Run every repo-local test/check entrypoint; full WDIO needs siblings/fixtures.
test: lint compile-ts compile-wdio test-vscode test-wdio
