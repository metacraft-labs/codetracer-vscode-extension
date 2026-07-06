/**
 * M7 — Accessibility spec for the embedded Origin Chain Panel rendered
 * inside VS Code when displaying the canonical Python fixture.
 *
 * Covers M7 verification entry:
 *   - e2e_extension_origin_python_trivial_chain_a11y
 *
 * The CodeTracer Origin Chain Panel is a complex composite widget
 * (focusable list + breadcrumb chips + pin-to-scratchpad button +
 * keyboard navigation). The M5 Electron suite runs an axe-core scan
 * scoped to `aside#ct-origin-chain-side-panel`; this VS Code-side spec
 * uses the same selector via `@axe-core/webdriverio`'s `include`
 * filter so the two scans cover the same surface.
 *
 * The spec uses the M6 `registerPanelOverride` test seam to drive the
 * command synchronously without depending on the embedded panels'
 * mount path. When no real panel is mounted *and* no test panel is
 * registered, axe scans the workbench (which is governed by VS Code's
 * own a11y testing) — in that case we fail rather than report
 * unrelated workbench-side violations.
 *
 * Spec: codetracer-specs/Planned-Features/Value-Origin-Tracking.milestones.org M7.
 */
import { browser, expect } from '@wdio/globals'
import { DebugSession, ExtensionState, OriginChainPanelPageObject, openStatePanel } from '../../page-objects'
import { captureFullDiagnostics } from '../../helpers/diagnostics'
import {
  originFixturePath,
  originFixtureTracePath,
  valueOriginSpecSkipReason,
} from '../../helpers/value-origin-fixtures'

const ext = new ExtensionState()
const debug = new DebugSession()
const origin = new OriginChainPanelPageObject()

const LANGUAGE = 'python' as const
const SCENARIO = 'simple_trivial_chain'
const TARGET_LINE = 12

describe('M7 — Python simple_trivial_chain a11y', () => {
  let skipReason: string | null = null
  const fixturePath = originFixturePath(LANGUAGE, SCENARIO)
  const tracePath = originFixtureTracePath(LANGUAGE, SCENARIO)

  before(async function () {
    skipReason = valueOriginSpecSkipReason(LANGUAGE, SCENARIO)
    if (skipReason) {
      console.log(`[M7 a11y] prerequisite failure — ${skipReason}`)
      throw new Error(skipReason ?? 'Expected value-origin UI path was unavailable: no embedded Origin Chain panel, State rows, or DAP-backed origin payload was rendered')
      return
    }
    await ext.ensureActivated()
    await ext.waitForCommands(15000)
    const started = await debug.start(tracePath)
    if (!started) {
      throw new Error(`codetracer-debug session must start for ${tracePath}`)
    }
    await debug.waitForBackendReady()
    await browser.executeWorkbench(async (vscode, p: string) => {
      const doc = await vscode.workspace.openTextDocument(p)
      await vscode.window.showTextDocument(doc, { preview: true })
    }, fixturePath)
    await debug.addBreakpoint(TARGET_LINE)
    await debug.continue(3000)
    await openStatePanel()
  })

  after(async function () {
    await debug.stop()
  })

  afterEach(async function () {
    if (this.currentTest?.state === 'failed') {
      await captureFullDiagnostics(
        `m7-python-a11y-${this.currentTest.title.replace(/\s+/g, '-').substring(0, 40)}`,
      )
    }
  })

  it('e2e_extension_origin_python_trivial_chain_a11y — no axe violations on the side panel', async function () {
    if (skipReason) {
      throw new Error(skipReason ?? 'Expected value-origin UI path was unavailable: no embedded Origin Chain panel, State rows, or DAP-backed origin payload was rendered')
      return
    }

    // Open the fixture so the editor has content for the command to
    // resolve an expression against.
    await browser.executeWorkbench(async (vscode, p: string) => {
      try {
        const doc = await vscode.workspace.openTextDocument(p)
        await vscode.window.showTextDocument(doc, { preview: true })
      } catch {
        /* ignore — top-level prerequisite failure handled this */
      }
    }, fixturePath)

    // Trigger the command end-to-end. The handler resolves the
    // expression from the active selection (or word under cursor) and
    // forwards into all mounted panels.
    await browser.executeWorkbench(async (vscode) => {
      await vscode.commands.executeCommand('ct-vscode.showValueOrigin')
    })
    await openStatePanel()

    // Probe: is the side panel actually mounted? If no real panel and
    // no `aside#ct-origin-chain-side-panel` element is reachable, scoping
    // the axe scan to that selector returns zero nodes (axe reports
    // "Selector did not match any elements"). fail explicitly rather than
    // fail because the embedded panel doesn't exist in this env — the
    // mount path is covered by M3/M5/M6.
    const visible = await origin.sidePanelVisible()
    if (!visible) {
      const description = await origin.describeFrame()
      console.log(
        '[M7 a11y] Origin Chain Panel not visible in this run; ' +
          'frame probe: ' +
          JSON.stringify(description),
      )
      throw new Error(skipReason ?? 'Expected value-origin UI path was unavailable: no embedded Origin Chain panel, State rows, or DAP-backed origin payload was rendered')
      return
    }

    // Run axe-core inside the CodeTracer webview frame, scoped to the
    // side-panel host. The WDIO axe builder starts from the top VS Code
    // frame, where this selector cannot exist.
    const { readFileSync } = await import('node:fs')
    const { createRequire } = await import('node:module')
    const requireFromHere = createRequire(__filename)
    const violations = await origin.axeViolations(
      readFileSync(requireFromHere.resolve('axe-core/axe.min.js'), 'utf8'),
    )
    if (violations.length > 0) {
      throw new Error(
        `a11y violations on embedded Origin Chain Panel: ${JSON.stringify(
          violations,
          null,
          2,
        )}`,
      )
    }
  })
})
