import * as vscode from 'vscode';
import { getOrCreatePanel } from './panelManager';
import * as utils from './utils';

export interface CodeTracerPanels {
  state: vscode.WebviewPanel;
  calltrace: vscode.WebviewPanel;
  scratchpad: vscode.WebviewPanel;
  eventLog: vscode.WebviewPanel;
  terminalOutput: vscode.WebviewPanel;
}

interface CodeTracerPanelCommands {
  state: vscode.Disposable;
  calltrace: vscode.Disposable;
  scratchpad: vscode.Disposable;
  eventLog: vscode.Disposable;
  terminalOutput: vscode.Disposable;
}

const idToPanelKey: Record<string, keyof CodeTracerPanels> = {
  openState: 'state',
  openCalltrace: 'calltrace',
  openScratchpad: 'scratchpad',
  openEventLog: 'eventLog',
  openTerminalOutput: 'terminalOutput'
};

const panelMap: Partial<CodeTracerPanels> = {};
const panelCommands: Partial<CodeTracerPanelCommands> = {};

function registerPanelCommand(
  commandId: string,
  context: vscode.ExtensionContext,
  createPanel: (context: vscode.ExtensionContext) => vscode.WebviewPanel
): vscode.Disposable {
  return vscode.commands.registerCommand('ct-vscode.' + commandId, () => {
    const panel = panelMap[idToPanelKey[commandId]] = createPanel(context);
    panel.reveal();
  });
}

function createStatePanel(context: vscode.ExtensionContext): vscode.WebviewPanel {
  return getOrCreatePanel(
    {
      id: 'stateComponent',
      title: 'State',
      getContent: utils.getStateWebviewContent
    },
    context
  )
}

function createCalltracePanel(context: vscode.ExtensionContext): vscode.WebviewPanel {
  return getOrCreatePanel(
    {
      id: 'calltraceComponent',
      title: 'Calltrace',
      getContent: utils.getCalltraceWebviewContent
    },
    context,
    (message, panel) => {
      const command = String.fromCharCode(...message.command);
      if (command === 'calltrace-jump') {
        console.log(message.callKey);
        panel.webview.postMessage({
          command: 'complete-call-move',
          callKey: message.callKey
        });
      }
    }
  )
}

function createScratchpadPanel(context: vscode.ExtensionContext): vscode.WebviewPanel {
  return getOrCreatePanel(
    {
      id: 'scratchpadComponent',
      title: 'Scratchpad',
      getContent: utils.getScratchpadWebviewContent
    },
    context
  )
}

function createEventLogPanel(context: vscode.ExtensionContext): vscode.WebviewPanel {
  return getOrCreatePanel(
    {
      id: 'eventLogComponent',
      title: 'Event Log',
      getContent: utils.getEventLogWebviewContent
    },
    context
  )
}

function createTerminalPanel(context: vscode.ExtensionContext): vscode.WebviewPanel {
  return getOrCreatePanel(
    {
      id: 'terminalOutputComponent',
      title: 'Terminal',
      getContent: utils.getTerminalOutputWebviewContent
    },
    context
  )
}

export function initPanels(context: vscode.ExtensionContext): CodeTracerPanels {
  const state = panelMap.state = createStatePanel(context);
  panelCommands.state = registerPanelCommand('openState', context, createStatePanel);

  const calltrace = panelMap.calltrace = createCalltracePanel(context);
  panelCommands.calltrace = registerPanelCommand('openCalltrace', context, createCalltracePanel);

  const scratchpad = panelMap.scratchpad = createScratchpadPanel(context);
  panelCommands.scratchpad = registerPanelCommand('openScratchpad', context, createScratchpadPanel);

  const eventLog = panelMap.eventLog = createEventLogPanel(context);
  panelCommands.eventLog = registerPanelCommand('openEventLog', context, createEventLogPanel);

  const terminalOutput = panelMap.terminalOutput = createTerminalPanel(context);
  panelCommands.terminalOutput = registerPanelCommand('openTerminalOutput', context, createTerminalPanel);

  setTimeout(() => {
    terminalOutput.reveal();
    vscode.commands.executeCommand('workbench.action.moveEditorToBelowGroup');
    eventLog.reveal();
    vscode.commands.executeCommand('workbench.action.moveEditorToBelowGroup');
    vscode.commands.executeCommand('workbench.action.moveEditorLeftInGroup');
  }, 500);

  setTimeout(() => {
    calltrace.reveal();
    vscode.commands.executeCommand('workbench.action.moveEditorToRightGroup');
  }, 500);

  state.reveal(vscode.ViewColumn.Two);

  return panelMap as CodeTracerPanels;
}

export function disposePanels() {
  console.log("------- BEFORE ------");
  console.log(panelMap);
  for (const key of Object.keys(panelMap) as (keyof CodeTracerPanels)[]) {
    const panel = panelMap[key];
    if (panel) {
      panel.dispose();
    }
    delete panelMap[key];
  }
  console.log("------- AFTER ------");
  console.log(panelMap);
}

export function disposeCommands() {
  for (const key of Object.keys(panelCommands) as (keyof typeof panelCommands)[]) {
    const disposable = panelCommands[key];
    if (disposable) {
      disposable.dispose();
    }
    delete panelCommands[key];
  }
}
