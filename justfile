build:
    #!/usr/bin/env bash
    mkdir -p ./media
    mkdir -p ./backend
    npm install

    pushd libs/codetracer && \
        nix develop \
            --extra-experimental-features nix-command \
            --extra-experimental-features flakes \
            .#devShells.x86_64-linux.default --command ./build_for_extension.sh ../../media/ui.js ../../media/ct_vscode.js ../../backend/db-backend && \
        popd;
    # Re-build the webpack frontend bundle with `--devtool false`.
    #
    # `build_for_extension.sh` builds `frontend_bundle.js` via codetracer's
    # `webpack.config.js`, which runs in `mode: development`. Webpack's
    # development mode defaults `devtool` to `eval`, which wraps every one
    # of ~3500 modules in a separate `eval()` call. Five CodeTracer webview
    # panels each load this bundle, and `eval`-mode parsing is so expensive
    # that loading it in several webviews at once exhausted the single
    # shared VS Code renderer process and crashed it ("renderer closed the
    # MessagePort"). A `devtool: false` build emits an ordinary
    # function-wrapped bundle that V8 can lazily parse, removing the crash.
    pushd libs/codetracer && \
        node node_modules/webpack-cli/bin/cli.js --config webpack.config.js --devtool false && \
        popd;
    # Copy the complete webpack output — `frontend_bundle.js` AND every
    # code-split chunk (`*.frontend_bundle.js`) plus the emitted asset
    # files (Monaco web-workers, the oniguruma .wasm, fonts, …). The
    # bundle's runtime resolves async `import()` chunks relative to its own
    # script URL, so the chunks must sit next to `frontend_bundle.js` in
    # `media/` or Monaco / Nim-language loading 404s ("Error using
    # fileReader"). The previous symlink-only step copied just the entry
    # bundle and left every chunk missing.
    rm -f ./media/frontend_bundle.js
    cp -f libs/codetracer/src/public/dist/*.frontend_bundle.js ./media/
    for asset in libs/codetracer/src/public/dist/*; do
        case "$asset" in
            *.frontend_bundle.js) ;;
            *.LICENSE.txt) ;;
            *) cp -f "$asset" ./media/ ;;
        esac
    done
    if [[ ! -e ./media/third_party && ! -d ./media/third_party ]]; then
        rm -rf ./media/third_party
        ln -s $(pwd)/libs/codetracer/src/public/third_party media/third_party
    fi;
    if [[ ! -e ./media/styles/default_dark_theme_extension.css && ! -f ./media/styles/default_dark_theme_extension.css ]]; then
        rm -f ./media/styles/default_dark_theme_extension.css
        mkdir -p ./media/styles
        ln -s $(pwd)/libs/codetracer/src/build-debug/frontend/styles/default_dark_theme_extension.css ./media/styles/default_dark_theme_extension.css
    fi;
    if [[ ! -e ./media/fonts/SpaceGrotesk-VariableFont_wght.ttf && ! -f ./media/fonts/SpaceGrotesk-VariableFont_wght.ttf ]]; then
        rm -f ./media/fonts/SpaceGrotesk-VariableFont_wght.ttf
        mkdir -p ./media/fonts
        ln -s $(pwd)/libs/codetracer/src/public/resources/fonts/space_grotesk/SpaceGrotesk-VariableFont_wght.ttf ./media/fonts/SpaceGrotesk-VariableFont_wght.ttf
    fi;

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
    {{CMD}}

# Run WDIO hello-world smoke test (no sibling repos needed)
test-wdio-smoke:
    just _xvfb-run "npx wdio run wdio.conf.ts --spec test/wdio/specs/hello-vscode.e2e.ts"

# Record test traces from sibling repos (idempotent, skips existing)
record-test-traces *LANGS:
    #!/usr/bin/env bash
    set -euo pipefail
    bash scripts/record-test-traces.sh {{LANGS}}

# Run per-language smoke tests (requires sibling repos + recorded traces)
test-wdio-smoke-langs: record-test-traces
    just _xvfb-run "npx wdio run wdio.conf.ts --spec 'test/wdio/specs/smoke/*.e2e.ts'"

# Run WDIO Elixir trace smoke test (generates fixture through the recorder script)
test-wdio-elixir:
    #!/usr/bin/env bash
    set -euo pipefail
    scripts/prepare-wdio-codetracer-bin.sh
    export PATH="$(pwd)/.ct-bin:$PATH"
    just _xvfb-run "npx wdio run wdio.conf.ts --spec test/wdio/specs/smoke/elixir.e2e.ts"

# Run WDIO Stylus trace tests (requires fixture + Xvfb)
test-wdio-stylus:
    just _xvfb-run "npx wdio run wdio.conf.ts --spec test/wdio/specs/deep/stylus-trace-load.e2e.ts"

# Run WDIO deep tests (requires traces + Xvfb)
test-wdio-deep:
    just _xvfb-run "npx wdio run wdio.conf.ts --spec 'test/wdio/specs/deep/*.e2e.ts'"

# Run all WDIO tests
test-wdio:
    just _xvfb-run "npx wdio run wdio.conf.ts"
