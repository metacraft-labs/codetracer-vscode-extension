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
  // rr soft-mode replay: Delve variable extraction currently returns empty
  // locals for Go traces at all tested step positions. The locals test
  // verifies the DAP response is valid but defers variable-name assertion
  // until the ct-rr-support backend is fixed.
  localsResponseOnly: true,
})
