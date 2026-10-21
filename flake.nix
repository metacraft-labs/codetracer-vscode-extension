{
  description = "Dev environment for ct_vscode VS Code extension";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils, ... }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs {
          inherit system;
          config.allowUnfree = true;  # Needed for vscode
        };
        # VS Code Insiders derivation — pinned by commit on Linux for reproducibility.
        # On macOS the upstream override works as-is.
        vscodeInsiders = if pkgs.stdenv.isDarwin then
          pkgs.vscode.override { isInsiders = true; }
        else
          (pkgs.vscode.override { isInsiders = true; }).overrideAttrs (old: rec {
            version = "latest";
            src =
              if pkgs.stdenv.hostPlatform.system == "x86_64-linux" then
                pkgs.fetchurl {
                  # Same pin as vivafolio-vs-code — update both together.
                  url = "https://update.code.visualstudio.com/commit:f220831ea2d946c0dcb0f3eaa480eb435a2c1260/linux-x64/insider";
                  name = "vscode-insiders-linux-x64.tar.gz";
                  sha256 = "14i07ccd76dgi87ds2fp0x5i64n07hig779bsgn5d77qnbvy01hy";
                }
              else if pkgs.stdenv.hostPlatform.system == "aarch64-linux" then
                pkgs.fetchurl {
                  url = "https://update.code.visualstudio.com/commit:d226a2a497b928d78aa654f74c8af5317d3becfb/linux-arm64/insider";
                  name = "vscode-insiders-linux-arm64.deb";
                  sha256 = "1c8lv3z13wc1rrcj5v9bgng0vvw4dl040jxbz030w8p0l92a6bij";
                }
              else old.src;
            pname = "vscode-insiders";
            name = "${pname}-${version}";
          });
        # Chromedriver pinned to match the NIX-PACKAGED VS Code
        # Insiders' bundled Electron (NOT the latest apt-installed
        # code-insiders). The flake.lock pin → nixpkgs determines
        # which Insiders version we get; with the current pin (March
        # 2026 nixpkgs / NixOS 25.11) Insiders 1.104.0-insider ships
        # Electron 37.3.1 → Chromium 138.0.7204.x.
        #
        # When bumping flake.lock past a nixpkgs that bumps
        # vscode-insiders, also bump this pin:
        #   1. `code-insiders --version` in the dev shell
        #   2. inspect the bundled Electron via
        #      `cat resources/app/package.json | jq .devDependencies.electron`
        #      (path comes from `readlink -f $(command -v code-insiders)`)
        #   3. map Electron → Chromium via the releases page or
        #      https://www.electronjs.org/docs/latest/tutorial/electron-timelines
        #   4. find the matching chromedriver in
        #      https://googlechromelabs.github.io/chrome-for-testing/known-good-versions-with-downloads.json
        #   5. recompute the hash with `nix-prefetch-url <url>`
        chromedriver-pinned = pkgs.stdenv.mkDerivation rec {
          pname = "chromedriver";
          version = "138.0.7204.94";
          src =
            if pkgs.stdenv.hostPlatform.system == "x86_64-linux" then
              pkgs.fetchurl {
                url = "https://storage.googleapis.com/chrome-for-testing-public/${version}/linux64/chromedriver-linux64.zip";
                sha256 = "sha256-WdtqWZR/b2I81mxWzmUy35axTz6DUBRKOiRvm1H/wow=";
              }
            else if pkgs.stdenv.hostPlatform.system == "aarch64-linux" then
              pkgs.fetchurl {
                url = "https://storage.googleapis.com/chrome-for-testing-public/${version}/linux-arm64/chromedriver-linux-arm64.zip";
                sha256 = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="; # TODO: fill in for arm64
              }
            else if pkgs.stdenv.isDarwin then
              pkgs.fetchurl {
                url = "https://storage.googleapis.com/chrome-for-testing-public/${version}/mac-x64/chromedriver-mac-x64.zip";
                sha256 = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="; # TODO: fill in for macOS
              }
            else throw "Unsupported platform for chromedriver-pinned";

          nativeBuildInputs = [ pkgs.unzip pkgs.autoPatchelfHook ];
          buildInputs = [ pkgs.glib pkgs.nss pkgs.xorg.libX11 ];

          unpackPhase = "unzip $src";
          installPhase = ''
            mkdir -p $out/bin
            cp chromedriver-*/chromedriver $out/bin/
            chmod +x $out/bin/chromedriver
          '';
        };

        # Fonts for the headless Electron renderer.
        #
        # VS Code's workbench is a Chromium renderer, and Chromium hard-requires
        # at least one resolvable font. On a machine with zero fonts (or with no
        # fontconfig config at all) the failure is neither graceful nor legible:
        #
        #   Fontconfig error: Cannot load default config file: No such file: (null)
        #   ERROR:ui/gfx/platform_font_skia.cc:255] Could not find any font: Sans, sans.
        #   ERROR:third_party/blink/renderer/core/css/remote_font_face_source.cc:354] NOTREACHED hit.
        #   CodeWindow: renderer process gone (reason: crashed, code: 133)
        #
        # The NOTREACHED is a Blink CHECK that aborts via __builtin_trap, so the
        # renderer dies with SIGTRAP (133 = 128 + 5). `.monaco-workbench` never
        # renders, and WDIO reports it ~60s later as an opaque
        # "invalid session id" / "Connection timeout exceeded" — five failing
        # smoke tests that say nothing about fonts.
        #
        # This bit us when CI moved from the persistent `mcl-004` runner (a full
        # NixOS host that happened to have system fonts and /etc/fonts) to the
        # ephemeral `eph-linux-x64` / `garm-*` image, which has neither. The dev
        # shell must therefore carry its own fonts rather than inherit the host's.
        #
        # makeFontsConf emits a fonts.conf pointing only at these directories;
        # FONTCONFIG_FILE (exported in the shellHook) makes fontconfig use it
        # instead of looking for a nonexistent /etc/fonts/fonts.conf.
        fontPackages = with pkgs; [
          dejavu_fonts      # DejaVu Sans / Serif / Sans Mono — the sans+mono default
          liberation_ttf    # metric-compatible Arial/Times/Courier substitutes
        ];
        fontsConf = pkgs.makeFontsConf { fontDirectories = fontPackages; };

        # Libraries needed by Chromium/Electron at runtime (for WDIO + chromedriver).
        chromiumLibs = with pkgs; [
          glib
          gtk3
          nspr
          nss
          dbus
          atk
          at-spi2-atk
          at-spi2-core
          expat
          xorg.libX11
          xorg.libXcomposite
          xorg.libXdamage
          xorg.libXext
          xorg.libXfixes
          xorg.libXrandr
          mesa
          libxcb
          libxkbcommon
          udev
          alsa-lib
        ];
      in {
        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            nodejs_22
            yarn
            just
            nodePackages.typescript
            nodePackages.eslint
            vsce
            ruby_3_4
            rustc
            cargo
            gcc
            rr
            # WebdriverIO testing dependencies
            chromium
            chromedriver-pinned  # must match VS Code Insiders' Electron (currently Chrome 148)
            xorg.xorgserver      # provides Xvfb for headless VS Code on Linux
            fontconfig           # fc-list/fc-match — used by the _xvfb-run font preflight
            vscodeInsiders
          ] ++ chromiumLibs ++ fontPackages;

          shellHook = ''
            echo "CodeTracer Extension Dev Shell: Node $(node -v)"
            export LD_LIBRARY_PATH=${pkgs.lib.makeLibraryPath chromiumLibs}:''${LD_LIBRARY_PATH:-}
            # Point WDIO at the nix-provided VS Code Insiders binary
            export VSCODE_INSIDERS_PATH="${vscodeInsiders}/bin/code-insiders"
            # Use nix-provided chromedriver for WDIO (npm binary won't run on NixOS).
            # Must match the Chrome version embedded in VS Code Insiders' Electron.
            export CHROMEDRIVER_PATH="${chromedriver-pinned}/bin/chromedriver"
            export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH="${pkgs.chromium}/bin/chromium"
            export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
            # Give fontconfig a config of our own so the Electron renderer always
            # has fonts, on hosts with /etc/fonts and on bare CI images alike.
            # Without this the renderer traps in Blink (see fontsConf above).
            export FONTCONFIG_FILE="${fontsConf}"
            if [ -d "$PWD/.ct-bin" ]; then
              export PATH="$PWD/.ct-bin:$PATH"
            fi
          '';
        };
      });
}
