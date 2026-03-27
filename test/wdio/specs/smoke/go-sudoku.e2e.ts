import { defineLanguageSmokeTests } from '../../helpers/language-smoke-helpers'

defineLanguageSmokeTests({
  language: 'Go',
  traceName: 'go-sudoku',
  expectedFileName: 'main.go',
  calltraceFunction: 'main.main',
  variableName: 'board',
  langId: 'Go',
  terminalText: '1',
})
