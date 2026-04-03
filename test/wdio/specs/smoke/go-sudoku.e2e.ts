import { defineLanguageSmokeTests } from '../../helpers/language-smoke-helpers'

defineLanguageSmokeTests({
  language: 'Go',
  traceName: 'go-sudoku',
  // The Go source file is sudoku.go (not main.go).
  expectedFileName: 'sudoku.go',
  calltraceFunction: 'main.main',
  variableName: 'board',
  langId: 'Go',
  terminalText: '1',
})
