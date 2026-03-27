import { defineLanguageSmokeTests } from '../../helpers/language-smoke-helpers'

defineLanguageSmokeTests({
  language: 'Ruby',
  traceName: 'ruby-sudoku',
  expectedFileName: 'sudoku_solver.rb',
  calltraceFunction: 'SudokuSolver#solve',
  variableName: 'board',
  langId: 'Ruby',
  terminalText: '1',
})
