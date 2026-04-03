import { defineLanguageSmokeTests } from '../../helpers/language-smoke-helpers'

defineLanguageSmokeTests({
  language: 'Ruby',
  traceName: 'ruby-sudoku',
  expectedFileName: 'sudoku_solver.rb',
  calltraceFunction: 'SudokuSolver#solve',
  variableName: 'board',
  langId: 'Ruby',
  terminalText: '1',
  // The Ruby recorder only captures local variables at certain trace
  // positions. One step-over from the entry point lands on a step
  // without variable data. Step further into the trace to reach a
  // position where 'board' is in scope.
  extraStepsForLocals: 5,
})
