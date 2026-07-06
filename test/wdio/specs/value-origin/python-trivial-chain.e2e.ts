/**
 * M7 — VS Code WebdriverIO spec for the Python `simple_trivial_chain`
 * Value Origin fixture.
 *
 * Covers M7 verification entries:
 *
 *   - e2e_extension_origin_python_trivial_chain — three hops render
 *     inside the embedded Origin Chain Panel after triggering
 *     `ct-vscode.showValueOrigin`.
 *   - e2e_extension_origin_click_hop_jumps_editor — clicking a hop
 *     in the embedded panel jumps the active editor.
 *   - e2e_extension_inline_badge_renders_in_embedded_state_pane —
 *     opening the fixture trace renders an inline origin badge on
 *     every variable row.
 *   - e2e_extension_origin_hover_pill — VS Code editor hover-pill
 *     activation path. M4 honestly deferred the editor hover card
 *     because there is no Monaco hover provider in the extension
 *     (`src/extension.ts` does not register a HoverProvider for the
 *     "↑ origin" pill); the same deferral applies to the VS Code
 *     bridge in M6, so this test fails explicitly with a precise reason.
 *     The test exists so the verification matrix lines up 1:1 with
 *     the milestone table; without the failing body the entry would be
 *     silently absent.
 *
 * Fixture: `$CT_REPO/src/db-backend/tests/fixtures/origin/python/simple_trivial_chain/`.
 * ANSWERS.md asserts the chain for `c` at the `print(c)` line walks
 * `c -> b -> a -> Literal(10)`.
 *
 * Environment prerequisite discipline mirrors the M3/M5/M6 specs:
 *   - When the locally synced fixture is missing (CT_REPO unset and
 *     no sibling codetracer/ checkout), fail with a fixture-not-found
 *     reason that names the env var to set.
 *   - When the Python recorder isn't importable from python3, fail
 *     with the same reason the M3 layer uses (`require_python_recorder`).
 *   - When the `ct` binary is not on PATH and CODETRACER_PATH is
 *     unset, fail with the binary-missing reason.
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

const SHOW_VALUE_ORIGIN_COMMAND = 'ct-vscode.showValueOrigin'
const LANGUAGE = 'python' as const
const SCENARIO = 'simple_trivial_chain'
const TARGET_LINE = 12

/**
 * Drive the extension into the state the assertions need:
 *   1. Open the fixture's main.py.
 *   2. Move the cursor onto `c` at the `print(c)` line.
 *   3. Position a selection on the `c` token so the command resolves
 *      the right expression.
 *
 * Returns true on success, false when the fixture isn't on disk (the
 * spec prerequisite-probe should have already caught this).
 */
async function focusOnVariableC(fixturePath: string): Promise<boolean> {
  return browser.executeWorkbench(async (vscode, p: string) => {
    try {
      const doc = await vscode.workspace.openTextDocument(p)
      const editor = await vscode.window.showTextDocument(doc, { preview: true })
      // Walk the document for `print(c)` and place the selection on `c`.
      const text = doc.getText()
      const lines = text.split(/\r?\n/)
      for (let i = 0; i < lines.length; i++) {
        const idx = lines[i].indexOf('print(c)')
        if (idx >= 0) {
          // Inside `print(c)` the `c` sits at `idx + 6` (after `print(`).
          const cCol = idx + 'print('.length
          const pos = new vscode.Position(i, cCol)
          editor.selection = new vscode.Selection(
            pos,
            new vscode.Position(i, cCol + 1),
          )
          editor.revealRange(new vscode.Range(pos, pos))
          return true
        }
      }
      return false
    } catch {
      return false
    }
  }, fixturePath)
}

async function fixtureEditorLine(fixturePath: string): Promise<number> {
  return browser.executeWorkbench(async (vscode, p: string) => {
    const visible = vscode.window.visibleTextEditors.find(
      (editor) => editor.document.uri.fsPath === p,
    )
    if (visible) {
      return visible.selection.active.line + 1
    }
    const active = vscode.window.activeTextEditor
    if (active?.document.uri.fsPath === p) {
      return active.selection.active.line + 1
    }
    const doc = await vscode.workspace.openTextDocument(p)
    const editor = await vscode.window.showTextDocument(doc, { preview: true })
    return editor.selection.active.line + 1
  }, fixturePath)
}

async function debugTopFrameLine(): Promise<number> {
  return browser.executeWorkbench(async (vscode) => {
    const session = vscode.debug.activeDebugSession
    if (!session) {
      return -1
    }
    const threads = await session.customRequest('threads')
    const threadId = threads?.threads?.[0]?.id
    if (typeof threadId !== 'number') {
      return -1
    }
    const trace = await session.customRequest('stackTrace', {
      threadId,
      startFrame: 0,
      levels: 1,
    })
    const line = trace?.stackFrames?.[0]?.line
    return typeof line === 'number' ? line : -1
  })
}

describe('M7 — Python simple_trivial_chain Value Origin', () => {
  let skipReason: string | null = null
  const fixturePath = originFixturePath(LANGUAGE, SCENARIO)
  const tracePath = originFixtureTracePath(LANGUAGE, SCENARIO)

  before(async function () {
    skipReason = valueOriginSpecSkipReason(LANGUAGE, SCENARIO)
    if (skipReason) {
      console.log(`[M7] prerequisite failure — ${skipReason}`)
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
        `m7-python-trivial-${this.currentTest.title.replace(/\s+/g, '-').substring(0, 40)}`,
      )
    }
  })

  it('e2e_extension_origin_python_trivial_chain — three hops render in the embedded panel', async function () {
    if (skipReason) {
      throw new Error(skipReason ?? 'Expected value-origin UI path was unavailable: no embedded Origin Chain panel, State rows, or DAP-backed origin payload was rendered')
      return
    }

    // Step 1: open the fixture and place the cursor on `c`.
    const focused = await focusOnVariableC(fixturePath)
    expect(focused).toBe(true)

    // Step 2: trigger the command and verify it was forwarded into a
    // panel (real or test seam). We install a panel override so the
    // verification doesn't depend on the embedded webview having
    // fully mounted (it usually has not, in a no-recorder dev shell).
    const result = await browser.executeWorkbench(
      async (vscode, command: string) => {
        const extension = vscode.extensions.getExtension('metacraft-labs.ct-vscode')
        if (!extension) {
          return { error: 'extension not found', commandMessage: null as any }
        }
        if (!extension.isActive) {
          await extension.activate()
        }
        const exports = extension.exports as any
        if (!exports || typeof exports.registerPanelOverride !== 'function') {
          return { error: 'M6 test seam missing', commandMessage: null as any }
        }
        const messages: any[] = []
        const dispose = exports.registerPanelOverride('m7-python-trivial', {
          webview: {
            postMessage(msg: any) {
              messages.push(msg)
              return Promise.resolve(true)
            },
          },
        })
        try {
          await vscode.commands.executeCommand(command)
        } finally {
          dispose()
        }
        const commandMessage = messages.find(
          (m) => m?.command === 'showValueOrigin',
        )
        return { error: null as string | null, commandMessage }
      },
      SHOW_VALUE_ORIGIN_COMMAND,
    )

    expect((result as any).error).toBeNull()
    // The command resolved the expression from the active editor's
    // selection — assert it matched the `c` variable as the spec expects.
    const msg = (result as any).commandMessage
    expect(msg).toBeDefined()
    expect(msg?.value?.expression).toBe('c')
    await openStatePanel()

    // Step 3: probe the embedded panel for the three-hop chain. This
    // path only succeeds when a real `codetracer-debug` session has
    // mounted the panels and the db-backend has emitted the chain.
    // In a recorder-equipped CI environment we expect three hops;
    // otherwise the probe returns 0 hops and we fail rather than fail
    // (the panel mount + DAP path are covered by M3 + M5 + M6 already).
    const hops = await origin.expandedChainHops()
    if (hops.length === 0) {
      const description = await origin.describeFrame()
      console.log(
        '[M7] Embedded Origin Chain Panel not visible in this run; ' +
          'panel/frame probe: ' +
          JSON.stringify(description),
      )
      throw new Error(skipReason ?? 'Expected value-origin UI path was unavailable: no embedded Origin Chain panel, State rows, or DAP-backed origin payload was rendered')
      return
    }
    expect(hops.length).toBe(3)
  })

  it('e2e_extension_origin_click_hop_jumps_editor — clicking a hop seeks the editor', async function () {
    if (skipReason) {
      throw new Error(skipReason ?? 'Expected value-origin UI path was unavailable: no embedded Origin Chain panel, State rows, or DAP-backed origin payload was rendered')
      return
    }

    const focused = await focusOnVariableC(fixturePath)
    expect(focused).toBe(true)

    await browser.executeWorkbench(
      async (vscode, command: string) => {
        await vscode.commands.executeCommand(command)
      },
      SHOW_VALUE_ORIGIN_COMMAND,
    )
    await openStatePanel()

    const hops = await origin.expandedChainHops()
    if (hops.length === 0) {
      const description = await origin.describeFrame()
      console.log(
        '[M7] Embedded panel hops not present (probable: no DAP session); frame=' +
          JSON.stringify(description),
      )
      throw new Error(skipReason ?? 'Expected value-origin UI path was unavailable: no embedded Origin Chain panel, State rows, or DAP-backed origin payload was rendered')
      return
    }

    const targetHop = hops[1]
    expect(targetHop?.line).toEqual(expect.any(Number))
    const beforeLine = await debugTopFrameLine()
    expect(beforeLine).not.toBe(targetHop.line)

    // Click the middle hop (index 1) — for the canonical chain this
    // jumps the editor to the `b = a` assignment.
    const clicked = await origin.clickHop(1)
    expect(clicked).toBe(true)

    await browser.waitUntil(async () => {
      const editorLine = await fixtureEditorLine(fixturePath)
      const debugLine = await debugTopFrameLine()
      return editorLine === targetHop.line && debugLine === targetHop.line
    }, {
      timeout: 3000,
      interval: 100,
      timeoutMsg: `expected hop click to seek editor and debugger to line ${targetHop.line}`,
    })

    const afterLine = await debugTopFrameLine()
    expect(afterLine).toBe(targetHop.line)
    expect(afterLine).not.toBe(beforeLine)
  })

  it('e2e_extension_inline_badge_renders_in_embedded_state_pane — every variable row has a badge', async function () {
    if (skipReason) {
      throw new Error(skipReason ?? 'Expected value-origin UI path was unavailable: no embedded Origin Chain panel, State rows, or DAP-backed origin payload was rendered')
      return
    }

    // The embedded State Pane mounts via `initPanels`; when no DAP
    // session is alive the pane has no rows at all. In that case we
    // fail rather than assert a vacuous truth.
    await openStatePanel()
    const rows = await origin.stateVariableRowCount()
    if (rows === 0) {
      const description = await origin.describeFrame()
      console.log(
        '[M7] State Pane has no rows in this run (probable: no DAP session); frame=' +
          JSON.stringify(description),
      )
      throw new Error(skipReason ?? 'Expected value-origin UI path was unavailable: no embedded Origin Chain panel, State rows, or DAP-backed origin payload was rendered')
      return
    }
    const badges = await origin.inlineBadgeCount()
    expect(badges).toBe(rows)
  })

  it('e2e_extension_origin_hover_pill — editor hover pill activates the command', async function () {
    if (skipReason) {
      throw new Error(skipReason ?? 'Expected value-origin UI path was unavailable: no embedded Origin Chain panel, State rows, or DAP-backed origin payload was rendered')
      return
    }

    const focused = await focusOnVariableC(fixturePath)
    expect(focused).toBe(true)

    const hoverResult = await browser.executeWorkbench(async (vscode, p: string) => {
      const doc = await vscode.workspace.openTextDocument(p)
      const editor = await vscode.window.showTextDocument(doc, { preview: true })
      const line = doc.getText().split(/\r?\n/).findIndex((text) => text.includes('print(c)'))
      if (line < 0) {
        return { error: 'print(c) line not found', commandArgs: null as any }
      }
      const character = doc.lineAt(line).text.indexOf('c)')
      const pos = new vscode.Position(line, character)
      editor.selection = new vscode.Selection(pos, pos)
      const hovers = await vscode.commands.executeCommand(
        'vscode.executeHoverProvider',
        doc.uri,
        pos,
      ) as any[]
      const markdown = hovers
        .flatMap((hover) => hover.contents ?? [])
        .map((content) => typeof content === 'string' ? content : content?.value ?? String(content))
        .join('\n')
      const match = markdown.match(/command:ct-vscode\.showValueOrigin\?([^)\s]+)/)
      if (!match) {
        return { error: `showValueOrigin hover command missing: ${markdown}`, commandArgs: null as any }
      }
      return {
        error: null as string | null,
        commandArgs: JSON.parse(decodeURIComponent(match[1])),
      }
    }, fixturePath)

    expect((hoverResult as any).error).toBeNull()
    const commandArgs = (hoverResult as any).commandArgs
    expect(commandArgs?.[0]?.expression).toBe('c')

    const commandResult = await browser.executeWorkbench(async (vscode, payload: any, command: string) => {
      const extension = vscode.extensions.getExtension('metacraft-labs.ct-vscode')
      if (!extension) {
        return { error: 'extension not found', commandMessage: null as any }
      }
      if (!extension.isActive) {
        await extension.activate()
      }
      const exports = extension.exports as any
      if (!exports || typeof exports.registerPanelOverride !== 'function') {
        return { error: 'M6 test seam missing', commandMessage: null as any }
      }
      const messages: any[] = []
      const dispose = exports.registerPanelOverride('m7-python-hover', {
        webview: {
          postMessage(msg: any) {
            messages.push(msg)
            return Promise.resolve(true)
          },
        },
      })
      try {
        await vscode.commands.executeCommand(command, payload)
      } finally {
        dispose()
      }
      const commandMessage = messages.find(
        (m) => m?.command === 'showValueOrigin',
      )
      return { error: null as string | null, commandMessage }
    }, commandArgs[0], SHOW_VALUE_ORIGIN_COMMAND)

    expect((commandResult as any).error).toBeNull()
    expect((commandResult as any).commandMessage?.value?.expression).toBe('c')
  })
})
