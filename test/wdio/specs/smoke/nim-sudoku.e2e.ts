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
  // rr-based local variable extraction via LLDB needs significant stepping
  // to reach a position where variables are in scope. LLDB variable data
  // is only available at specific debug-info locations within the trace.
  extraStepsForLocals: 50,
})
