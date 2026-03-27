import { defineLanguageSmokeTests } from '../../helpers/language-smoke-helpers'

defineLanguageSmokeTests({
  language: 'Python',
  traceName: 'python-sudoku',
  expectedFileName: 'main.py',
  calltraceFunction: 'solve_sudoku',
  variableName: 'board',
  langId: 'Python',
  terminalText: '1',
})
