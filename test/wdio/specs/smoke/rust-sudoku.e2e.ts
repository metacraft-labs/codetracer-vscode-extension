import { defineLanguageSmokeTests } from '../../helpers/language-smoke-helpers'

defineLanguageSmokeTests({
  language: 'Rust',
  traceName: 'rust-sudoku',
  expectedFileName: 'main.rs',
  calltraceFunction: 'main',
  variableName: 'test_boards',
  langId: 'Rust',
  // rr-based local variable extraction via LLDB may need more stepping
  // to reach a position where variables are in scope.
  extraStepsForLocals: 5,
})
