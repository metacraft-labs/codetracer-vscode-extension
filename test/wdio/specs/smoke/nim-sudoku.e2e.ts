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
  // rr-based local variable extraction via LLDB may need more stepping
  // to reach a position where variables are in scope.
  extraStepsForLocals: 5,
})
