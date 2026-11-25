import repro_project_dsl
import repro_dsl_stdlib/foreign_env

package codetracervscodeextensionEnvironment:
  devEnv:
    useFlakeDevShell()

  # THE SIBLINGS CI CLONES BESIDE THIS CHECKOUT. `uses:` is the one place a
  # dependency is declared: `repro lock refresh` derives repro.lock's
  # dependency set from it (the workspace fragment's `depends` is ignored), and
  # the wdio-integration job's `setup-dev-env` clones each bare-named sibling
  # in .github/workflows/ci.yml at the revision this repo's committed
  # repro.lock pins, refusing one the lock does not pin. Each entry is named by
  # its repository; the job's comment says what each one is for. Aiken's
  # stdlib and the Cairo compiler are not metacraft-labs repositories and
  # declare no package, so the workflow pins those two by commit instead.
  uses:
    "codetracer >=0"
    "codetracer-native-backend >=0"
    "codetracer-ruby-recorder >=0"
    "codetracer-python-recorder >=0"
    "codetracer-js-recorder >=0"
    "codetracer-wasm-instrumenter >=0"
    "codetracer-beam-recorder >=0"
    "codetracer-native-recorder >=0"
    "nim-stackable-hooks >=0"
    "codetracer-visual-replay >=0"
    "isonim >=0"
    "isonim-tui >=0"
    "nim-everywhere >=0"
    "codetracer-native-test-programs >=0"
    "codetracer-trace-format >=0"
    "codetracer-trace-format-nim >=0"
    "reprobuild-packages >=0"
    "codetracer-miden-recorder >=0"
    "codetracer-fuel-recorder >=0"
    "codetracer-move-recorder >=0"
    "codetracer-solana-recorder >=0"
    "codetracer-cardano-recorder >=0"
    "codetracer-flow-recorder >=0"
    "codetracer-cairo-recorder >=0"
    "codetracer-circom-recorder >=0"
    "codetracer-leo-recorder >=0"
    "codetracer-polkavm-recorder >=0"
    "codetracer-evm-recorder >=0"
    "codetracer-ton-recorder >=0"
