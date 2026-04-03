import { defineLanguageSmokeTests } from '../../helpers/language-smoke-helpers'

defineLanguageSmokeTests({
  language: 'Rust',
  traceName: 'rust-sudoku',
  expectedFileName: 'main.rs',
  calltraceFunction: 'main',
  variableName: 'test_boards',
  langId: 'Rust',
  // rr-based local variable extraction via LLDB needs significant stepping
  // to reach a position where variables are in scope. LLDB variable data
  // is only available at specific debug-info locations within the trace.
  extraStepsForLocals: 50,
})
