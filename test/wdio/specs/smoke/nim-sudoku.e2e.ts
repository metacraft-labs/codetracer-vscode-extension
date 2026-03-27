import { defineLanguageSmokeTests } from '../../helpers/language-smoke-helpers'

defineLanguageSmokeTests({
  language: 'Nim',
  traceName: 'nim-sudoku',
  expectedFileName: 'sudoku_solver.nim',
  calltraceFunction: 'solveSudoku',
  variableName: 'board',
  langId: 'Nim',
  terminalText: '1',
})
