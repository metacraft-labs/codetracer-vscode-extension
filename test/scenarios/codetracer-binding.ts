// CodeTracer's WebDriverIO binding: the VS Code flavour of the CodeTracer
// scenario pack (../codetracer/src/tests/scenarios/pack/codetracer.pack.yaml,
// the extension's sibling checkout).
//
// Loaded by DemoVideoScript-WebDriverIO's arm (`node src/main.ts --binding
// <this file>`), which answers the scenario runner's backend protocol through
// one WebDriver session. This module supplies what is the extension's:
//
//   * `launch`: VS Code with this extension, started through VS Code's
//     WebDriver service (wdio-vscode-service), on a workspace and user
//     settings of the run's own;
//   * the stages: recordings are made through the pack's one stage
//     implementation (`ct-scenario-stage`, the Nim code every CodeTracer
//     binding runs); `open-recording` then starts VS Code, starts a
//     CodeTracer debug session on the recording and opens the panels the
//     scenario asks for (`panes`), as a user would before the steps begin;
//   * the surface: the page objects a user sees, read from the workbench's
//     DOM and from the panels' webviews (VS Code draws each CodeTracer panel
//     in a nested frame; the reader descends into it, reads, and returns to
//     the top frame). Reading only: nothing here changes the window;
//   * the conditions it can detect (`replay-idle`);
//   * the binding resolver: the chord VS Code binds to an operation is the
//     one this extension contributes (package.json `contributes.keybindings`)
//     for the command that performs it; with none, `null`.
//
// Input never goes through here: the arm delivers it as W3C WebDriver Actions
// (real key, pointer and wheel input), and its lint refuses script injection
// on that path.
//
// No mocks: the recording, the replay server, the extension and VS Code are
// the real ones.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { remote } from "webdriverio";

// The arm's stdout is the runner's protocol channel: what the WebDriver
// libraries log goes to stderr, and only errors.
process.env.WDIO_LOG_LEVEL ??= "error";
// `switchToFrame` is the classic WebDriver command this binding reads frames
// with (WebDriverIO's `switchFrame` goes through BiDi when it can).
process.env.DISABLE_WEBDRIVERIO_DEPRECATION_WARNINGS ??= "1";
console.log = console.error;
console.info = console.error;
console.debug = console.error;

type Ctx = any;
type Node = {
  role: string;
  keys: Array<[string, string]>;
  props: Record<string, unknown>;
  x: number;
  y: number;
  w: number;
  h: number;
  visible: boolean;
  focused?: boolean;
  unreadable?: Record<string, string>;
  children: Node[];
  anchors?: Record<string, unknown>;
};

const here = path.dirname(fileURLToPath(import.meta.url));
/** This extension's checkout. */
const extRoot = path.resolve(here, "..", "..");
/** The codetracer checkout beside it (the pack, `ct`, `ct-scenario-stage`). */
const ctRoot = path.resolve(process.env.CODETRACER_DIR ?? path.join(extRoot, "..", "codetracer"));

function stageCli(): string {
  const p = process.env.CT_SCENARIO_STAGE ?? path.join(ctRoot, "build", "bin", "ct-scenario-stage");
  if (!fs.existsSync(p)) {
    throw new Error(`ct-scenario-stage is not built at ${p} (codetracer: just scenario-build)`);
  }
  return p;
}

function runStageCli(args: string[]): any {
  const r = spawnSync(stageCli(), args, { encoding: "utf-8", maxBuffer: 64 << 20 });
  if (r.status !== 0) {
    throw new Error(`ct-scenario-stage ${args[0]} ${args[2] ?? ""}: ${(r.stderr || r.stdout || "").trim()}`);
  }
  const out = r.stdout.trim().split("\n").filter((l) => l.startsWith("{")).pop() ?? "{}";
  return JSON.parse(out);
}

// --- what this binding can deliver --------------------------------------------

const ROLES: Record<string, { affordances: string[]; properties: string[] }> = {
  window: { affordances: [], properties: ["title", "mode"] },
  "pane-tab": { affordances: ["click", "context-click"], properties: ["label", "active"] },
  toolbar: { affordances: [], properties: [] },
  "toolbar-button": { affordances: ["click"], properties: ["label", "enabled"] },
  editor: {
    affordances: ["click", "context-click", "wheel", "focusable", "text-entry"],
    properties: ["file", "active", "focused", "current-line", "caret-line",
                 "first-visible", "last-visible", "text"],
  },
  line: {
    affordances: ["click", "double-click", "context-click"],
    properties: ["number", "text", "current", "caret", "breakpoint"],
  },
  "call-trace": { affordances: ["wheel", "focusable"], properties: ["count", "focused"] },
  call: { affordances: ["click", "double-click", "context-click"],
          properties: ["name", "arguments", "selected"] },
  "event-log": { affordances: ["wheel", "focusable"],
                 properties: ["count", "total", "last-shown", "focused"] },
  event: { affordances: ["click", "double-click", "context-click"], properties: ["text", "kind"] },
  "event-marker": { affordances: ["click"], properties: ["boundary", "chip", "key-value", "direction"] },
  variables: { affordances: ["wheel", "focusable"], properties: ["count", "focused"] },
  variable: { affordances: ["click", "double-click", "context-click"],
              properties: ["name", "value", "origin-badge"] },
  scratchpad: { affordances: [], properties: ["count"] },
  "scratch-entry": { affordances: ["click", "context-click"], properties: ["expression", "value", "error"] },
  requests: { affordances: [], properties: ["count", "header", "body"] },
  "origin-chain": { affordances: [], properties: ["count", "terminator"] },
  "origin-hop": { affordances: ["click"],
                  properties: ["number", "text", "classification", "confidence", "line",
                               "frame-transition", "operands"] },
  "hover-card": { affordances: [], properties: ["text"] },
  "hover-link": { affordances: ["click"], properties: ["label"] },
  omnibox: { affordances: ["click", "text-entry", "focusable"], properties: ["query", "focused", "count"] },
  option: { affordances: ["click"], properties: ["label", "selected"] },
  "context-menu": { affordances: [], properties: ["count"] },
  "menu-item": { affordances: ["click"], properties: ["label", "enabled", "shortcut"] },
};

// --- the surface: the workbench ------------------------------------------------

// Runs IN THE WORKBENCH (VS Code's top frame). Reads only.
function readWorkbench(): any {
  const vis = (el: Element | null): boolean => {
    if (!el) return false;
    const r = (el as HTMLElement).getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    let e: Element | null = el;
    while (e) {
      const cs = getComputedStyle(e as HTMLElement);
      if (cs.visibility === "hidden" || cs.display === "none") return false;
      e = e.parentElement;
    }
    return true;
  };
  const box = (el: Element) => {
    const r = (el as HTMLElement).getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  };
  const text = (el: Element | null | undefined) =>
    ((el?.textContent ?? "").replace(/ /g, " ").replace(/\s+/g, " ").trim());
  const node = (role: string, el: Element | null, props: Record<string, unknown>,
                keys: Array<[string, string]> = []): any => {
    const b = el ? box(el) : { x: 0, y: 0, w: 0, h: 0 };
    return { role, keys, props, ...b, visible: el ? vis(el) : false, children: [] };
  };
  const active = document.activeElement;
  const within = (el: Element | null) => !!(el && active && (el === active || el.contains(active)));

  const debugBar = document.querySelector(".debug-toolbar");
  const root = node("window", document.body, {
    title: document.title,
    mode: debugBar && vis(debugBar) ? "debug" : "edit",
  });
  root.x = 0; root.y = 0; root.w = window.innerWidth; root.h = window.innerHeight; root.visible = true;

  // pane tabs: every tab of every editor group (source files and panels)
  const groups = Array.from(document.querySelectorAll(".editor-group-container")) as HTMLElement[];
  for (const g of groups) {
    const strip = (g.querySelector(".tabs-container") as HTMLElement | null)?.getBoundingClientRect();
    for (const t of Array.from(g.querySelectorAll(".tabs-container .tab")) as HTMLElement[]) {
      if (!vis(t)) continue;
      // a tab scrolled out of the strip is not on screen
      const tb = t.getBoundingClientRect();
      if (strip && (tb.right <= strip.left + 1 || tb.left >= strip.right - 1)) continue;
      const label = text(t.querySelector(".label-name") ?? t.querySelector(".monaco-icon-label") ?? t);
      if (!label) continue;
      root.children.push(node("pane-tab", t, { label, active: t.classList.contains("active") },
        [["label", label]]));
    }
  }

  // the debug toolbar
  if (debugBar && vis(debugBar)) {
    const tb = node("toolbar", debugBar, {});
    for (const a of Array.from(debugBar.querySelectorAll(".action-item .action-label")) as HTMLElement[]) {
      if (!vis(a)) continue;
      const label = (a.getAttribute("aria-label") ?? "").replace(/\s*\([^)]*\)\s*$/, "").trim();
      if (!label) continue;
      tb.children.push(node("toolbar-button", a, {
        label, enabled: !a.classList.contains("disabled") && a.getAttribute("aria-disabled") !== "true",
      }, [["label", label]]));
    }
    root.children.push(tb);
  }

  // editors: the text editor each group shows; its file is the group's active tab
  for (const g of groups) {
    const ed = g.querySelector(".editor-container .monaco-editor") as HTMLElement | null;
    if (!ed || !vis(ed)) continue;
    const tab = g.querySelector(".tabs-container .tab.active") as HTMLElement | null;
    const file = text(tab?.querySelector(".label-name") ?? tab);
    if (!file) continue;
    const props: Record<string, unknown> = {
      file, active: g.classList.contains("active"), focused: ed.classList.contains("focused") || within(ed),
      "current-line": 0, "caret-line": 0, "first-visible": 0, "last-visible": 0, text: [] as string[],
    };
    const editorNode = node("editor", ed, props, [["file", file]]);
    const edBox = ed.getBoundingClientRect();
    // Each line number in the margin; the view line, the decorations and the
    // glyphs drawn at the same height are that line's.
    const numbers = (Array.from(ed.querySelectorAll(".margin-view-overlays .line-numbers")) as HTMLElement[])
      .map((n) => ({ n: parseInt(text(n), 10), el: n, top: n.getBoundingClientRect().top }))
      .filter((r) => r.n > 0);
    const viewLines = Array.from(ed.querySelectorAll(".view-lines > .view-line")) as HTMLElement[];
    const tops = (sel: string) => (Array.from(ed.querySelectorAll(sel)) as HTMLElement[])
      .filter((e) => e.getBoundingClientRect().height > 0)
      .map((e) => e.getBoundingClientRect().top);
    const near = (list: number[], top: number, h: number) => list.some((t) => t >= top - 2 && t < top + h - 2);
    const currentTops = tops(".debug-top-stack-frame-line, .codicon-debug-stackframe");
    const breakpointTops = tops(".codicon-debug-breakpoint, .codicon-debug-breakpoint-unverified, .codicon-debug-breakpoint-conditional");
    const cursor = (Array.from(ed.querySelectorAll(".cursors-layer .cursor")) as HTMLElement[])
      .find((c) => c.getBoundingClientRect().height > 0);
    const cursorTop = cursor && props.focused ? cursor.getBoundingClientRect().top : undefined;
    const rows = numbers
      .filter((r) => r.top >= edBox.top - 1 && r.top < edBox.bottom - 1)
      .sort((a, b) => a.n - b.n);
    const texts: string[] = [];
    for (const r of rows) {
      const lb = r.el.getBoundingClientRect();
      const vl = viewLines.find((l) => Math.abs(l.getBoundingClientRect().top - lb.top) < 2);
      const t = (vl?.textContent ?? "").replace(/ /g, " ");
      texts.push(t);
      const current = near(currentTops, lb.top, lb.height);
      const caret = cursorTop !== undefined && cursorTop >= lb.top - 1 && cursorTop < lb.bottom - 1;
      if (current) props["current-line"] = r.n;
      if (caret) props["caret-line"] = r.n;
      const span = vl?.firstElementChild as HTMLElement | null;
      const sb = span?.getBoundingClientRect();
      const vb = vl?.getBoundingClientRect();
      const textLeft = sb ? sb.left : (vb ? vb.left : lb.right);
      const charWidth = sb && t.length > 0 ? sb.width / t.length : 7;
      editorNode.children.push({
        role: "line", keys: [["number", String(r.n)]],
        props: { number: r.n, text: t, current, caret, breakpoint: near(breakpointTops, lb.top, lb.height) },
        x: lb.left, y: lb.top, w: (vb ? vb.right : lb.right) - lb.left, h: lb.height,
        visible: lb.height > 0, children: [],
        anchors: {
          gutter: { x: (ed.querySelector(".glyph-margin") as HTMLElement | null)
            ? (ed.querySelector(".glyph-margin") as HTMLElement).getBoundingClientRect().left + 8 : lb.left - 8,
            y: lb.top + lb.height / 2 },
          textLeft, charWidth, firstChar: t.length - t.trimStart().length,
          textRight: textLeft + t.length * charWidth, midY: lb.top + lb.height / 2,
        },
      });
    }
    props.text = texts;
    if (rows.length > 0) {
      props["first-visible"] = rows[0].n;
      props["last-visible"] = rows[rows.length - 1].n;
    }
    root.children.push(editorNode);
  }

  // the command palette (quick input)
  const qi = document.querySelector(".quick-input-widget") as HTMLElement | null;
  if (qi && vis(qi)) {
    const input = qi.querySelector(".quick-input-box input") as HTMLInputElement | null;
    const rowsEl = (Array.from(qi.querySelectorAll(".quick-input-list .monaco-list-row")) as HTMLElement[])
      .filter((r) => vis(r));
    const om = node("omnibox", qi, { query: input?.value ?? "", focused: within(qi), count: rowsEl.length });
    for (const r of rowsEl) {
      const label = text(r.querySelector(".label-name") ?? r.querySelector(".monaco-icon-label") ?? r);
      om.children.push(node("option", r, { label, selected: r.classList.contains("focused") },
        [["label", label]]));
    }
    root.children.push(om);
  }

  // an editor's hover card, with its command links
  const hover = (Array.from(document.querySelectorAll(".monaco-hover")) as HTMLElement[]).find((h) => vis(h));
  if (hover) {
    const lines = (Array.from(hover.querySelectorAll(".hover-row, .hover-contents p, .rendered-markdown > *")) as HTMLElement[])
      .map((e) => text(e)).filter((t) => t);
    const hc = node("hover-card", hover, { text: lines.length ? lines : [text(hover)] });
    for (const a of Array.from(hover.querySelectorAll("a")) as HTMLElement[]) {
      if (!vis(a)) continue;
      const label = text(a);
      if (label) hc.children.push(node("hover-link", a, { label }, [["label", label]]));
    }
    root.children.push(hc);
  }

  // a context menu
  const menu = (Array.from(document.querySelectorAll(".context-view .monaco-menu, .monaco-menu-container"))
    .find((m) => vis(m))) as HTMLElement | undefined;
  if (menu) {
    const cm = node("context-menu", menu, { count: 0 });
    for (const it of Array.from(menu.querySelectorAll(".action-item")) as HTMLElement[]) {
      if (!vis(it) || it.classList.contains("disabled") && !it.querySelector(".action-label")) continue;
      const lab = it.querySelector(".action-label");
      const label = text(lab);
      if (!label) continue;
      cm.children.push(node("menu-item", it, {
        label, enabled: !it.classList.contains("disabled"), shortcut: text(it.querySelector(".keybinding")),
      }, [["label", label]]));
    }
    cm.props.count = cm.children.length;
    root.children.push(cm);
  }

  // the webviews on screen: where each is drawn, so the panels inside can be
  // placed in the window's coordinates
  // (each returned as the element itself: WebDriver hands it back as a
  // reference the reader switches into)
  const frames = (Array.from(document.querySelectorAll("iframe.webview")) as HTMLIFrameElement[])
    .filter((f) => vis(f))
    .map((f) => ({ el: f, ...box(f), cl: f.clientLeft, ct: f.clientTop }));
  return { root, frames, focusInWebview: !!(active && active.tagName === "IFRAME") };
}

// --- the surface: one panel's webview --------------------------------------------

// Runs IN A PANEL'S CONTENT FRAME (the document `vscode_panel.js` mounted, the
// same views the desktop renders). Reads only. Coordinates are the frame's;
// the caller moves them into the window's.
function readPanel(): any {
  const vis = (el: Element | null): boolean => {
    if (!el) return false;
    const r = (el as HTMLElement).getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    if (r.bottom <= 0 || r.top >= window.innerHeight) return false;
    const cs = getComputedStyle(el as HTMLElement);
    return cs.visibility !== "hidden" && cs.display !== "none";
  };
  const box = (el: Element) => {
    const r = (el as HTMLElement).getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  };
  const text = (el: Element | null | undefined) =>
    ((el?.textContent ?? "").replace(/ /g, " ").replace(/\s+/g, " ").trim());
  const node = (role: string, el: Element | null, props: Record<string, unknown>,
                keys: Array<[string, string]> = []): any => {
    const b = el ? box(el) : { x: 0, y: 0, w: 0, h: 0 };
    return { role, keys, props, ...b, visible: el ? vis(el) : false, children: [] };
  };
  const body = document.body;
  const panel = body?.dataset.ctPanel ?? "";
  const focused = document.hasFocus();
  const whole = { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight };
  const out: any[] = [];

  if (panel === "calltrace") {
    const scroller = document.querySelector(".local-calltrace-view") ?? body;
    const ct = node("call-trace", scroller, { count: 0, focused });
    // A row: `.call-text` "name #index", `.call-args` "(a=1, b=2)"; selected,
    // the row is `.event-selected` (views/isonim_calltrace_view.nim).
    for (const el of Array.from(document.querySelectorAll('.call-text[id^="local-call-text-"]')) as HTMLElement[]) {
      const row = (el.closest(".calltrace-call-line") as HTMLElement | null) ?? el;
      if (!vis(el)) continue;
      const name = text(el).replace(/\s*#\d+\s*$/, "").trim();
      const args = text(row.querySelector(".call-args"));
      ct.children.push(node("call", el, { name, arguments: args,
        selected: row.classList.contains("event-selected") }, [["name", name], ["arguments", args]]));
    }
    ct.props.count = ct.children.length;
    out.push(ct);
  } else if (panel === "eventLog") {
    const scroller = document.querySelector(".eventLog-scroll-body") ?? body;
    const rows = Array.from(document.querySelectorAll(".eventLog-rows tbody tr[data-position]")) as HTMLElement[];
    const num = (sel: string) => {
      const v = parseInt((document.querySelector(sel)?.textContent ?? "").replace(/[^\d]/g, ""), 10);
      return Number.isFinite(v) ? v : 0;
    };
    const el = node("event-log", scroller, {
      count: 0, total: num(".data-tables-footer-rows-count"),
      "last-shown": num(".data-tables-footer-end-row"), focused,
    });
    for (const r of rows) {
      if (!vis(r)) continue;
      // the row's output cell (`.eventLog-text`) and its kind
      // (views/isonim_event_log_view.nim)
      const t = text(r.querySelector(".eventLog-text") ?? r);
      el.children.push(node("event", r, { text: t, kind: text(r.querySelector(".eventLog-event")) },
        [["text", t]]));
    }
    // Cross-process boundaries: a marker row per boundary, its chip the
    // part a user clicks.
    for (const m of Array.from(document.querySelectorAll("div.event-log-marker-rows div.marker-row[data-boundary-id]")) as HTMLElement[]) {
      if (!vis(m)) continue;
      const boundary = m.getAttribute("data-boundary-id") ?? "";
      const chip = m.querySelector("span.marker-boundary-chip");
      el.children.push(node("event-marker", chip ?? m, {
        boundary, chip: text(chip), "key-value": m.getAttribute("data-key-value") ?? "",
        direction: !!m.querySelector("span.marker-direction-icon"),
      }, [["boundary", boundary]]));
    }
    el.props.count = el.children.length;
    out.push(el);
  } else if (panel === "scratchpad") {
    const sp = node("scratchpad", body, { count: 0 });
    Object.assign(sp, whole);
    for (const v of Array.from(document.querySelectorAll(".scratchpad-value-view")) as HTMLElement[]) {
      if (!v.querySelector("#close-element")) continue;
      const expression = text(v.querySelector(".value-name")).replace(/:\s*$/, "").trim();
      sp.children.push(node("scratch-entry", v, {
        expression, value: text(v.querySelector(".value-view")),
        error: v.classList.contains("scratchpad-value-error"),
      }, [["expression", expression]]));
    }
    sp.props.count = sp.children.length;
    out.push(sp);
  } else if (panel === "requestPanel") {
    const view = document.querySelector(".component-container.request-panel");
    const rq = node("requests", view ?? body, {
      count: document.querySelectorAll(".request-table-body .request-row, .request-table-body tr").length,
      header: !!document.querySelector(".request-table-header"),
      body: !!document.querySelector(".request-table-body"),
    });
    out.push(rq);
  } else if (panel === "state") {
    const stComp = document.querySelector("div[id^='stateComponent']") ?? body;
    const vs = node("variables", stComp, { count: 0, focused });
    for (const r of Array.from(stComp.querySelectorAll("[data-variable-name]")) as HTMLElement[]) {
      if (!vis(r)) continue;
      const name = r.getAttribute("data-variable-name") ?? "";
      vs.children.push(node("variable", r, {
        name, value: text(r.querySelector(".value-expanded-text, .value-text, .value") ?? r),
        "origin-badge": !!r.querySelector("button.ct-origin-badge"),
      }, [["name", name]]));
    }
    vs.props.count = vs.children.length;
    out.push(vs);
    // The Origin Chain: the side panel the State panel opens over itself, or
    // the chain drawn inside a variable's row.
    const side = document.querySelector("aside#ct-origin-chain-side-panel");
    const sideHops = side ? Array.from(side.querySelectorAll("section > ol > li:not(.ct-origin-terminator-row)")) : [];
    const inline = Array.from(document.querySelectorAll(".ct-origin-inline-chain-hop"));
    const hops = (sideHops.length > 0 ? sideHops : inline) as HTMLElement[];
    const term = sideHops.length > 0
      ? side!.querySelector(".ct-origin-terminator-row")
      : document.querySelector(".ct-origin-inline-chain-terminator");
    const host = sideHops.length > 0 ? side : document.querySelector(".ct-origin-inline-chain");
    if (host && vis(host)) {
      const oc = node("origin-chain", host, { count: hops.length, terminator: text(term) });
      hops.forEach((h, i) => {
        const conf = h.getAttribute("data-origin-confidence");
        const line = h.getAttribute("data-origin-line");
        const cls = h.getAttribute("data-origin-classification") ?? h.getAttribute("data-classification") ?? "";
        const details = h.querySelector("details") as HTMLDetailsElement | null;
        const summary = (details?.querySelector("summary") ?? null) as HTMLElement | null;
        const hop = node("origin-hop", (h.querySelector("button") as HTMLElement | null) ?? h, {
          number: i + 1, text: text(h), classification: cls,
          confidence: conf === null ? 0 : Number(conf), line: line === null ? 0 : Number(line),
          "frame-transition": cls === "FrameTransition" || h.classList.contains("ct-origin-frame-transition")
            || !!h.querySelector(".ct-origin-frame-transition"),
          operands: details && details.open ? details.querySelectorAll(":scope > div, li").length : 0,
        }, [["number", String(i + 1)]]);
        if (summary && vis(summary)) {
          const sb = summary.getBoundingClientRect();
          hop.anchors = { expander: { x: sb.left + Math.min(8, sb.width / 2), y: sb.top + sb.height / 2 } };
        }
        oc.children.push(hop);
      });
      out.push(oc);
    }
  }
  return { panel, nodes: out };
}

function shift(n: Node, dx: number, dy: number): void {
  n.x += dx;
  n.y += dy;
  const a: any = n.anchors;
  if (a) {
    for (const v of Object.values(a)) {
      if (v && typeof v === "object" && "x" in (v as any)) {
        (v as any).x += dx;
        (v as any).y += dy;
      }
    }
  }
  for (const c of n.children) shift(c, dx, dy);
}

const ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";
const refOf = (e: any): string => e?.elementId ?? e?.[ELEMENT_KEY] ?? "";
const asRef = (id: string) => ({ [ELEMENT_KEY]: id });

/** Per webview (its host frame's element id): the content frame inside it and
 *  where it sits, found once (a webview keeps its content frame). */
const contentFrames = new Map<string, { ref: string; x: number; y: number }>();

async function enterContentFrame(b: any, host: string): Promise<{ x: number; y: number } | undefined> {
  await b.switchToFrame(asRef(host));
  const known = contentFrames.get(host);
  if (known) {
    try {
      await b.switchToFrame(asRef(known.ref));
      return known;
    } catch {
      contentFrames.delete(host);
      await b.switchToFrame(null);
      await b.switchToFrame(asRef(host));
    }
  }
  const found: any = await b.execute(() => {
    const a = document.getElementById("active-frame") as HTMLIFrameElement | null;
    if (!a) return null;
    const r = a.getBoundingClientRect();
    return { el: a, x: r.left + a.clientLeft, y: r.top + a.clientTop };
  });
  if (!found) return undefined;
  const entry = { ref: refOf(found.el), x: found.x, y: found.y };
  await b.switchToFrame(asRef(entry.ref));
  contentFrames.set(host, entry);
  return entry;
}

async function readSurface(ctx: Ctx): Promise<Node> {
  const b = ctx.browser;
  await b.switchToFrame(null);
  const T0 = Date.now();
  const top: any = await b.execute(readWorkbench);
  const root: Node = top.root;
  const T1 = Date.now();
  // The panels: each visible webview, its content frame inside it.
  for (const f of top.frames) {
    const host = refOf(f.el);
    if (!host) continue;
    try {
      const inner = await enterContentFrame(b, host);
      if (!inner) continue;
      const got: any = await b.execute(readPanel);
      for (const n of got.nodes as Node[]) {
        shift(n, f.x + f.cl + inner.x, f.y + f.ct + inner.y);
        root.children.push(n);
      }
    } catch {
      // a webview that went away between the two reads: the next read has it
    } finally {
      await b.switchToFrame(null);
    }
  }
  if (process.env.CT_SCENARIO_TIMING) console.error(`[surface] workbench ${T1 - T0} ms, panels ${Date.now() - T1} ms`);
  return root;
}

// --- launch: VS Code through its WebDriver service -----------------------------

/** A user-settings file for the run's VS Code: nothing it shows changes by itself. */
const USER_SETTINGS: Record<string, unknown> = {
  "workbench.startupEditor": "none",
  "workbench.tips.enabled": false,
  "workbench.enableExperiments": false,
  "telemetry.telemetryLevel": "off",
  "update.mode": "none",
  "extensions.autoUpdate": false,
  "extensions.ignoreRecommendations": true,
  "window.titleBarStyle": "custom",
  "window.menuStyle": "custom",
  "window.restoreWindows": "none",
  "editor.quickSuggestions": { other: false, comments: false, strings: false },
  "editor.suggestOnTriggerCharacters": false,
  "editor.wordBasedSuggestions": "off",
  "editor.parameterHints.enabled": false,
  "editor.hover.delay": 300,
  "editor.minimap.enabled": false,
  "editor.cursorBlinking": "solid",
  "editor.smoothScrolling": false,
  "workbench.list.smoothScrolling": false,
  "chat.disableAIFeatures": true,
  "debug.openDebug": "neverOpen",
  "debug.toolBarLocation": "floating",
  "debug.focusWindowOnBreak": false,
  "workbench.editor.untitled.labelFormat": "name",
  "workbench.editor.untitled.hint": "hidden",
  "editor.autoClosingBrackets": "never",
  "editor.autoClosingQuotes": "never",
  "security.workspace.trust.enabled": false,
  "files.hotExit": "off",
  "window.customMenuBarAltFocus": false,
  "git.enabled": false,
  // The extension's debugger names the languages VS Code lets a user set a
  // breakpoint in (package.json `contributes.debuggers[].languages`), and
  // Python, JavaScript and C are not among them: without this a user's F9 in
  // a recording's Python source does nothing.
  "debug.allowBreakpointsEverywhere": true,
  "git.openRepositoryInParentFolders": "never",
  "workbench.secondarySideBar.defaultVisibility": "hidden",
  "debug.internalConsoleOptions": "neverOpen",
  // every tab on screen, however many panels are open
  "workbench.editor.wrapTabs": true,
  "window.newWindowDimensions": "fullscreen",
};

function chromedriverBinary(): string | undefined {
  if (process.env.CHROMEDRIVER_PATH) return process.env.CHROMEDRIVER_PATH;
  const r = spawnSync("bash", ["-c", "command -v chromedriver"], { encoding: "utf-8" });
  return r.status === 0 ? r.stdout.trim() : undefined;
}

/** VS Code's Electron binary from the dev shell (Insiders, see flake.nix), or
 *  the channel wdio-vscode-service downloads. */
function vscodeChannel(): { version: string; binary?: string } {
  const v = process.env.WDIO_VSCODE_VERSION?.trim();
  if (v) return { version: v };
  // The Electron executable itself (the `bin/` entry is VS Code's CLI, which
  // starts the application detached and exits).
  for (const p of [process.env.VSCODE_INSIDERS_EXECUTABLE, process.env.VSCODE_INSIDERS_PATH]) {
    if (p && fs.existsSync(p)) return { version: "insiders", binary: p };
  }
  return { version: "stable" };
}

export interface VSCodeLaunch {
  width?: number;
  height?: number;
  workspace?: string;
  storage?: string;
}

let pending: VSCodeLaunch = {};

/** VS Code with this extension, through its WebDriver service: the service's
 *  launcher resolves VS Code (the dev shell's, or a download) and its
 *  ChromeDriver version, its worker turns the `vscode` capability into the
 *  Chromium one that starts VS Code on the extension, and adds the
 *  `executeWorkbench` command the stages use. */
export async function launch(opts: { width?: number; height?: number }): Promise<WebdriverIO.Browser> {
  const wdioLogger: any = (await import("@wdio/logger")).default;
  wdioLogger.setLogLevelsConfig({}, "error");
  const service: any = await import("wdio-vscode-service");
  const want = { ...pending, ...opts };
  const storage = want.storage ?? fs.mkdtempSync(path.join("/tmp", "ct-vsc-"));
  const workspace = want.workspace ?? path.join(storage, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  const channel = vscodeChannel();
  const driver = chromedriverBinary();
  // The versions the launcher would fetch, when they are known here: the
  // dev shell's VS Code and its ChromeDriver (nothing is downloaded then).
  const cachePath = path.join(storage, "service-cache");
  fs.mkdirSync(cachePath, { recursive: true });
  if (channel.binary && driver) {
    const major = /(\d+)\./.exec(spawnSync(driver, ["--version"], { encoding: "utf-8" }).stdout ?? "")?.[1];
    if (major) {
      fs.writeFileSync(path.join(cachePath, "versions.txt"),
        JSON.stringify({ [channel.version]: { vscode: channel.version, chromedriver: major } }));
    }
  }
  const caps: any = {
    browserName: "vscode",
    browserVersion: channel.version,
    "wdio:enforceWebDriverClassic": true,
    ...(driver ? { "wdio:chromedriverOptions": { binary: driver } } : {}),
    "wdio:vscodeOptions": {
      ...(channel.binary ? { binary: channel.binary } : {}),
      extensionPath: extRoot,
      workspacePath: workspace,
      storagePath: storage,
      userSettings: USER_SETTINGS,
      vscodeProxyOptions: { connectionTimeout: 120_000, commandTimeout: 120_000 },
      vscodeArgs: {
        disableExtensions: false,
        disableTelemetry: true,
        enableProposedApi: "metacraft-labs.ct-vscode",
        noZygote: true,
        disableDevShmUsage: true,
        disableGpu: true,
        disableGpuCompositing: true,
      },
    },
  };
  await new service.launcher({ cachePath }).onPrepare({}, [caps]);
  const worker = new service.default({}, caps);
  await worker.beforeSession({}, caps);
  const browser: any = await remote({
    logLevel: "error",
    connectionRetryTimeout: 180_000,
    connectionRetryCount: 1,
    capabilities: caps,
  } as any);
  // The service's page objects reach the session through WebDriverIO's
  // global `browser`, as they do in a test runner.
  (globalThis as any).browser = browser;
  await worker.before(caps, [], browser);
  // The service rejects its pending proxy calls when VS Code closes the
  // proxy's socket, which it does as the run ends.
  if (!(globalThis as any).__ctVscodeSocketGuard) {
    (globalThis as any).__ctVscodeSocketGuard = true;
    process.on("unhandledRejection", (e: any) => {
      if (/^Connection closed/.test(String(e?.message ?? e))) return;
      console.error(e);
      process.exit(70);
    });
  }
  return browser;
}

// --- the stages ------------------------------------------------------------------

/** The panels a scenario can ask `open-recording` to open: the pack's role
 *  (or its pane name) → the extension's command and its tab's title. */
const PANES: Record<string, { command: string; kind: string; title: string }> = {
  "call-trace": { command: "ct-vscode.openCalltrace", kind: "calltrace", title: "Calltrace" },
  "event-log": { command: "ct-vscode.openEventLog", kind: "eventLog", title: "Event Log" },
  variables: { command: "ct-vscode.openState", kind: "state", title: "State" },
  state: { command: "ct-vscode.openState", kind: "state", title: "State" },
  scratchpad: { command: "ct-vscode.openScratchpad", kind: "scratchpad", title: "Scratchpad" },
  requests: { command: "ct-vscode.openRequests", kind: "requestPanel", title: "Requests" },
  "terminal-output": { command: "ct-vscode.openTerminalOutput", kind: "terminalOutput", title: "Terminal" },
};

async function waitFor<T>(what: string, f: () => Promise<T | undefined | false>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const v = await f();
      if (v) return v as T;
    } catch (e) {
      last = e;
    }
    if (Date.now() > deadline) {
      throw new Error(`${what} (waited ${timeoutMs / 1000}s)${last ? `: ${String((last as any)?.message ?? last)}` : ""}`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** The trace folder's replay worker, when it is an rr recording. */
function rrWorker(): string | undefined {
  return [process.env.CODETRACER_RR_WORKER_PATH, process.env.CT_RR_WORKER_PATH,
    path.resolve(extRoot, "..", "codetracer-native-backend", "target", "debug", "ct-native-replay")]
    .find((p) => p && fs.existsSync(p));
}

async function openRecording(ctx: Ctx, launched: any, args: Record<string, unknown>): Promise<void> {
  // The extension finds `ct` and the replay server on PATH, and the session's
  // CodeTracer state is the run's own (the stage's homes).
  for (const [k, v] of Object.entries(launched.env ?? {})) process.env[k] = String(v);
  for (const k of ["CODETRACER_TRACE_ID", "CODETRACER_RECORDING_ID", "CODETRACER_CALLER_PID"]) delete process.env[k];
  process.env.CODETRACER_IN_UI_TEST = "1";
  const ctBin = process.env.CT_BIN ?? path.join(ctRoot, "src", "build-debug", "bin", "ct");
  if (fs.existsSync(ctBin)) process.env.PATH = `${path.dirname(ctBin)}:${process.env.PATH}`;
  const root: string = launched.root ?? fs.mkdtempSync(path.join(os.tmpdir(), "ct-vsc-"));
  // A short storage path: VS Code's IPC sockets live under it (108-byte limit).
  pending = {
    width: launched.width || undefined, height: launched.height || undefined,
    storage: fs.mkdtempSync(path.join("/tmp", "ct-vsc-")),
    workspace: launched.workDir && fs.existsSync(launched.workDir) && launched.project ? launched.workDir
      : path.join(root, "workspace"),
  };
  ctx.state.storage = pending.storage;
  const phase = (what: string) => {
    if (process.env.CT_SCENARIO_TIMING) console.error(`[stage] ${what} at ${Date.now() - t0} ms`);
  };
  const t0 = Date.now();
  const b = await launch({});
  ctx.browser = b;
  phase("VS Code up");
  await waitFor("the workbench did not draw", async () => (await b.$(".monaco-workbench")).isExisting(), 120_000);

  const folder: string = launched.recording;
  const isRr = fs.existsSync(path.join(folder, "rr"));
  await waitFor("the extension did not activate", () => b.executeWorkbench(async (vscode: any) => {
    const ext = vscode.extensions.getExtension("metacraft-labs.ct-vscode");
    if (!ext) return false;
    if (!ext.isActive) await ext.activate();
    return (await vscode.commands.getCommands(true)).includes("ct-vscode.openCalltrace");
  }), 60_000);
  const started = await b.executeWorkbench(async (vscode: any, f: string, cwd: string, worker: string | undefined) => {
    const config: any = { type: "codetracer-debug", request: "launch", name: "Scenario", program: "main", cwd, traceFolder: f };
    if (worker) {
      config.ctRRWorkerExe = worker;
      config.rawDiffIndex = null;
      config.restoreLocation = null;
    }
    return await vscode.debug.startDebugging(undefined, config);
  }, folder, path.dirname(folder), isRr ? rrWorker() : undefined);
  if (!started) throw new Error(`open-recording: VS Code did not start a CodeTracer session on ${folder}`);
  phase("session started");
  // The session is up when the replay answers and its stop is on screen.
  await waitFor("the replay did not stop at the recording's entry", () => b.executeWorkbench(async (vscode: any) => {
    const s = vscode.debug.activeDebugSession;
    if (!s) return false;
    const t = await s.customRequest("threads");
    return Array.isArray(t?.threads) && t.threads.length > 0 && !!vscode.window.activeTextEditor;
  }), 120_000);

  // The source the session stopped in, in front of the first group. (The
  // extension also opens the recording's copy of the source, which can land
  // in front of the one the stop is drawn in.)
  const showStop = () => b.executeWorkbench(async (vscode: any) => {
    const s = vscode.debug.activeDebugSession;
    const threads = await s.customRequest("threads");
    const trace = await s.customRequest("stackTrace", { threadId: threads.threads[0].id, startFrame: 0, levels: 1 });
    const file = trace?.stackFrames?.[0]?.source?.path;
    if (!file) return;
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false, viewColumn: 1 });
  });
  await showStop();
  phase("replay stopped");
  // The panels the scenario names, beside the source (VS Code's second editor
  // group), the last named in front: a user's side-by-side layout.
  const panes = String(args.panes ?? "").split(",").map((s) => s.trim()).filter((s) => s);
  for (const p of panes) {
    const pane = PANES[p];
    if (!pane) throw new Error(`open-recording: VS Code has no panel for pane '${p}' (${Object.keys(PANES).join(", ")})`);
    await b.executeWorkbench(async (vscode: any, cmd: string, title: string) => {
      await vscode.commands.executeCommand(cmd);
      const where = vscode.window.tabGroups.all.find((g: any) => g.tabs.some((t: any) => t.label === title));
      const tab = where?.tabs.find((t: any) => t.label === title);
      if (where && where.viewColumn === 1) {
        // the panel to the group on the right (made when there is none)
        if (!tab.isActive || !where.isActive) await vscode.commands.executeCommand(cmd);
        await vscode.commands.executeCommand("workbench.action.moveEditorToRightGroup");
      }
    }, pane.command, pane.title);
  }
  phase("panes open");
  // the keyboard in the source, where a user starts
  await showStop();
  await waitFor("the stop is not drawn in an editor", () => binding.condition(ctx, "replay-idle"), 60_000);
}

// --- the binding ------------------------------------------------------------------

/** The CodeTracer operations the extension performs, by the command that does. */
const OPERATIONS: Record<string, string> = {
  "variables.show-value-origin": "ct-vscode.showValueOrigin",
  "editor.jump-to-value-origin": "ct-vscode.showValueOrigin",
  "scratchpad.add-value": "ct-vscode.addToScratchpad",
  "history.back": "ct-vscode.historyBack",
  "history.forward": "ct-vscode.historyForward",
};

/** VS Code's key spelling (`ctrl+shift+o`, `cmd+k cmd+t`) in the format's. */
function formatChord(key: string): string {
  const mod: Record<string, string> = { ctrl: "Ctrl", shift: "Shift", alt: "Alt", cmd: "Meta", meta: "Meta", win: "Meta" };
  const named: Record<string, string> = { enter: "Enter", escape: "Esc", tab: "Tab", backspace: "Backspace",
    delete: "Delete", home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown", up: "Up", down: "Down",
    left: "Left", right: "Right", space: "Space", insert: "Insert" };
  return key.trim().split(/\s+/).map((c) => c.split("+").map((p) => {
    const l = p.toLowerCase();
    if (mod[l]) return mod[l];
    if (named[l]) return named[l];
    if (/^f\d{1,2}$/.test(l)) return l.toUpperCase();
    return l;
  }).join("+")).join(" ");
}

function killTree(pid: number): void {
  const r = spawnSync("pgrep", ["-P", String(pid)], { encoding: "utf-8" });
  for (const c of (r.stdout ?? "").split("\n").filter((x) => x.trim())) killTree(parseInt(c, 10));
  try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
}

const binding = {
  name: "codetracer-vscode",
  roles: ROLES,
  unit: 1,

  async stage(ctx: Ctx, use: string, args: Record<string, unknown>): Promise<void> {
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args)) if (!k.startsWith("$")) clean[k] = v;
    // A program named relative to this repository (its test programs), else
    // as the stage resolves it (codetracer's test programs and fixtures). The
    // stage takes a program relative to the codetracer checkout, so this
    // repository's is named from there.
    if (use === "record-program" && typeof clean.program === "string" && !path.isAbsolute(clean.program)) {
      const own = path.join(extRoot, clean.program);
      if (fs.existsSync(own)) clean.program = path.relative(ctRoot, own);
    }
    if (!ctx.state.file) {
      ctx.state.file = path.join(os.tmpdir(), `ct-scenario-vsc-${process.pid}-${Date.now()}.json`);
      const init = runStageCli(["init", ctx.state.file]);
      ctx.state.root = init.root;
    }
    const launched = runStageCli(["run", ctx.state.file, use, JSON.stringify(clean)]);
    if (use === "open-recording") await openRecording(ctx, launched, clean);
    else if (use === "open-project") {
      throw new Error("open-project: the VS Code binding opens recordings only");
    }
  },

  async surface(ctx: Ctx): Promise<Node> {
    return await readSurface(ctx);
  },

  async condition(ctx: Ctx, name: string): Promise<boolean | undefined> {
    if (name === "replay-idle") {
      // Stopped, and the stop on screen: the debug toolbar offers Continue
      // (not Pause) and an editor draws the execution pointer.
      const b = ctx.browser;
      await b.switchToFrame(null);
      return await b.execute(() => {
        const bar = document.querySelector(".debug-toolbar");
        if (!bar) return false;
        const paused = !!bar.querySelector(".codicon-debug-continue");
        const pointer = !!document.querySelector(".debug-top-stack-frame-line, .codicon-debug-stackframe");
        const busy = !!document.querySelector(".debug-toolbar .codicon-debug-pause");
        return paused && pointer && !busy;
      });
    }
    return undefined;
  },

  async resolveChord(_ctx: Ctx, operation: string): Promise<string | null> {
    const command = OPERATIONS[operation];
    if (!command) return null;
    const pkg = JSON.parse(fs.readFileSync(path.join(extRoot, "package.json"), "utf-8"));
    const kb = (pkg.contributes?.keybindings ?? []).find((k: any) => k.command === command);
    if (!kb) return null;
    const key = process.platform === "darwin" ? (kb.mac ?? kb.key)
      : process.platform === "win32" ? (kb.win ?? kb.key) : (kb.linux ?? kb.key);
    return key ? formatChord(key) : null;
  },

  async anchor(_ctx: Ctx, n: any, anchor: string): Promise<{ x: number; y: number } | undefined> {
    const a = n.anchors;
    if (!a) return undefined;
    if (anchor === "gutter") return a.gutter;
    if (anchor === "expander") return a.expander;
    // the caret goes to the nearer edge of a character: a point in its first
    // third puts it before the character
    if (anchor === "text-start") return { x: a.textLeft + (a.firstChar + 0.3) * a.charWidth, y: a.midY };
    if (anchor === "text-end") return { x: a.textRight - a.charWidth / 2, y: a.midY };
    const col = /^column\((\d+)\)$/.exec(anchor);
    if (col) return { x: a.textLeft + (parseInt(col[1], 10) - 0.5) * a.charWidth, y: a.midY };
    return undefined;
  },

  async close(ctx: Ctx): Promise<void> {
    // The arm ended the WebDriver session; VS Code's processes and the replay
    // servers the extension started go with the run.
    const storage: string | undefined = ctx.state.storage;
    if (storage) {
      const r = spawnSync("pgrep", ["-f", storage], { encoding: "utf-8" });
      for (const p of (r.stdout ?? "").split("\n").filter((x) => x.trim())) killTree(parseInt(p, 10));
      fs.rmSync(storage, { recursive: true, force: true });
      ctx.state.storage = undefined;
    }
    const file = ctx.state.file;
    if (file && !ctx.state.cleanupArmed) {
      ctx.state.cleanupArmed = true;
      process.on("exit", () => {
        try { spawnSync(stageCli(), ["remove", file]); } catch { /* best effort */ }
      });
    }
  },
};

export default binding;
