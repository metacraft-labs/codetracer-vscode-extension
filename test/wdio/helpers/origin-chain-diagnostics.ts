import * as fs from 'node:fs'
import * as path from 'node:path'

const DAP_TRACE = path.resolve(
  process.cwd(),
  'test',
  'wdio',
  'diagnostics',
  'dap-trace.log',
)

interface DapTraceMessage {
  command?: string
  success?: boolean
  message?: string | null
  body?: any
}

function parseTraceJson(line: string): DapTraceMessage | null {
  const start = line.indexOf('{')
  if (start < 0) return null
  try {
    return JSON.parse(line.slice(start)) as DapTraceMessage
  } catch {
    return null
  }
}

export function latestOriginChainFailure(variableName?: string): string | null {
  if (!fs.existsSync(DAP_TRACE)) return null
  const lines = fs.readFileSync(DAP_TRACE, 'utf8').trim().split(/\r?\n/).reverse()
  for (const line of lines) {
    if (!line.includes('"command":"ct/originChain"')) continue
    if (!line.includes('<- adapter')) continue
    const message = parseTraceJson(line)
    if (!message || message.command !== 'ct/originChain' || message.success !== false) {
      continue
    }
    const detail = message.body?.message ?? message.message
    if (!detail) continue
    const prefix = variableName
      ? `ct/originChain(${variableName}) backend failure`
      : 'ct/originChain backend failure'
    return `${prefix}: ${detail}`
  }
  return null
}
