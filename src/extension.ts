import * as vscode from "vscode";
import { ChildProcess } from "child_process";
import { initPanels, disposePanels, disposeCommands } from "./initPanels";
import * as utils from "./utils";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import {
  DapVsCodeApi,
  setupVsCodeExtensionViewsApi,
  newDapVsCodeApi,
  setupMiddlewareApis,
  ctSourceLineJump,
  CtJumpBehaviour,
  getRecentTraces,
  getRecentTransactions,
  getTransactionTraceId,
  TraceInfo,
  TransactionInfo,
} from "./ct_vscode.js";

let ctStarted = false;

async function pickTraceFolder(): Promise<string | undefined> {
  const recentTraces: TraceInfo[] | undefined = await getRecentTraces();
  if (!recentTraces || recentTraces.length === 0) {
    vscode.window.showWarningMessage("No recent trace folders found.");
    return;
  }

  const options = recentTraces
    .filter(trace => fs.existsSync(trace.outputFolder))
    .map(trace => {
      const folderName = trace.program;
      return {
        label: folderName,
        description: trace.outputFolder,
        fullPath: trace.outputFolder
      };
    });

  const picked = await vscode.window.showQuickPick(options, {
    placeHolder: "Select a trace folder to use",
    canPickMany: false
  });

  return picked?.fullPath;
}

async function pickTxFolder(): Promise<string | undefined> {
  const recentTransactions: TransactionInfo[] | undefined = await getRecentTransactions();
  if (!recentTransactions || recentTransactions.length === 0) {
    vscode.window.showWarningMessage("No recent transactions found.");
    return;
  }

  const options = recentTransactions
    .map(trace => {
      const folderName = trace.toAddress;
      return {
        label: folderName,
        description: trace.toAddress,
        txHash: trace.txHash
      };
    });

  const picked = await vscode.window.showQuickPick(options, {
    placeHolder: "Select a transaction to use",
    canPickMany: false
  });

  if (picked) {
    let trace = await getTransactionTraceId(picked.txHash);
    return trace?.outputFolder;
  }

  return undefined;
}

async function toggleCt(context: vscode.ExtensionContext, dapVsCodeApi: DapVsCodeApi, loadTx: boolean = false) {
  if (ctStarted) {
    // Stop CT
    ctStarted = false;
    vscode.window.showInformationMessage("CodeTracer stopped.");

    disposePanels();
    disposeCommands();

    if (vscode.debug.activeDebugSession?.type === "codetracer-debug") {
      await vscode.commands.executeCommand("workbench.action.debug.stop");
    }

    // Toggle off context menu functions
    vscode.commands.executeCommand('setContext', 'codetracer:active', false);

  } else {
    // Start CT

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      vscode.window.showErrorMessage("No workspace folder is open.");
      return;
    }

    // Trace selector
    const selectedFile = !loadTx ? await pickTraceFolder() : await pickTxFolder();

    if (!selectedFile) {
      return;
    }

    const viewsApi = setupVsCodeExtensionViewsApi(
      "vscode-extension-to-views"
    );
    (vscode.window as any).viewsApi = viewsApi; // easier debugging
    
    (vscode.window as any).dapVsCodeApi = dapVsCodeApi;

    // Setup middleware
    setupMiddlewareApis(dapVsCodeApi, viewsApi);

    // Initialize panels
    const panels = initPanels(context, viewsApi);
    (vscode.window as any).panels = panels; // easier debugging

    const debugConfig = {
      type: "codetracer-debug",
      request: "launch",
      name: "Launch Codetracer",
      cwd: "",
      traceFolder: selectedFile
    };

    const started = await vscode.debug.startDebugging(
      workspaceFolder,
      debugConfig
    );
    if (!started) {
      vscode.window.showErrorMessage(
        "Failed to start Codetracer debugger."
      );
    }

    ctStarted = true;

    // Toggle on context menu functions
    vscode.commands.executeCommand('setContext', 'codetracer:active', true);

  }
}

export function activate(context: vscode.ExtensionContext) {
  const dapVsCodeApi = newDapVsCodeApi(vscode, context);

  const toggleCT = vscode.commands.registerCommand(
    "ct-vscode.toggleCT",
    async () => toggleCt(context, dapVsCodeApi)
  );

  context.subscriptions.push(toggleCT);

  context.subscriptions.push(vscode.commands.registerCommand(
    "ct-vscode.loadRecentTraces",
    async () => toggleCt(context, dapVsCodeApi)
  ))

  context.subscriptions.push(vscode.commands.registerCommand(
    "ct-vscode.loadRecentTransactions",
    async () => toggleCt(context, dapVsCodeApi, true)
  ))

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      "codetracer-sidebar-panel",
      new utils.CodeTracerViewProvider(context)
    )
  );

  context.subscriptions.push(
    vscode.debug.onDidTerminateDebugSession(async (session) => {
      if (session.type === "codetracer-debug") {
        if (ctStarted) {
          toggleCt(context, dapVsCodeApi);
        }
      }
    })
  );

  // context menu functions setup
  context.subscriptions.push(
    vscode.commands.registerCommand("ct-vscode.smartSourceLineJump", () => {
      const editor = vscode.window.activeTextEditor;

      if (editor == null) return;

      const line = editor.selection.active.line + 1;
      const filePath = editor.document.uri.fsPath;

      ctSourceLineJump(dapVsCodeApi, line, filePath, CtJumpBehaviour.SmartJump)
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("ct-vscode.forwardSourceLineJump", () => {
      const editor = vscode.window.activeTextEditor;

      if (!editor) return;

      const line = editor.selection.active.line + 1;
      const filePath = editor.document.uri.fsPath;

      ctSourceLineJump(dapVsCodeApi, line, filePath, CtJumpBehaviour.ForwardJump);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("ct-vscode.backwardSourceLineJump", () => {
      const editor = vscode.window.activeTextEditor;
      if (editor == null) return;

      const line = editor.selection.active.line + 1;
      const filePath = editor.document.uri.fsPath;

      ctSourceLineJump(dapVsCodeApi, line, filePath, CtJumpBehaviour.BackwardJump)
    })
  );
}

export function deactivate() {
  disposePanels();
  disposeCommands();
}
