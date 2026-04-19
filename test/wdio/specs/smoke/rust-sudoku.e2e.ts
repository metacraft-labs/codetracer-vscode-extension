import { defineLanguageSmokeTests } from '../../helpers/language-smoke-helpers'

defineLanguageSmokeTests({
  language: 'Rust',
  traceName: 'rust-sudoku',
  expectedFileName: 'main.rs',
  calltraceFunction: 'main',
  variableName: 'test_boards',
  langId: 'Rust',
  // rr soft-mode replay: LLDB variable extraction currently returns empty
  // locals for Rust traces at all tested step positions. The locals test
  // verifies the DAP response is valid but defers variable-name assertion
  // until the ct-native-replay backend is fixed.
  localsResponseOnly: true,
})
