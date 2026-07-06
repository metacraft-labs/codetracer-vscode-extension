/**
 * M7 — WebdriverIO page-object for the embedded CodeTracer Origin Chain
 * Panel rendered inside VS Code.
 *
 * The Electron-side equivalent lives at
 * `codetracer/src/tests/gui/page-objects/originChainPane.ts` (Playwright).
 * This file mirrors its public surface so spec authors writing for both
 * harnesses can swap one page-object for the other without rewriting
 * test logic. The two helpers point at the same Nim-rendered DOM:
 *
 *  - State Pane row badge:
 *      viewmodel/views/isonim_state_view.nim::renderVariableRowImpl
 *      → `button.ct-origin-badge` inside `[data-variable-name="<name>"]`
 *  - State Pane in-row chain (open after clicking the badge):
 *      → `div.ct-origin-inline-chain > ol > li.ct-origin-inline-chain-hop`
 *      → `li.ct-origin-inline-chain-terminator`
 *  - Dedicated side panel (overlay on `document.body`):
 *      ui/state.nim::ensureOriginSidePanelHost
 *      → `aside#ct-origin-chain-side-panel`
 *      ui/isonim_origin_chain.nim::renderPanelDom
 *      → `section > ol > li` per hop, `.ct-origin-terminator-row` for the
 *        terminator, `nav > button` for breadcrumb chips, `footer button`
 *        for "Pin to scratchpad" / "Copy as markdown".
 *
 * Inside VS Code the same DOM is hosted three iframe-frames deep:
 *
 *     [outer iframe]   workbench webview host
 *       → [inner iframe]   webview shell
 *         → [content iframe]   CodeTracer renderer (document.body has the panels)
 *
 * The page-object exposes async helpers that take care of the iframe
 * descent + return-to-top hygiene so spec code doesn't have to. Every
 * helper that does DOM work calls `withCodeTracerFrame()` which finds
 * the deepest iframe whose document body contains a CodeTracer marker
 * (the State Pane's `data-variable-name` attribute, the side-panel
 * host, or one of the well-known CT class names).
 *
 * All accessibility-relevant CSS selectors come from the production
 * renderer. Drift between this file and the Nim DOM is therefore a
 * compile-time / test-time signal; the alternative — fuzzy text matches
 * via VS Code's accessibility tree — is too brittle for the in-row
 * chain (where every hop is rendered as a button with similar labels).
 */
import { browser } from "@wdio/globals"

/** CSS selectors shared between this file and the Playwright equivalent. */
export const ORIGIN_SELECTORS = {
  sidePanel: "aside#ct-origin-chain-side-panel",
  sidePanelHopRow: "aside#ct-origin-chain-side-panel section > ol > li",
  sidePanelTerminator:
    "aside#ct-origin-chain-side-panel .ct-origin-terminator-row",
  sidePanelBreadcrumb: "aside#ct-origin-chain-side-panel nav > button",
  sidePanelPinFooter: "aside#ct-origin-chain-side-panel footer button",
  inlineBadge: "button.ct-origin-badge",
  inlineChainRoot: ".ct-origin-inline-chain",
  inlineChainHop: ".ct-origin-inline-chain-hop",
  inlineChainTerminator: ".ct-origin-inline-chain-terminator",
} as const

/**
 * Markers in the CodeTracer-rendered DOM. The frame walker uses any
 * one of these to decide whether the current iframe contains the
 * embedded panel; a frame that contains none is skipped.
 */
const CT_FRAME_MARKERS = [
  "#stateComponent-0",
  "[data-variable-name]",
  ORIGIN_SELECTORS.sidePanel,
  ".ct-origin-badge",
  ".ct-state-pane",
  ".ct-origin-inline-chain",
] as const

/**
 * Run `fn` against the CodeTracer renderer document. The function is
 * invoked through `browser.execute(...)` so it runs *inside the
 * webview's content frame* — WDIO's `browser.execute` traverses the
 * currently focused frame, so we first descend into the deepest
 * iframe whose document body contains a CT marker.
 *
 * The descent is best-effort: when the panels are not yet mounted (the
 * extension activated but a `codetracer-debug` session hasn't started)
 * the function returns the caller's `notFound` sentinel.
 *
 * IMPORTANT: callers MUST treat the returned value as plain data —
 * Locator-like objects from the page do not survive serialisation
 * across the WDIO bridge.
 */
async function withCodeTracerFrame<T>(
  fn: (...args: any[]) => T,
  notFound: T,
  ...scriptArgs: any[]
): Promise<T> {
  // Always return to the top frame after running the callback so a
  // failing assertion in one spec doesn't poison the frame stack for
  // the next spec.
  try {
    await browser.switchToFrame(null)
  } catch {
    // ignore — already at top
  }

  const found = await descendIntoCodeTracerFrame()
  if (!found) {
    try {
      await browser.switchToFrame(null)
    } catch {
      /* ignore */
    }
    return notFound
  }
  try {
    // `browser.execute` injects the script function's args at call time
    // — the function itself receives `(scriptArgs[0], scriptArgs[1], …)`
    // exactly as if invoked through `Function.prototype.apply`. We
    // intentionally do NOT pass `document` here because it is always
    // available as a global inside the executed function and would just
    // round-trip the same handle uselessly.
    const out = await browser.execute(fn, ...scriptArgs)
    return out as T
  } finally {
    try {
      await browser.switchToFrame(null)
    } catch {
      /* ignore */
    }
  }
}

/**
 * Descend into nested iframes until we land in one that contains a
 * CodeTracer panel marker. Returns true on success, false otherwise.
 *
 * VS Code wraps webview content in up to three iframes (outer host,
 * inner shell, content frame). We probe each one and return as soon
 * as we find the marker — keeps the walker short-circuiting cheap.
 */
async function descendIntoCodeTracerFrame(): Promise<boolean> {
  const markerSelector = CT_FRAME_MARKERS.join(",")
  // Already at top frame on entry. Try this frame first — some VS Code
  // layouts surface the markers directly on the workbench in dev runs.
  if (await frameContainsMarker(markerSelector)) {
    return true
  }
  return descendIntoCodeTracerFrameFromHere(markerSelector, 0)
}

async function descendIntoCodeTracerFrameFromHere(
  markerSelector: string,
  depth: number,
): Promise<boolean> {
  if (depth >= 4) {
    return false
  }
  const iframes = await browser.$$("iframe")
  for (let i = 0; i < iframes.length && i < 12; i++) {
    try {
      await browser.switchToFrame(iframes[i])
    } catch {
      continue
    }
    if (await frameContainsMarker(markerSelector)) {
      return true
    }
    if (await descendIntoCodeTracerFrameFromHere(markerSelector, depth + 1)) {
      return true
    }
    try {
      await browser.switchToParentFrame()
    } catch {
      return false
    }
  }
  return false
}

async function frameContainsMarker(markerSelector: string): Promise<boolean> {
  try {
    const present = await browser.execute(
      (sel: string) => Boolean(document.querySelector(sel)),
      markerSelector,
    )
    return Boolean(present)
  } catch {
    return false
  }
}

/** Shape returned by `expandedChainHops` and `breadcrumbChips`. */
export interface HopDescriptor {
  index: number
  text: string
  ariaLabel: string | null
  classification: string | null
  kind?: string | null
  confidence?: number | null
  path?: string | null
  line?: number | null
  stepId?: string | null
}

export class OriginChainPanelPageObject {
  /**
   * Click the inline badge button on the State Pane variable row whose
   * `data-variable-name` attribute equals `variableName`.
   *
   * Returns true if the click landed on a real button, false when no
   * badge could be located (the panels probably aren't mounted yet).
   */
  async clickBadge(variableName: string): Promise<boolean> {
    return withCodeTracerFrame(
      (name: string) => {
        const row = document.querySelector(
          `[data-variable-name="${(window as any).CSS.escape(name)}"]`,
        )
        if (!row) {
          return false
        }
        const badge = row.querySelector(
          "button.ct-origin-badge",
        ) as HTMLButtonElement | null
        if (!badge) {
          return false
        }
        badge.click()
        return true
      },
      false,
      variableName,
    )
  }

  /**
   * Snapshot of every hop currently rendered in the (open) Origin Chain
   * Panel — first the dedicated side-panel rows, falling back to the
   * in-row chain rows when the side panel is closed. The Playwright
   * equivalent returns a Locator; here we return plain data because
   * Locator-like handles do not survive serialisation across the WDIO
   * `executeWorkbench` / `execute` bridge.
   */
  async expandedChainHops(): Promise<HopDescriptor[]> {
    for (let attempt = 0; attempt < 24; attempt++) {
      const hops = await this.expandedChainHopsOnce()
      if (hops.length > 0 || attempt === 23) {
        return hops
      }
      await browser.pause(250)
    }
    return []
  }

  private async expandedChainHopsOnce(): Promise<HopDescriptor[]> {
    return withCodeTracerFrame(
      () => {
        const collect = (nodes: NodeListOf<Element>) =>
          Array.from(nodes).map((el, index) => ({
            index,
            text: (el.textContent ?? "").trim(),
            ariaLabel: el.getAttribute("aria-label"),
            classification:
              el.getAttribute("data-origin-classification") ??
              el.getAttribute("data-classification"),
            kind: el.getAttribute("data-origin-kind"),
            confidence: el.getAttribute("data-origin-confidence") === null
              ? null
              : Number(el.getAttribute("data-origin-confidence")),
            path: el.getAttribute("data-origin-path"),
            line: el.getAttribute("data-origin-line") === null
              ? null
              : Number(el.getAttribute("data-origin-line")),
            stepId: el.getAttribute("data-origin-step-id"),
          }))

        const sidePanel = document.querySelector(
          "aside#ct-origin-chain-side-panel",
        )
        if (sidePanel) {
          // Side-panel rows live under `<section><ol><li>`; exclude the
          // terminator row so the index aligns with hop ordering.
          const hopRows = sidePanel.querySelectorAll(
            "section > ol > li:not(.ct-origin-terminator-row)",
          )
          if (hopRows.length > 0) {
            return collect(hopRows)
          }
        }

        // Fall back to the in-row chain (visible when only the badge has
        // been clicked, without opening the dedicated side panel).
        const inline = document.querySelectorAll(".ct-origin-inline-chain-hop")
        return collect(inline)
      },
      [] as HopDescriptor[],
    )
  }

  /**
   * Click the n-th hop button (0-based). Returns true when a hop was
   * actually clicked. The production handler dispatches
   * `OriginChainVM.onSeekToHop` → `ct/history-jump`.
   */
  async clickHop(index: number): Promise<boolean> {
    return withCodeTracerFrame(
      (i: number) => {
        const sidePanel = document.querySelector(
          "aside#ct-origin-chain-side-panel",
        )
        if (sidePanel) {
          const rows = sidePanel.querySelectorAll(
            "section > ol > li:not(.ct-origin-terminator-row)",
          )
          const row = rows.item(i)
          if (row) {
            const button =
              (row.querySelector("button") as HTMLButtonElement | null) ??
              (row as HTMLElement)
            ;(button as HTMLElement).click()
            return true
          }
        }
        const inline = document.querySelectorAll(".ct-origin-inline-chain-hop")
        const fallback = inline.item(i)
        if (fallback) {
          ;(fallback as HTMLElement).click()
          return true
        }
        return false
      },
      false,
      index,
    )
  }

  /**
   * Expand the operand-snapshot `<details>` on the currently focused
   * Computational hop. Mirrors spec §3.2.2: clicking the chevron expands
   * a third group inside the side-panel hop.
   */
  async expandComputationalOperands(): Promise<boolean> {
    return withCodeTracerFrame(() => {
      const sidePanel = document.querySelector(
        "aside#ct-origin-chain-side-panel",
      )
      if (!sidePanel) {
        return false
      }
      // Prefer the focused hop, else the first hop whose `<details>` is
      // still collapsed.
      const focused =
        (sidePanel.querySelector("li.ct-origin-focused") as Element | null) ??
        (sidePanel.querySelector(
          "section > ol > li:not(.ct-origin-terminator-row)",
        ) as Element | null)
      if (!focused) {
        return false
      }
      const details = focused.querySelector(
        "details",
      ) as HTMLDetailsElement | null
      if (!details) {
        return false
      }
      if (!details.open) {
        details.open = true
        details.dispatchEvent(new Event("toggle"))
      }
      return true
    }, false)
  }

  async expandedOperandRowCount(): Promise<number> {
    return withCodeTracerFrame(() => {
      const sidePanel = document.querySelector(
        "aside#ct-origin-chain-side-panel",
      )
      if (!sidePanel) {
        return 0
      }
      return sidePanel.querySelectorAll("details[open] > div, details[open] li")
        .length
    }, 0)
  }

  async terminatorText(): Promise<string> {
    return withCodeTracerFrame(() => {
      const sidePanel = document.querySelector(
        "aside#ct-origin-chain-side-panel",
      )
      if (!sidePanel) {
        return ""
      }
      const term = sidePanel.querySelector(".ct-origin-terminator-row")
      return (term?.textContent ?? "").trim()
    }, "")
  }

  async hasFrameTransitionMarker(): Promise<boolean> {
    return withCodeTracerFrame(() => {
      const sidePanel = document.querySelector(
        "aside#ct-origin-chain-side-panel",
      )
      if (!sidePanel) {
        return false
      }
      return Boolean(
        sidePanel.querySelector(
          ".ct-origin-frame-transition, [data-origin-classification='FrameTransition']",
        ),
      )
    }, false)
  }

  async axeViolations(axeSource: string): Promise<any[]> {
    return withCodeTracerFrame<Promise<any[]>>(
      async (source: string, selector: string) => {
        const win = window as any
        if (!win.axe) {
          new Function(source).call(win)
        }
        const result = await win.axe.run(selector)
        return result.violations
      },
      Promise.resolve([] as any[]),
      axeSource,
      ORIGIN_SELECTORS.sidePanel,
    )
  }

  /**
   * Click the footer's "Pin to scratchpad" button. The production
   * handler dispatches `OriginChainVM.onPinChain` →
   * `ScratchpadVM.addChain`.
   */
  async pinChain(): Promise<boolean> {
    return withCodeTracerFrame(() => {
      const sidePanel = document.querySelector(
        "aside#ct-origin-chain-side-panel",
      )
      if (!sidePanel) {
        return false
      }
      const buttons = Array.from(
        sidePanel.querySelectorAll("footer button"),
      ) as HTMLButtonElement[]
      const target = buttons.find((b) =>
        ((b.textContent ?? "").toLowerCase()).includes("pin"),
      )
      if (!target) {
        return false
      }
      target.click()
      return true
    }, false)
  }

  /**
   * Breadcrumb chip descriptors — one entry per
   * `OriginChainVM.breadcrumbStack` element.
   */
  async breadcrumbChips(): Promise<HopDescriptor[]> {
    return withCodeTracerFrame(
      () => {
        const sidePanel = document.querySelector(
          "aside#ct-origin-chain-side-panel",
        )
        if (!sidePanel) {
          return []
        }
        const chips = Array.from(sidePanel.querySelectorAll("nav > button"))
        return chips.map((el, index) => ({
          index,
          text: (el.textContent ?? "").trim(),
          ariaLabel: el.getAttribute("aria-label"),
          classification: el.getAttribute("data-origin-classification"),
        }))
      },
      [] as HopDescriptor[],
    )
  }

  /**
   * Truthy when the dedicated side panel is mounted on `document.body`
   * AND visible. The `display:none` toggle is driven by
   * `OriginChainVM.sidePanelOpen` per `ui/state.nim::ensureOriginSidePanelHost`.
   */
  async sidePanelVisible(): Promise<boolean> {
    for (let attempt = 0; attempt < 12; attempt++) {
      const visible = await withCodeTracerFrame(() => {
        const sidePanel = document.querySelector(
          "aside#ct-origin-chain-side-panel",
        ) as HTMLElement | null
        if (!sidePanel) {
          return false
        }
        const style = sidePanel.style.display
        if (style === "none") {
          return false
        }
        const rect = sidePanel.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0
      }, false)
      if (visible || attempt === 11) {
        return visible
      }
      await browser.pause(250)
    }
    return false
  }

  /**
   * Returns the count of inline origin badges currently rendered in
   * the State Pane (any row, any variable). Used by the
   * `inline_badge_renders_in_embedded_state_pane` verification — the
   * embedded State Pane should attach a badge to every variable row.
   */
  async inlineBadgeCount(): Promise<number> {
    return withCodeTracerFrame(() => {
      return document.querySelectorAll("button.ct-origin-badge").length
    }, 0)
  }

  /** Number of variable rows present in the State Pane. */
  async stateVariableRowCount(): Promise<number> {
    return withCodeTracerFrame(() => {
      return document.querySelectorAll("[data-variable-name]").length
    }, 0)
  }

  /**
   * Locate the deepest iframe whose document contains a CodeTracer
   * panel marker and return its `src` attribute. Diagnostic-only so
   * missing-frame failures are actionable without re-running the spec.
   */
  async describeFrame(): Promise<{ found: boolean; depth: number; src: string | null }> {
    let depth = 0
    let src: string | null = null
    try {
      await browser.switchToFrame(null)
    } catch {
      /* ignore */
    }
    const markerSelector = CT_FRAME_MARKERS.join(",")
    if (await frameContainsMarker(markerSelector)) {
      return { found: true, depth, src }
    }
    for (depth = 1; depth <= 4; depth++) {
      const iframes = await browser.$$("iframe")
      if (iframes.length === 0) {
        break
      }
      try {
        src = (await iframes[0].getAttribute("src")) || null
      } catch {
        src = null
      }
      try {
        await browser.switchToFrame(iframes[0])
      } catch {
        break
      }
      if (await frameContainsMarker(markerSelector)) {
        try {
          await browser.switchToFrame(null)
        } catch {
          /* ignore */
        }
        return { found: true, depth, src }
      }
    }
    try {
      await browser.switchToFrame(null)
    } catch {
      /* ignore */
    }
    return { found: false, depth, src }
  }
}
