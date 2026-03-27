import { defineLanguageSmokeTests } from '../../helpers/language-smoke-helpers'

defineLanguageSmokeTests({
  language: 'Rust',
  traceName: 'rust-sudoku',
  expectedFileName: 'main.rs',
  calltraceFunction: 'main',
  variableName: 'test_boards',
  langId: 'Rust',
})
