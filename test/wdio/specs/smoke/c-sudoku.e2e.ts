import { defineLanguageSmokeTests } from '../../helpers/language-smoke-helpers'

defineLanguageSmokeTests({
  language: 'C',
  traceName: 'c-sudoku',
  expectedFileName: 'main.c',
  // rr-based calltraces only show top-level functions (children not expanded).
  calltraceFunction: 'main',
  variableName: 'board',
  langId: 'C',
  terminalText: '1',
})
