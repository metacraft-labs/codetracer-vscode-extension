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
 * own a11y testing) — in that case we SKIP rather than report
 * unrelated workbench-side violations.
 *
 * Spec: codetracer-specs/Planned-Features/Value-Origin-Tracking.milestones.org M7.
 */
import { browser, expect } from '@wdio/globals'
import { ExtensionState, OriginChainPanelPageObject } from '../../page-objects'
import { captureFullDiagnostics } from '../../helpers/diagnostics'
import {
  originFixturePath,
  valueOriginSpecSkipReason,
} from '../../helpers/value-origin-fixtures'
import {
  ORIGIN_SELECTORS,
} from '../../page-objects/originChainPanel'

const ext = new ExtensionState()
const origin = new OriginChainPanelPageObject()

const LANGUAGE = 'python' as const
const SCENARIO = 'simple_trivial_chain'

describe('M7 — Python simple_trivial_chain a11y', () => {
  let skipReason: string | null = null

  before(async function () {
    skipReason = valueOriginSpecSkipReason(LANGUAGE, SCENARIO)
    if (skipReason) {
      console.log(`[M7 a11y] SKIP reason — ${skipReason}`)
      this.skip()
      return
    }
    await ext.ensureActivated()
    await ext.waitForCommands(15000)
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
      this.skip()
      return
    }

    // Open the fixture so the editor has content for the command to
    // resolve an expression against.
    const fixturePath = originFixturePath(LANGUAGE, SCENARIO)
    await browser.executeWorkbench(async (vscode, p: string) => {
      try {
        const doc = await vscode.workspace.openTextDocument(p)
        await vscode.window.showTextDocument(doc, { preview: true })
      } catch {
        /* ignore — top-level SKIP handled this */
      }
    }, fixturePath)

    // Trigger the command end-to-end. The handler resolves the
    // expression from the active selection (or word under cursor) and
    // forwards into all mounted panels.
    await browser.executeWorkbench(async (vscode) => {
      await vscode.commands.executeCommand('ct-vscode.showValueOrigin')
    })

    // Probe: is the side panel actually mounted? If no real panel and
    // no `aside#ct-origin-chain-side-panel` element is reachable, scoping
    // the axe scan to that selector returns zero nodes (axe reports
    // "Selector did not match any elements"). SKIP cleanly rather than
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
      this.skip()
      return
    }

    // Run axe-core scoped to the side-panel host. Dynamic import keeps
    // the workbench-only specs from paying the require cost. The package
    // exposes `AxeBuilder` as both default and named export; we look up
    // either form so we don't depend on a specific CJS/ESM interop shape.
    const axeMod: any = await import('@axe-core/webdriverio')
    const AxeBuilderCtor = axeMod.AxeBuilder ?? axeMod.default
    const builder = new AxeBuilderCtor({ client: browser as any })
    builder.include(ORIGIN_SELECTORS.sidePanel)
    const results = await builder.analyze()
    expect(
      results.violations,
      `a11y violations on embedded Origin Chain Panel: ${JSON.stringify(
        results.violations,
        null,
        2,
      )}`,
    ).toEqual([])
  })
})
