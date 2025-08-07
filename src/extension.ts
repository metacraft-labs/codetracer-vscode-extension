import * as vscode from "vscode";
import { initPanels, disposePanels, disposeCommands } from "./initPanels";
import * as utils from "./utils";
import * as os from "os";
import * as fs from "fs";
import {
  DapVsCodeApi,
  setupVsCodeExtensionViewsApi,
  newDapVsCodeApi,
  setupMiddlewareApis,
  ctSourceLineJump,
  ctAddToScratchpad,
  CtJumpBehaviour,
  getRecentTraces,
  getRecentTransactions,
  getTransactionTrace,
  getCurrentTrace,
  TraceInfo,
  TransactionInfo,
  MediatorWithSubscribers,
} from "./ct_vscode.js";

let ctStarted = false;

enum LoadMode {
  Trace = "trace",
  Tx = "tx",
  File = "file",
  None = "none"
}

async function runCurrent(codetracerExe: string, isNixOS: boolean): Promise<string | undefined> {
  const trace: TraceInfo | undefined = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Preparing trace file...",
      cancellable: false,
    },
    async () => {
      if (vscode.window.activeTextEditor) {
        let workDir = vscode.window.activeTextEditor.document.uri.fsPath
        return await getCurrentTrace(codetracerExe, workDir, isNixOS);
      }
      else {
        vscode.window.showErrorMessage("No active text editor!")
      }
    }
  );

  return trace?.outputFolder
}

async function pickTraceFolder(codetracerExe: string, isNixOS: boolean): Promise<string | undefined> {
  const recentTraces: TraceInfo[] | undefined = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Loading recent traces...",
      cancellable: false,
    },
    async () => {
      return await getRecentTraces(codetracerExe, isNixOS);
    }
  );
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

async function pickTxFolder(codetracerExe: string, isNixOS: boolean): Promise<string | undefined> {
  const recentTransactions: TransactionInfo[] | undefined = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Loading recent transactions...",
      cancellable: false,
    },
    async () => {
      return await getRecentTransactions(codetracerExe, isNixOS);
    }
  );

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
    let trace: TraceInfo | undefined = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Loading trace for transaction...",
        cancellable: false,
      },
      async () => {
        return await getTransactionTrace(codetracerExe, picked.txHash, isNixOS);
      }
    );
    return trace?.outputFolder;
  }

  return undefined;
}

async function toggleCt(context: vscode.ExtensionContext, dapVsCodeApi: DapVsCodeApi, viewsApi: MediatorWithSubscribers, codetracerExe: string, loadMode: LoadMode) {
  if (ctStarted) {
    // Stop CT
    ctStarted = false;

    disposePanels();
    disposeCommands();

    if (vscode.debug.activeDebugSession?.type === "codetracer-debug") {
      await vscode.commands.executeCommand("workbench.action.debug.stop");
    }

    // Toggle off context menu functions
    vscode.commands.executeCommand('setContext', 'codetracer:active', false);

  } else {
    // Start CT
    const isNixOS = os.version().includes("NixOS");
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];

    if (!workspaceFolder) {
      vscode.window.showErrorMessage("No workspace folder is open.");
      return;
    }

    // Trace selector
    let selectedFilePromise: Promise<string | undefined> | undefined
    switch(loadMode) {
      case LoadMode.Trace:
        selectedFilePromise = pickTraceFolder(codetracerExe, isNixOS);
        break;
      case LoadMode.Tx:
        selectedFilePromise = pickTxFolder(codetracerExe, isNixOS);
        break;
      case LoadMode.File:
        selectedFilePromise = runCurrent(codetracerExe, isNixOS);
        break;
    }
    const selectedFile = await selectedFilePromise;

    if (!selectedFile) {
      return;
    }

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
  const viewsApi = setupVsCodeExtensionViewsApi(
    "vscode-extension-to-views"
  );
  (vscode.window as any).viewsApi = viewsApi; // easier debugging
  (vscode.window as any).dapVsCodeApi = dapVsCodeApi;

  const config = vscode.workspace.getConfiguration("myExtension");
  let codetracerExe = config.get<string>("codetracerExe");

  // Fallback to env var if user didn't set it
  if (!codetracerExe) {
    codetracerExe = process.env.CODETRACER_EXE;
  }

  // TODO: Look in the $PATH env if it still doesn't have it
  if (!codetracerExe) {
    vscode.window.showErrorMessage("CodeTracer executable path not set in config or $CODETRACER_EXE");
  } else {
    console.log("Using codetracer executable path:", codetracerExe);
  }

  if (codetracerExe) {
    const toggleCT = vscode.commands.registerCommand(
      "ct-vscode.toggleCT",
      async () => toggleCt(context, dapVsCodeApi, viewsApi, codetracerExe, LoadMode.File)
    );

    context.subscriptions.push(toggleCT);

    context.subscriptions.push(vscode.commands.registerCommand(
      "ct-vscode.loadCurrentFile",
      async () => toggleCt(context, dapVsCodeApi, viewsApi, codetracerExe, LoadMode.File)
    ))

    context.subscriptions.push(vscode.commands.registerCommand(
      "ct-vscode.loadRecentTraces",
      async () => toggleCt(context, dapVsCodeApi, viewsApi, codetracerExe, LoadMode.Trace)
    ))

      context.subscriptions.push(vscode.commands.registerCommand(
        "ct-vscode.loadRecentTransactions",
        async () => toggleCt(context, dapVsCodeApi, viewsApi, codetracerExe, LoadMode.Tx)
      ))

      context.subscriptions.push(
        vscode.debug.onDidTerminateDebugSession(async (session) => {
          if (session.type === "codetracer-debug") {
            if (ctStarted) {
              toggleCt(context, dapVsCodeApi, viewsApi, codetracerExe, LoadMode.None);
            }
          }
        })
      );
  }

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      "codetracer-sidebar-panel",
      new utils.CodeTracerViewProvider(context)
    )
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

  context.subscriptions.push(
    vscode.commands.registerCommand("ct-vscode.addToScratchpad", () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage("No active editor!");
        return;
      }

      const position = editor.selection.active;
      const wordRange = editor.document.getWordRangeAtPosition(position);
      const expression = wordRange ? editor.document.getText(wordRange) : '';

      vscode.window.showInformationMessage(`Trying to add the variable: ${expression} to the Scratchpad`);
      ctAddToScratchpad(viewsApi, expression)
    })
  )
}

export function deactivate() {
  disposePanels();
  disposeCommands();
}
