Activate the flake-backed environment with `repro allow` and the repro shell hook. Run development commands inside this environment (or use `repro exec -- <command>`).

# Build Process

The extension is built from the **codetracer checkout beside it** —
`CODETRACER_DIR`, default `../codetracer` (the workspace layout); there is no
codetracer submodule. The canonical build command is:

```bash
just build                                  # or: CODETRACER_DIR=/path/to/codetracer just build
```

This runs the following stages (see `justfile`):

1. **`npm install`** — install Node.js dependencies
2. **codetracer's `build_for_extension.sh`** (inside codetracer's `nix develop`
   devShell) — builds into `media/` and `backend/`:
   - `media/vscode_panel.js` — every panel webview's one script: that panel's
     view over a mirror of the session the extension host owns
     (`src/frontend/entries/vscode_panel.nim`)
   - `media/vscode_host.js` — the extension host's sessions, one per
     CodeTracer debug session (`src/frontend/entries/vscode_host.nim`),
     loaded by `src/sessionHost.ts`
   - `media/ct_vscode.js` — the extension host's middleware
   - `backend/replay-server` — the replay backend (`cargo build`)
3. **Theme** — compiles codetracer's `default_dark_theme_extension.styl` into
   `media/styles/`, copies the icons and fonts it refers to into
   `media/resources/` and `media/design-system/`, and rewrites its URLs to
   them (a webview may load only from `media/`)
4. **`npm run compile:ts`** (`tsc -p ./`) — compile TypeScript to `out/`
5. **`cp media/ct_vscode.js out/ct_vscode.js`** — restore Nim-compiled middleware

The panels hold no debugger state: `src/sessionHost.ts` routes VS Code's debug
sessions, their adapter's events (a debug adapter tracker) and each panel's
messages to `vscode_host.js`, which serves every panel a mirror of the active
session. Panels are restored with the window (`registerWebviewPanelSerializer`),
and `codetracer.panels.fileTree` chooses CodeTracer's Files panel or VS Code's
Explorer as the file tree.

### CRITICAL: The ct_vscode.js overwrite bug

`npm run compile:ts` (tsc) overwrites `out/ct_vscode.js` with an empty TypeScript stub
because `src/ct_vscode.ts` exists as a type shim. The Nim-compiled version in `media/`
must be copied back after every tsc run. Both `just build` and `wdio.conf.ts:onPrepare`
handle this automatically, but if you run `tsc` manually, you must copy it yourself:

```bash
cp media/ct_vscode.js out/ct_vscode.js
```

### TypeScript-only build (no Nim/Rust changes)

```bash
just build-npm
# or equivalently:
npm run compile:ts && cp media/ct_vscode.js out/ct_vscode.js
```

**NOTE**: `npm run compile` is intentionally blocked — it exits with an error
directing you to use `just build` (full build) or `npm run compile:ts` (TypeScript
type-checking only). This prevents agents and developers from accidentally running
an incomplete build that produces a broken extension.

### Required media assets

After a full build, these files must exist and be non-empty:
- `media/vscode_panel.js` — the panel webviews' script
- `media/vscode_host.js` — the extension host's sessions
- `media/ct_vscode.js` — Nim-compiled middleware
- `media/styles/default_dark_theme_extension.css` — theme
- `backend/replay-server` — DAP server binary

The WDIO smoke suite (`just test-wdio-smoke`) opens the State panel and
asserts its webview loads `vscode_panel.js` alone and mounts; it skips that
case without a built bundle unless `CT_EXPECT_PANEL_BUNDLE=1`, which CI's
integration job sets.

### Nim compilation integration note

The Nim compilation requires codetracer's Nix devShell, which `just build`
enters with `nix develop` in `CODETRACER_DIR`. There is no way to run Nim
compilation from a bare `npm run compile`. The `vscode:prepublish` script calls
`just build` to ensure a full build before packaging.

# Testing

## Test tiers

The CodeTracer test infrastructure spans multiple repositories, organized in tiers:

### Tier 1: Recording pipeline (codetracer repo)

Tests that the Stylus recording pipeline works end-to-end: build WASM, deploy to
devnode, send transaction, get EVM trace, record with wazero.

**Requires**: Running Arbitrum devnode at localhost:8547, cargo-stylus, cast, wazero.

```bash
# Quick smoke test — just verifies trace files are produced
cd ../codetracer && just test-stylus-flow

# Full analysis — verifies trace contents (EVM events, calldata, storage ops)
cd ../codetracer && just test-stylus-flow-full
```

Test files:
- `../codetracer/src/db-backend/tests/stylus_flow_integration.rs`
  - `test_stylus_flow_integration` — Tier 1 only
  - `test_stylus_trace_analysis` — Tier 1 + content verification

### Tier 2: Headless DAP analysis (codetracer repo)

Tests that the DAP server (db-backend) correctly handles Stylus traces. Uses
pre-recorded fixtures — does NOT need a devnode.

```bash
cd ../codetracer/src/db-backend && cargo nextest run test_stylus_dap_event_only_trace
# or with cargo test:
cd ../codetracer/src/db-backend && cargo test test_stylus_dap_event_only_trace
```

Test files:
- `../codetracer/src/db-backend/tests/stylus_flow_integration.rs`
  - `test_stylus_dap_event_only_trace` — loads fixture, verifies DAP init/launch
- Fixture: `../codetracer/src/db-backend/tests/fixtures/stylus-fund-trace/`

**Current Stylus trace limitations**: Stylus traces contain ONLY Event entries (EVM
host function calls like `read_args`, `storage_load_bytes32`, `write_result`). They
do NOT contain Step/Call/Function entries because the wasm-recorder's Stylus code path
(`internal/stylus/stylus.go`) bypasses the DWARF-based stepping interpreter. This
means source-level debugging (breakpoints, variable inspection, flow) is not available
for Stylus traces. The DAP server has been hardened to handle this event-only format
without panicking.

### Tier 3: VS Code UI tests (this repo)

WebdriverIO (WDIO) tests that launch VS Code Insiders with the extension loaded and
verify UI behavior.

**Requires**: VS Code Insiders, chromedriver, extension built (`just build` or at minimum `just build-npm` with media assets present).

```bash
# All WDIO tests
npm run test:wdio

# Individual test suites
npm run test:wdio:hello    # Smoke test — extension loads, commands registered
npm run test:wdio:stylus   # Stylus trace loading (needs fixture)
```

Test files:
- `test/wdio/specs/hello-vscode.e2e.ts` — smoke test: VS Code launches, extension
  activates, ct-vscode commands are registered
- `test/wdio/specs/stylus-trace-load.e2e.ts` — loads a Stylus trace fixture via DAP,
  verifies debug session starts, source file opens, context activates
- `test/wdio/specs/debug-trace-load.e2e.ts` — comprehensive diagnostic test that
  captures extension state, DAP responses, webview content, and media file presence
- `wdio.conf.ts` — WDIO configuration with VS Code Insiders resolution, chromedriver
  setup, and test workspace configuration

### Extension host tests (`just test-vscode`)

`just test-vscode` runs the mocha suites in `src/test/` inside VS Code through
`npx vscode-test` (`.vscode-test.mjs`). In the dev shell it launches the
Electron executable named by `VSCODE_INSIDERS_EXECUTABLE` (flake.nix), not the
`bin/code-insiders` CLI launcher in `VSCODE_INSIDERS_PATH` that WDIO uses: the
launcher detaches VS Code and exits 0, so no test ever reported.
`.vscode-test.mjs` refuses a missing, non-executable or script path by name,
and the recipe fails when the output lacks mocha's `<N> passing` summary.
`just test-vscode-control` runs an always-throwing test
(`src/test-control/throws.control.ts`) and requires the run to fail naming it.

### Generating the Stylus trace fixture for Tier 3

The Stylus trace fixture used by `stylus-trace-load.e2e.ts` must be generated from a
live devnode recording:

```bash
# From the codetracer repo, with devnode running:
STYLUS_FIXTURE_OUTPUT_DIR=../codetracer-vscode-extension/test/fixtures/stylus-fund-trace \
  just test-stylus-flow-full
```

This runs `test_stylus_trace_analysis` which records a trace and exports it to the
specified directory.

## Testing your TypeScript changes

```bash
npm run compile:ts
```

This runs `tsc` and reports type errors. Remember to restore `ct_vscode.js` afterward
if you plan to run the extension (`cp media/ct_vscode.js out/ct_vscode.js`).

## Running the linter

```bash
npm run lint
```

# Keeping notes

In the `.agents/codebase-insights.txt` file, we try to maintain useful tips that may help
you in your development tasks. When you discover something important or surprising about
the codebase, add a remark in a comment near the relevant code or in the codebase-insights
file. ALWAYS remove older remarks if they are no longer true.

You can consult this file before starting your coding tasks.

# Code quality guidelines

- ALWAYS strive to achieve high code quality.
- ALWAYS write secure code.
- ALWAYS make sure the code is well tested and edge cases are covered. Design the code for testability and be extremely thorough.
- ALWAYS write defensive code and make sure all potential errors are handled.
- ALWAYS strive to write highly reusable code with routines that have high fan in and low fan out.
- ALWAYS keep the code DRY.
- Aim for low coupling and high cohesion. Encapsulate and hide implementation details.
- When creating executable, ALWAYS make sure the functionality can also be used as a library.
  To achieve this, avoid global variables, raise/return errors instead of terminating the program, and think whether the use case of the library requires more control over logging
  and metrics from the application that integrates the library.

# Code commenting guidelines

- Document public APIs and complex modules using standard code documentation conventions.
- Comment the intention behind your code extensively. Omit comments only for very obvious
  facts that almost any developer would know.
- Maintain the comments together with the code to keep them meaningful and current.
- When the code is based on specific formats, standards or well-specified behavior of
  other software, always make sure to include relevant links (URLs) that provide the
  necessary technical details.

# Writing git commit messages

- You MUST use multiline git commit messages.
- Use the conventional commits style for the first line of the commit message.
- Use the summary section of your final response as the remaining lines in the commit message.
