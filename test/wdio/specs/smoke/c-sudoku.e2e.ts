import { defineLanguageSmokeTests } from '../../helpers/language-smoke-helpers'

defineLanguageSmokeTests({
  language: 'C',
  traceName: 'c-sudoku',
  expectedFileName: 'main.c',
  calltraceFunction: 'solve_sudoku',
  variableName: 'board',
  langId: 'C',
  terminalText: '1',
})
