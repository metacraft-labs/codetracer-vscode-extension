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

export function initPanels(
  context: vscode.ExtensionContext,
  viewsApi: any
): CodeTracerPanels {
  const state = (panelMap.state = createStatePanel(context, viewsApi));
  panelCommands.state = registerPanelCommand("openState", context, () =>
    createStatePanel(context, viewsApi)
  );

  const calltrace = (panelMap.calltrace = createCalltracePanel(context, viewsApi));
  panelCommands.calltrace = registerPanelCommand("openCalltrace", context, () =>
    createCalltracePanel(context, viewsApi)
  );

  const scratchpad = (panelMap.scratchpad = createScratchpadPanel(context, viewsApi));
  panelCommands.scratchpad = registerPanelCommand(
    "openScratchpad",
    context,
    () => createScratchpadPanel(context, viewsApi)
  );

  const eventLog = (panelMap.eventLog = createEventLogPanel(context, viewsApi));
  panelCommands.eventLog = registerPanelCommand(
    "openEventLog",
    context,
    () => createEventLogPanel(context, viewsApi)
  );

  const flow = (panelMap.flow);

  const terminalOutput = (panelMap.terminalOutput =
    createTerminalPanel(context, viewsApi));
  panelCommands.terminalOutput = registerPanelCommand(
    "openTerminalOutput",
    context,
    () => createTerminalPanel(context, viewsApi)
  );

  setTimeout(() => {
    terminalOutput.reveal();
    vscode.commands.executeCommand("workbench.action.moveEditorToBelowGroup");
    eventLog.reveal();
    vscode.commands.executeCommand("workbench.action.moveEditorToBelowGroup");
    vscode.commands.executeCommand("workbench.action.moveEditorLeftInGroup");
  }, 500);

  setTimeout(() => {
    calltrace.reveal();
    vscode.commands.executeCommand("workbench.action.moveEditorToRightGroup");
  }, 500);

  state.reveal(vscode.ViewColumn.Two);

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
