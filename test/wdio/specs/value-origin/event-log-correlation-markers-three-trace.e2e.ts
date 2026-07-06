/**
 * M25b §5.3 — VS Code WebdriverIO Layer-3 GUI test for Event Log
 * correlation-marker rendering against the three-trace
 * `account-balance-with-wasm` fixture.
 *
 * Mirrors the Playwright spec at
 * `codetracer/src/tests/gui/tests/value-origin/event-log-correlation-markers-three-trace.spec.ts`
 * — same fixture, same boundary IDs, same prerequisite discipline, same DOM
 * selectors (the embedded webview renders the Nim-compiled Event Log
 * view verbatim, so selectors carry across).
 *
 * Covers M25b verification entry `e2e_event_log_jump_renders_in_vscode_extension`
 * per `codetracer-specs/Planned-Features/Value-Origin-Tracking.milestones.org`.
 *
 * Fails when CT_REPO + sibling-codetracer probe both miss the fixture
 * catalogue, when any of the three `.ct` containers is absent, or when
 * the `ct` binary is missing. The fixture preparation target is the
 * prerequisite gate; the WDIO path must not pass by silently skipping.
 */
import * as fs from "node:fs"
import * as path from "node:path"

import { browser, expect } from "@wdio/globals"

import { DebugSession, ExtensionState, openEventLogPanel } from "../../page-objects"
import {
  crossProcessFixtureRoot,
  crossProcessTracePath,
  ctBinaryReason,
} from "../../helpers/value-origin-fixtures"

const HTTP_BOUNDARY_ID = "account-balance-with-wasm"
const JS_WASM_BOUNDARY_ID = "js-wasm-realm"
const REQUIRED_CONTAINERS = ["frontend.ct", "frontend-wasm.ct", "backend.ct"]

function firstMissingTraceContainer(): string | null {
  const root = crossProcessFixtureRoot()
  for (const name of REQUIRED_CONTAINERS) {
    const candidate = path.join(root, name)
    if (!fs.existsSync(candidate)) return candidate
  }
  return null
}

function specSkipReason(): string | null {
  const ctReason = ctBinaryReason()
  if (ctReason !== null) return ctReason
  const missing = firstMissingTraceContainer()
  if (missing !== null) {
    return (
      `account-balance-with-wasm fixture not materialized: ${missing} ` +
      "(regenerate.sh requires wasm-pack + codetracer_python_recorder + " +
      "ct record-web + Playwright)"
    )
  }
  return null
}

// ---- Iframe descent (mirrors page-objects/originChainPanel.ts) -----------

const EVENT_LOG_FRAME_MARKERS = [
  "div.event-log-component",
  "div.event-log-marker-rows",
  ".marker-boundary-chip",
].join(",")

async function frameHasMarker(): Promise<boolean> {
  try {
    return Boolean(
      await browser.execute(
        (sel: string) => Boolean(document.querySelector(sel)),
        EVENT_LOG_FRAME_MARKERS,
      ),
    )
  } catch {
    return false
  }
}

async function descendIntoEventLogFrame(): Promise<boolean> {
  async function descend(depth: number): Promise<boolean> {
    if (await frameHasMarker()) return true
    if (depth >= 4) return false
    const iframes = await browser.$$("iframe")
    if (iframes.length === 0) return false
    for (let i = 0; i < iframes.length && i < 12; i++) {
      try {
        await browser.switchToFrame(iframes[i])
      } catch {
        continue
      }
      if (await descend(depth + 1)) return true
      try {
        await browser.switchToParentFrame()
      } catch {
        return false
      }
    }
    return false
  }

  try {
    return await descend(0)
  } finally {
    if (!(await frameHasMarker())) {
      try {
        await browser.switchToFrame(null)
      } catch { /* ignore */ }
    }
  }
}

async function withEventLogFrame<T>(
  fn: (...args: any[]) => T,
  notFound: T,
  ...scriptArgs: any[]
): Promise<T> {
  try {
    await browser.switchToFrame(null)
  } catch { /* already at top */ }
  if (!(await descendIntoEventLogFrame())) {
    try { await browser.switchToFrame(null) } catch { /* ignore */ }
    return notFound
  }
  try {
    return (await browser.execute(fn, ...scriptArgs)) as T
  } finally {
    try { await browser.switchToFrame(null) } catch { /* ignore */ }
  }
}

interface MarkerRowSnapshot {
  found: boolean
  keyValue: string
  stepId: string
  chipText: string
  hasDirectionIcon: boolean
}
const NOT_FOUND_ROW: MarkerRowSnapshot = {
  found: false, keyValue: "", stepId: "", chipText: "", hasDirectionIcon: false,
}

async function readMarkerRow(boundaryId: string): Promise<MarkerRowSnapshot> {
  return withEventLogFrame(
    (bid: string): MarkerRowSnapshot => {
      const row = document.querySelector(
        `div.event-log-marker-rows div.marker-row[data-boundary-id="${bid}"]`,
      ) as HTMLElement | null
      if (!row) {
        return { found: false, keyValue: "", stepId: "", chipText: "", hasDirectionIcon: false }
      }
      const chip = row.querySelector("span.marker-boundary-chip")
      return {
        found: true,
        keyValue: row.getAttribute("data-key-value") ?? "",
        stepId: row.getAttribute("data-step-id") ?? "",
        chipText: (chip?.textContent ?? "").trim(),
        hasDirectionIcon: Boolean(row.querySelector("span.marker-direction-icon")),
      }
    },
    NOT_FOUND_ROW,
    boundaryId,
  )
}

async function clickMarkerChip(boundaryId: string): Promise<boolean> {
  return withEventLogFrame(
    (bid: string): boolean => {
      const row = document.querySelector(
        `div.event-log-marker-rows div.marker-row[data-boundary-id="${bid}"]`,
      )
      const chip = row?.querySelector("span.marker-boundary-chip") as HTMLElement | null
      if (!chip) return false
      chip.click()
      return true
    },
    false,
    boundaryId,
  )
}

async function activeRecordingRole(): Promise<string | null> {
  return withEventLogFrame((): string | null => {
    const d = (window as any).data
    return (
      d?.activeRecording?.role ??
      d?.activeProcess?.role ??
      d?.session?.activeProcess?.role ??
      d?.sessions?.[d?.activeSessionIndex ?? 0]?.activeRecording?.role ??
      null
    )
  }, null)
}

describe("M25b §5.3 — Event Log correlation-marker rendering (three-trace, VS Code)", () => {
  const ext = new ExtensionState()
  const debug = new DebugSession()

  before(async function () {
    const reason = specSkipReason()
    expect(reason).toBe(null)
    await ext.ensureActivated()
    await ext.waitForCommands(15_000)
    const traceFolder = crossProcessTracePath("frontend.ct")
    const started = await debug.start(traceFolder)
    if (!started) {
      throw new Error(`codetracer-debug session must start for ${traceFolder}`)
    }
    await openEventLogPanel()
    await browser.pause(1_500)
  })

  after(async function () {
    await debug.stop()
  })

  it("e2e_event_log_jump_renders_in_vscode_extension — both boundary markers render with chip badges", async function () {
    const httpRow = await readMarkerRow(HTTP_BOUNDARY_ID)
    if (!httpRow.found) {
      throw new Error(`Event Log marker row ${HTTP_BOUNDARY_ID} must be visible`)
    }
    expect(httpRow.chipText).toBe(`[${HTTP_BOUNDARY_ID}]`)
    expect(httpRow.keyValue).toBe("620")
    expect(httpRow.hasDirectionIcon).toBe(true)

    const realmRow = await readMarkerRow(JS_WASM_BOUNDARY_ID)
    if (!realmRow.found) {
      throw new Error(`Event Log marker row ${JS_WASM_BOUNDARY_ID} must be visible`)
    }
    expect(realmRow.chipText).toBe(`[${JS_WASM_BOUNDARY_ID}]`)
    expect(realmRow.hasDirectionIcon).toBe(true)

    // §5.3 — click the chip; active recording must flip to frontend-js.
    expect(await clickMarkerChip(HTTP_BOUNDARY_ID)).toBe(true)
    await browser.pause(1500)

    const role = await activeRecordingRole()
    expect(role).toBe("frontend-js")
  })
})
