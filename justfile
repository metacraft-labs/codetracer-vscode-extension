build:
    #!/usr/bin/env bash
    set -euo pipefail
    mkdir -p ./media
    mkdir -p ./backend
    npm install

    rm -f ./backend/db-backend
    (
        cd libs/codetracer
        nix develop \
            --extra-experimental-features nix-command \
            --extra-experimental-features flakes \
            .#devShells.x86_64-linux.default --command ./build_for_extension.sh ../../media/ui.js ../../media/ct_vscode.js ../../backend/db-backend
    )
    # Re-build the webpack frontend bundle with `--devtool false`.
    #
    # `build_for_extension.sh` builds the frontend entry via codetracer's
    # `webpack.config.js`, which runs in `mode: development`. Webpack's
    # development mode defaults `devtool` to `eval`, which wraps every one
    # of ~3500 modules in a separate `eval()` call. Five CodeTracer webview
    # panels each load this bundle, and `eval`-mode parsing is so expensive
    # that loading it in several webviews at once exhausted the single
    # shared VS Code renderer process and crashed it ("renderer closed the
    # MessagePort"). A `devtool: false` build emits an ordinary
    # function-wrapped bundle that V8 can lazily parse, removing the crash.
    (
        cd libs/codetracer
        node node_modules/webpack-cli/bin/cli.js --config webpack.config.js --devtool false
    )
    # Copy the complete webpack output — the frontend entry AND every
    # code-split chunk (`*.frontend_imports.js`) plus the emitted asset
    # files (Monaco web-workers, the oniguruma .wasm, fonts, …). The
    # bundle's runtime resolves async `import()` chunks relative to its own
    # script URL, so the chunks must sit next to the frontend entry in
    # `media/` or Monaco / Nim-language loading 404s ("Error using
    # fileReader"). The previous symlink-only step copied just the entry
    # bundle and left every chunk missing.
    rm -f ./media/frontend_bundle.js
    if [[ -f libs/codetracer/src/public/dist/frontend_imports.js ]]; then
        cp -f libs/codetracer/src/public/dist/frontend_imports.js ./media/frontend_bundle.js
    elif [[ -f libs/codetracer/src/public/dist/frontend_bundle.js ]]; then
        cp -f libs/codetracer/src/public/dist/frontend_bundle.js ./media/frontend_bundle.js
    else
        echo "codetracer webpack frontend entry is missing from libs/codetracer/src/public/dist" >&2
        exit 1
    fi
    node -e '
      const fs = require("fs");
      const bundle = "./media/frontend_bundle.js";
      const text = fs.readFileSync(bundle, "utf8");
      const publicPath = [
        "var scriptUrl;",
        "/******/     if (document.currentScript) scriptUrl = document.currentScript.src;",
        "/******/     __webpack_require__.p = scriptUrl.replace(/#.*$/, \"\").replace(/\\\\?.*$/, \"\").replace(/\\\\/[^\\\\/]+$/, \"/\");"
      ].join(String.fromCharCode(10));
      fs.writeFileSync(
        bundle,
        text
          .replace(/__webpack_require__\.p = "[^"]*\/src\/public\/dist";/g, publicPath)
          .replace(/__webpack_require__\.p = "";?/g, publicPath)
      );
    '
    for asset in libs/codetracer/src/public/dist/*; do
        case "$asset" in
            */frontend_imports.js) ;;
            */frontend_bundle.js) ;;
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
