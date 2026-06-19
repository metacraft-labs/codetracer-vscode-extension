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
        # Chromedriver pinned to match VS Code Insiders' Electron
        # (currently Electron 33 → Chrome 148). The system chromedriver
        # from nixpkgs tracks latest Chromium and won't match. When VS
        # Code Insiders bumps Electron, bump this pin too:
        #   1. `code-insiders --version` to see the Electron+Chromium combo
        #   2. lookup the matching release in
        #      https://googlechromelabs.github.io/chrome-for-testing/known-good-versions-with-downloads.json
        #   3. recompute the hash with
        #      `nix-prefetch-url --type sha256 --unpack <url>`
        chromedriver-pinned = pkgs.stdenv.mkDerivation rec {
          pname = "chromedriver";
          version = "148.0.7778.97";
          src =
            if pkgs.stdenv.hostPlatform.system == "x86_64-linux" then
              pkgs.fetchurl {
                url = "https://storage.googleapis.com/chrome-for-testing-public/${version}/linux64/chromedriver-linux64.zip";
                hash = "sha256-rTJGeQhlcrY4oDiKlvIRhWFUgsVar8RfPwGt8TT6+/U=";
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
          # Chrome 148+ adds a runtime libdbus dep that wasn't there in 138.
          buildInputs = [ pkgs.glib pkgs.nss pkgs.xorg.libX11 pkgs.dbus ];

          unpackPhase = "unzip $src";
          installPhase = ''
            mkdir -p $out/bin
            cp chromedriver-*/chromedriver $out/bin/
            chmod +x $out/bin/chromedriver
          '';
        };

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
            # WebdriverIO testing dependencies
            chromium
            chromedriver-pinned  # must match VS Code Insiders' Electron (currently Chrome 148)
            xorg.xorgserver      # provides Xvfb for headless VS Code on Linux
            vscodeInsiders
          ] ++ chromiumLibs;

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
          '';
        };
      });
}
