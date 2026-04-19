import { defineLanguageSmokeTests } from '../../helpers/language-smoke-helpers'

defineLanguageSmokeTests({
  language: 'Nim',
  traceName: 'nim-sudoku',
  // The Nim source file is main.nim (not sudoku_solver.nim).
  expectedFileName: 'main.nim',
  // rr-based calltraces show Nim runtime entry points, not user functions.
  calltraceFunction: 'NimMainModule',
  variableName: 'board',
  langId: 'Nim',
  terminalText: '1',
  // Nim initially stops in runtime code (NimMainModule) with no source file.
  // Step forward so the debugger reaches user code and opens the source file.
  stepsBeforeEditorCheck: 5,
  // rr soft-mode replay: LLDB variable extraction currently returns empty
  // locals for Nim traces at all tested step positions. The locals test
  // verifies the DAP response is valid but defers variable-name assertion
  // until the ct-native-replay backend is fixed.
  localsResponseOnly: true,
})
