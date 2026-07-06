import * as vscode from "vscode";
import { getOrCreatePanel, createTracepointPanel, createFlowPanel } from "./panelManager";
import * as utils from "./utils";
import { receive, newWebviewSubscriber } from "./ct_vscode";

export interface CodeTracerPanels {
  state: vscode.WebviewPanel;
  calltrace: vscode.WebviewPanel;
  scratchpad: vscode.WebviewPanel;
  eventLog: vscode.WebviewPanel;
  terminalOutput: vscode.WebviewPanel;
  flow: vscode.WebviewPanel;
}

interface CodeTracerPanelCommands {
  state: vscode.Disposable;
  calltrace: vscode.Disposable;
  scratchpad: vscode.Disposable;
  eventLog: vscode.Disposable;
  terminalOutput: vscode.Disposable;
  flow: vscode.Disposable;
}

const idToPanelKey: Record<string, keyof CodeTracerPanels> = {
  openState: "state",
  openCalltrace: "calltrace",
  openScratchpad: "scratchpad",
  openEventLog: "eventLog",
  openTerminalOutput: "terminalOutput",
};

const panelMap: Partial<CodeTracerPanels> = {};
const panelCommands: Partial<CodeTracerPanelCommands> = {};

function registerPanelCommand(
  commandId: string,
  context: vscode.ExtensionContext,
  createPanel: (context: vscode.ExtensionContext) => vscode.WebviewPanel
): vscode.Disposable {
  return vscode.commands.registerCommand("ct-vscode." + commandId, () => {
    const panel = (panelMap[idToPanelKey[commandId]] = createPanel(context));
    ensureValueOriginReplayHook(panel);
    panel.reveal();
    replayLatestValueOriginUpdate(panel);
  });
}

interface CtMessage {
  // command: string;
  kind: any;
  value: any;
  // isDap: boolean;
  // shouldReturnValue: boolean;
}

interface DapMessage {
  command: string;
  value: any;
}

async function handleExtensionPanelMessage(message: any, panel?: vscode.WebviewPanel): Promise<boolean> {
  if (message?.command === "ct-vscode-state-value-origin-ready") {
    if (panel) {
      replayLatestValueOriginUpdate(panel);
    }
    return true;
  }

  if (message?.command === "ct-vscode-dap-request") {
    const requestId = String(message.requestId ?? "");
    const dapCommand = String(message.dapCommand ?? "");
    const session = vscode.debug.activeDebugSession;
    let value: unknown = {};
    if (session?.type === "codetracer-debug" && typeof session.customRequest === "function" && dapCommand) {
      try {
        value = await session.customRequest(dapCommand, message.value ?? {});
      } catch (err) {
        console.warn(`[CodeTracer] ${dapCommand} from webview failed:`, err);
      }
    }
    try {
      await panel?.webview.postMessage({
        command: "ct-vscode-dap-response",
        requestId,
        value,
      });
    } catch (err) {
      console.warn("[CodeTracer] DAP response postMessage failed:", err);
    }
    return true;
  }

  if (message?.command !== "ct-vscode-origin-hop-click") {
    return false;
  }
  const location = message.value?.location;
  const path = typeof location?.path === "string" ? location.path : "";
  const line = Number(location?.line ?? 1);
  if (!path) {
    return true;
  }
  try {
    const doc = await vscode.workspace.openTextDocument(path);
    const editor = await vscode.window.showTextDocument(doc, { preview: true });
    const pos = new vscode.Position(Math.max(0, line - 1), 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos));
  } catch (err) {
    console.warn("[CodeTracer] origin hop click navigation failed:", err);
  }
  return true;
}

function dapRedirect(
  dapMessage: DapMessage,
  shouldReturnValue: boolean,
  panel: any
) { }

/**
 * Snapshot of the embedded CodeTracer webview panels currently mounted in
 * the host workbench. Callers (typically the extension-side command and
 * DAP-event forwarding layers added by M6 of the Value Origin Tracking
 * initiative) use this snapshot to address `panel.webview.postMessage(...)`
 * directly without taking a dependency on the internal `panelMap` symbol.
 */
export function getActivePanels(): Partial<CodeTracerPanels> {
  // Return a shallow copy — callers iterate the result and we do not want
  // them mutating the internal `panelMap` (e.g. by deleting entries).
  return { ...panelMap };
}

// Minimal duck-typed shape of the panels we forward to. Tests install
// a fake panel matching this contract via `_testRegisterPanelOverride`
// so they can observe `postMessage` calls without needing a real
// DAP session, a real CodeTracer binary, or a real webview frame.
export interface PostMessageTarget {
  webview: { postMessage: (message: unknown) => unknown };
}

// Internal map of test-installed panel overrides. Keyed by an opaque
// caller-chosen name so multiple tests can install/uninstall independently.
const panelOverrides: Map<string, PostMessageTarget> = new Map();
const VALUE_ORIGIN_UPDATE_COMMAND = "ct/updated-origin-chain";
let latestValueOriginUpdate: unknown | undefined;
const panelsWithReplayHook = new WeakSet<vscode.WebviewPanel>();

function rememberReplayablePanelMessage(message: unknown): void {
  if ((message as any)?.command === VALUE_ORIGIN_UPDATE_COMMAND) {
    latestValueOriginUpdate = message;
  }
}

function replayLatestValueOriginUpdate(panel: vscode.WebviewPanel): void {
  if (!latestValueOriginUpdate) {
    return;
  }
  for (const delayMs of [0, 250, 1000, 2000, 4000, 6000]) {
    setTimeout(() => {
      try {
        void panel.webview.postMessage(latestValueOriginUpdate);
      } catch (err) {
        console.warn("[CodeTracer] value-origin replay failed:", err);
      }
    }, delayMs);
  }
}

function ensureValueOriginReplayHook(panel: vscode.WebviewPanel): void {
  if (panelsWithReplayHook.has(panel)) {
    return;
  }
  panelsWithReplayHook.add(panel);
  panel.onDidChangeViewState((event) => {
    if (event.webviewPanel.visible) {
      replayLatestValueOriginUpdate(event.webviewPanel);
    }
  });
}

/**
 * Install a fake "panel" that captures `postMessage` calls from
 * `forwardToEmbeddedPanels(...)`. Intended for the M6 verification
 * suite in `test/wdio/specs/value-origin/` — production code never
 * calls this. The caller is responsible for invoking the returned
 * dispose function to remove the override.
 *
 * This test seam is deliberately exposed from the same module that
 * owns `panelMap` (rather than via a globals hack) so its contract is
 * type-checked and the implementation stays internal to `initPanels`.
 */
export function _testRegisterPanelOverride(
  name: string,
  target: PostMessageTarget
): () => void {
  panelOverrides.set(name, target);
  return () => {
    panelOverrides.delete(name);
  };
}

/**
 * Forward an extension → webview post-message to every embedded CodeTracer
 * panel that is currently mounted (State, Calltrace, Scratchpad, Event Log,
 * Terminal Output). The State pane is the primary target for Value Origin
 * Tracking but the Scratchpad and Editor panes also receive origin-related
 * messages (pinned chain diffs, badge updates), so the broadcast keeps the
 * post-message bridge symmetric with the in-Electron event bus and avoids
 * the extension needing to know which sub-pane consumes a given message.
 *
 * Returns the number of panels the message was successfully posted to so
 * callers (and tests) can verify the forwarding actually landed.
 *
 * Spec: `codetracer-specs/GUI/Debugging-Features/Value-Origin-Tracking.md`
 * §8.2 — the extension is the thin command/menu + DAP-event bridge; all
 * rendering lives inside the embedded CodeTracer panels.
 */
export function forwardToEmbeddedPanels(message: unknown): number {
  rememberReplayablePanelMessage(message);
  let delivered = 0;
  for (const key of Object.keys(panelMap) as (keyof CodeTracerPanels)[]) {
    const panel = panelMap[key];
    if (!panel) {
      continue;
    }
    try {
      // `postMessage` returns a Thenable<boolean>; we intentionally
      // fire-and-forget here — failures are logged for diagnostics but must
      // not block the DAP-event loop or the synchronous command handler.
      void panel.webview.postMessage(message);
      delivered += 1;
    } catch (err) {
      console.warn(
        `[CodeTracer] forwardToEmbeddedPanels: post to ${key} panel failed:`,
        err
      );
    }
  }
  // Test-only overrides registered via `_testRegisterPanelOverride`. These
  // are addressed *in addition* to the real panels so a test can still
  // observe the message even when a real DAP session is alive. The map is
  // empty in production builds, so the loop body is a no-op there.
  for (const [name, target] of panelOverrides) {
    try {
      void target.webview.postMessage(message);
      delivered += 1;
    } catch (err) {
      console.warn(
        `[CodeTracer] forwardToEmbeddedPanels: post to test panel "${name}" failed:`,
        err
      );
    }
  }
  return delivered;
}

export function createStatePanel(
  context: vscode.ExtensionContext,
  viewsApi: any
): vscode.WebviewPanel {
  return getOrCreatePanel(
    {
      id: "stateComponent",
      title: "State",
      getContent: utils.getStateWebviewContent,
    },
    context,
    async (message: CtMessage, panel: any) => {
      if (await handleExtensionPanelMessage(message, panel)) {
        return;
      }
      console.log("received from webview: ", message);
      let webviewSubscriber = newWebviewSubscriber(panel.webview);
      receive(viewsApi, message.kind, message.value, webviewSubscriber);
    }
  );
}

function createCalltracePanel(
  context: vscode.ExtensionContext,
  viewsApi: any
): vscode.WebviewPanel {
  return getOrCreatePanel(
    {
      id: "calltraceComponent",
      title: "Calltrace",
      getContent: utils.getCalltraceWebviewContent,
    },
    context,
    async (message: CtMessage, panel: any) => {
      if (await handleExtensionPanelMessage(message, panel)) {
        return;
      }
      console.log("received from webview: ", message);
      let webviewSubscriber = newWebviewSubscriber(panel.webview);
      receive(viewsApi, message.kind, message.value, webviewSubscriber);
    }
  );
}

function createScratchpadPanel(
  context: vscode.ExtensionContext,
  viewsApi: any
): vscode.WebviewPanel {
  return getOrCreatePanel(
    {
      id: "scratchpadComponent",
      title: "Scratchpad",
      getContent: utils.getScratchpadWebviewContent,
    },
    context,
    async (message: CtMessage, panel: any) => {
      if (await handleExtensionPanelMessage(message, panel)) {
        return;
      }
      console.log("received from webview: ", message);
      let webviewSubscriber = newWebviewSubscriber(panel.webview);
      receive(viewsApi, message.kind, message.value, webviewSubscriber);
    }
  );
}

function createEventLogPanel(
  context: vscode.ExtensionContext,
  viewsApi: any
): vscode.WebviewPanel {
  return getOrCreatePanel(
    {
      id: "eventLogComponent",
      title: "Event Log",
      retainContextWhenHidden: true,
      getContent: utils.getEventLogWebviewContent,
    },
    context,
    async (message: CtMessage, panel: any) => {
      if (await handleExtensionPanelMessage(message, panel)) {
        return;
      }
      console.log("received from webview: ", message);
      let webviewSubscriber = newWebviewSubscriber(panel.webview);
      receive(viewsApi, message.kind, message.value, webviewSubscriber);
    }
  );
}

function createTerminalPanel(
  context: vscode.ExtensionContext,
  viewsApi: any
): vscode.WebviewPanel {
  return getOrCreatePanel(
    {
      id: "terminalOutputComponent",
      title: "Terminal",
      getContent: utils.getTerminalOutputWebviewContent,
    },
    context,
    async (message: CtMessage, panel: any) => {
      if (await handleExtensionPanelMessage(message, panel)) {
        return;
      }
      console.log("received from webview: ", message);
      let webviewSubscriber = newWebviewSubscriber(panel.webview);
      receive(viewsApi, message.kind, message.value, webviewSubscriber);
    }
  );
}

export function addLoopPosition(context: vscode.ExtensionContext, viewsApi: any, editor: vscode.TextEditor, line: number): vscode.WebviewEditorInset {
  const inset = createFlowPanel(
    {
      id: "flowComponent",
      title: "flow",
      getFlowContent: utils.getFlowComponent,
    },
    editor,
    line,
    context,
    (message: CtMessage, panel: any) => {
      console.log("received from webview: ", message);
      let webviewSubscriber = newWebviewSubscriber(panel.webview);
      receive(viewsApi, message.kind, message.value, webviewSubscriber);
    }
  );
  return inset;
}

export function addTracepoint(context: vscode.ExtensionContext, viewsApi: any, editor: vscode.TextEditor, line: number): vscode.WebviewEditorInset {
  const inset = createTracepointPanel(
    {
      id: "tracepointComponent",
      title: "tracepoint",
      getTraceContent: utils.getTracepointWebviewContent,
    },
    editor,
    line,
    context,
    (message: CtMessage, panel: any) => {
      console.log("received from webview: ", message);
      let webviewSubscriber = newWebviewSubscriber(panel.webview);
      receive(viewsApi, message.kind, message.value, webviewSubscriber);
    }
  );
  return inset;
}

/** Resolve after `ms` milliseconds — used to pace sequential panel creation. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Initialise the CodeTracer panels.
 *
 * The panels are created **sequentially**, all as tabs of a single editor
 * group, rather than all at once and spread across editor groups. Each
 * CodeTracer webview loads a large (~44 MB) frontend bundle plus a ~14 MB
 * Nim `ui.js`, and `vscode.window.createWebviewPanel` mounts the webview
 * immediately and makes it visible. The previous implementation created
 * all five panels back-to-back and `moveEditor…`'d them across three
 * editor groups, so several heavy webviews mounted and stayed resident
 * concurrently in the VS Code renderer.
 *
 * Two changes minimise the renderer's peak webview load:
 *
 *  1. Panels are created one at a time, with a pause between each so the
 *     renderer finishes mounting (and the previous heavy bundle finishes
 *     parsing) before the next webview starts loading.
 *  2. All panels open in the same editor group (`ViewColumn.Two`). Within
 *     a group only the active tab is visible; combined with
 *     `retainContextWhenHidden: false` (see `panelManager.ts`) every panel
 *     except the active one releases its renderer context, so at most one
 *     copy of the bundle is resident at a time.
 *
 * The grouped layout is also what the WDIO panel checks expect — they
 * assert panel *existence* via the tab-groups API, not a particular split
 * layout.
 */
export async function initPanels(
  context: vscode.ExtensionContext,
  viewsApi: any
): Promise<CodeTracerPanels> {
  // Pause between panel mounts so the renderer fully finishes mounting,
  // running and then *unloading* one webview before the next one starts,
  // keeping the renderer's peak webview memory to a single panel.
  const STEP_MS = 3000;

  const state = (panelMap.state = createStatePanel(context, viewsApi));
  ensureValueOriginReplayHook(state);
  panelCommands.state = registerPanelCommand("openState", context, () =>
    createStatePanel(context, viewsApi)
  );
  state.reveal(vscode.ViewColumn.Two);
  await delay(STEP_MS);

  const calltrace = (panelMap.calltrace = createCalltracePanel(context, viewsApi));
  ensureValueOriginReplayHook(calltrace);
  panelCommands.calltrace = registerPanelCommand("openCalltrace", context, () =>
    createCalltracePanel(context, viewsApi)
  );
  await delay(STEP_MS);

  const scratchpad = (panelMap.scratchpad = createScratchpadPanel(context, viewsApi));
  ensureValueOriginReplayHook(scratchpad);
  panelCommands.scratchpad = registerPanelCommand(
    "openScratchpad",
    context,
    () => createScratchpadPanel(context, viewsApi)
  );
  await delay(STEP_MS);

  const eventLog = (panelMap.eventLog = createEventLogPanel(context, viewsApi));
  ensureValueOriginReplayHook(eventLog);
  panelCommands.eventLog = registerPanelCommand(
    "openEventLog",
    context,
    () => createEventLogPanel(context, viewsApi)
  );
  await delay(STEP_MS);

  const terminalOutput = (panelMap.terminalOutput =
    createTerminalPanel(context, viewsApi));
  ensureValueOriginReplayHook(terminalOutput);
  panelCommands.terminalOutput = registerPanelCommand(
    "openTerminalOutput",
    context,
    () => createTerminalPanel(context, viewsApi)
  );
  await delay(STEP_MS);

  // `flow` is created lazily by `addLoopPosition`; keep the field present.
  void calltrace;
  void scratchpad;
  void eventLog;
  void terminalOutput;

  return panelMap as CodeTracerPanels;
}

export function disposePanels() {
  for (const key of Object.keys(panelMap) as (keyof CodeTracerPanels)[]) {
    const panel = panelMap[key];
    if (panel) {
      panel.dispose();
    }
    delete panelMap[key];
  }
}

export function disposeCommands() {
  for (const key of Object.keys(
    panelCommands
  ) as (keyof typeof panelCommands)[]) {
    const disposable = panelCommands[key];
    if (disposable) {
      disposable.dispose();
    }
    delete panelCommands[key];
  }
}
