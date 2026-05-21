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
    panel.reveal();
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

function dapRedirect(
  dapMessage: DapMessage,
  shouldReturnValue: boolean,
  panel: any
) { }

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
    (message: CtMessage, panel: any) => {
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
    (message: CtMessage, panel: any) => {
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
    (message: CtMessage, panel: any) => {
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
      getContent: utils.getEventLogWebviewContent,
    },
    context,
    (message: CtMessage, panel: any) => {
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
    (message: CtMessage, panel: any) => {
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
  panelCommands.state = registerPanelCommand("openState", context, () =>
    createStatePanel(context, viewsApi)
  );
  state.reveal(vscode.ViewColumn.Two);
  await delay(STEP_MS);

  const calltrace = (panelMap.calltrace = createCalltracePanel(context, viewsApi));
  panelCommands.calltrace = registerPanelCommand("openCalltrace", context, () =>
    createCalltracePanel(context, viewsApi)
  );
  await delay(STEP_MS);

  const scratchpad = (panelMap.scratchpad = createScratchpadPanel(context, viewsApi));
  panelCommands.scratchpad = registerPanelCommand(
    "openScratchpad",
    context,
    () => createScratchpadPanel(context, viewsApi)
  );
  await delay(STEP_MS);

  const eventLog = (panelMap.eventLog = createEventLogPanel(context, viewsApi));
  panelCommands.eventLog = registerPanelCommand(
    "openEventLog",
    context,
    () => createEventLogPanel(context, viewsApi)
  );
  await delay(STEP_MS);

  const terminalOutput = (panelMap.terminalOutput =
    createTerminalPanel(context, viewsApi));
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
