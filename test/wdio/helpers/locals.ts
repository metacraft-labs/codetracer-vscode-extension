/**
 * Pure helpers for reading a `ct/load-locals` response in WDIO specs.
 *
 * A spec that checks a variable must match it by its exact name and compare
 * the value it displays. Searching the serialized response for the name
 * instead is vacuous for short names: `JSON.stringify({ locals: [] })`
 * contains the letter `a`, and so does any response listing `storedA` or
 * `result`. These helpers exist so that no spec has a reason to do that.
 *
 * The response shape is the one CodeTracer's DAP server sends for
 * `ct/load-locals`: `{ locals: [{ expression, value: { i, r, text, f, c, … } }] }`.
 * The functions take `unknown` and never throw on an unexpected shape; a
 * malformed response simply lists no variables, which a caller's assertion
 * then reports.
 */

/** A listed variable: its exact name and the text its value displays. */
export interface ListedLocal {
  name: string
  value: string
}

/**
 * The text a `ct/load-locals` value displays: the integer (`i`) for an
 * integer local, the raw word (`r`) for a storage slot, otherwise its text
 * (`text`), float (`f`) or char (`c`). The first non-empty field wins; a
 * value with none of them displays as the empty string.
 */
export function displayValue(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return ''
  }
  const fields = value as Record<string, unknown>
  for (const field of ['i', 'r', 'text', 'f', 'c']) {
    const text = fields[field]
    if (typeof text === 'string' && text.length > 0) {
      return text
    }
  }
  return ''
}

/**
 * Every variable a `ct/load-locals` response body lists, in response order.
 * The name is the local's `expression` (falling back to `name`). Entries
 * without a name are skipped, so they can never be matched by name.
 */
export function listLocals(response: unknown): ListedLocal[] {
  const locals = (response as { locals?: unknown } | null | undefined)?.locals
  if (!Array.isArray(locals)) {
    return []
  }
  const listed: ListedLocal[] = []
  for (const entry of locals) {
    if (entry === null || typeof entry !== 'object') {
      continue
    }
    const { expression, name, value } = entry as Record<string, unknown>
    const label = typeof expression === 'string' && expression.length > 0
      ? expression
      : typeof name === 'string' ? name : ''
    if (label.length > 0) {
      listed.push({ name: label, value: displayValue(value) })
    }
  }
  return listed
}

/**
 * The variable named exactly `name` in a `ct/load-locals` response body, or
 * `undefined` when none is listed. Matching is by full, case-sensitive name:
 * `storedA` and `result` do not match `a`.
 */
export function findLocal(response: unknown, name: string): ListedLocal | undefined {
  return listLocals(response).find(local => local.name === name)
}
