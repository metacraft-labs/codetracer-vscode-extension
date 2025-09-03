/// <reference path="../vscode.proposed.editorInsets.d.ts" />
import * as vscode from "vscode";
import { initPanels, disposePanels, disposeCommands, addTracepoint, addLoopPosition } from "./initPanels";
import * as utils from "./utils";
import * as os from "os";
import * as fs from "fs";
import { access, lstat } from "fs/promises";
import {
  DapVsCodeApi,
  setupVsCodeExtensionViewsApi,
  newDapVsCodeApi,
  setupMiddlewareApis,
  ctSourceLineJump,
  ctAddToScratchpad,
  CtJumpBehaviour,
  LoadMode,
  getRecentTraces,
  getRecentTransactions,
  getTransactionTrace,
  getCurrentTrace,
  TraceInfo,
  TransactionInfo,
  MediatorWithSubscribers,
} from "./ct_vscode.js";

const tracepointInsets = new Map<number, vscode.WebviewEditorInset>();
const flowInsets = new Map<number, vscode.WebviewEditorInset>();
let ctStarted = false;
let adapterFactoryDisposable: vscode.Disposable | undefined;

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

    for (const [line, inset] of tracepointInsets) {
      inset.dispose();
      tracepointInsets.delete(line);
    }

    for (const [line, inset] of flowInsets) {
      inset.dispose();
      flowInsets.delete(line);
    }

    adapterFactoryDisposable?.dispose();
    adapterFactoryDisposable = undefined;

    if (vscode.debug.activeDebugSession?.type === "codetracer-debug") {
      await vscode.commands.executeCommand("workbench.action.debug.stop");
    }

    // Toggle off context menu functions
    vscode.commands.executeCommand('setContext', 'codetracer:active', false);

  } else {
    // Start CT
    const isNixOS = os.version().includes("NixOS");

    // Trace selector
    let selectedFilePromise: Promise<string | undefined> | undefined
    switch (loadMode) {
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

    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showInformationMessage("Open a text file first.");
      return;
    }

    const line = editor.selection.active.line;
    const inset = addLoopPosition(context, viewsApi, editor, line - 1)
    flowInsets.set(line, inset);


    const debugConfig = {
      type: "codetracer-debug",
      request: "launch",
      name: "Launch Codetracer",
      cwd: "",
      traceFolder: selectedFile
    };

    const started = await vscode.debug.startDebugging(
      undefined,
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

let commandDisposables: vscode.Disposable[] = [];
let miscDisposables: vscode.Disposable[] = []; // e.g. listeners registered once

export async function isExecutable(p?: string): Promise<boolean> {
  if (!p) return false;
  try {
    const stat = await lstat(p);
    if (!stat.isFile()) {
      return false;
    } else if (p.endsWith(".AppImage")) {
      return true;
    }
    await access(p, fs.constants.X_OK);
    return true;
  }
  catch { return false; }
}

function disposeAll() {
  for (const d of commandDisposables) d.dispose();
  commandDisposables = [];
}

async function reinitCommands(context: vscode.ExtensionContext) {
  disposeAll();

  const cfg = vscode.workspace.getConfiguration('codetracer');
  const codetracerExe = cfg.get<string>('runnablePath')?.trim();
  const valid = await isExecutable(codetracerExe);
  const dapVsCodeApi = newDapVsCodeApi(vscode, context);
  const viewsApi = setupVsCodeExtensionViewsApi(
    "vscode-extension-to-views"
  );
  (vscode.window as any).viewsApi = viewsApi; // easier debugging
  (vscode.window as any).dapVsCodeApi = dapVsCodeApi;

  if (!valid) {
    const action = await vscode.window.showErrorMessage(
      'CodeTracer AppImage path is not set or not executable.',
      'Set Path…', 'Reload Window'
    );
    if (action === 'Set Path…') {
      vscode.commands.executeCommand('workbench.action.openSettings', 'codetracer.runnablePath');
    } else if (action === 'Reload Window') {
      vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  }

  // Set the codetracer executable and the args
  if (!adapterFactoryDisposable) {
    adapterFactoryDisposable = vscode.debug.registerDebugAdapterDescriptorFactory(
      "codetracer-debug",
      new (class implements vscode.DebugAdapterDescriptorFactory {
        async createDebugAdapterDescriptor(session: vscode.DebugSession) {
          if (codetracerExe) {
            const args = ["start_backend", "db", "--stdio"];
            return new vscode.DebugAdapterExecutable(codetracerExe, args, {});
          }
        }
      })
    )
  }

  context.subscriptions.push(adapterFactoryDisposable);

  const register = (id: string, fn: (...a: any[]) => any) =>
    commandDisposables.push(vscode.commands.registerCommand(id, fn));

  const stub = (id: string) =>
    register(id, async () => {
      const action = await vscode.window.showErrorMessage(
        'CodeTracer AppImage path is not set or not executable.',
        'Set Path…', 'Reload Window'
      );
      if (action === 'Set Path…') {
        vscode.commands.executeCommand('workbench.action.openSettings', 'codetracer.runnablePath');
      } else if (action === 'Reload Window') {
        vscode.commands.executeCommand('workbench.action.reloadWindow');
      }
    });

  const exe = codetracerExe!;
  const toggleCtReal = async (mode: LoadMode) =>
    toggleCt(context, dapVsCodeApi, viewsApi, exe, mode);

  if (!valid) {
    // ---- stub (“dunder”) registrations ----
    stub('ct-vscode.toggleCT');
    stub('ct-vscode.loadCurrentFile');
    stub('ct-vscode.loadRecentTraces');
    stub('ct-vscode.loadRecentTransactions');
    stub('ct-vscode.smartSourceLineJump');
    stub('ct-vscode.forwardSourceLineJump');
    stub('ct-vscode.backwardSourceLineJump');
    stub('ct-vscode.addToScratchpad');
    stub('ct-vscode.addTracepoint');
  } else {
    // ---- real registrations ----
    register('ct-vscode.toggleCT', async () => toggleCtReal(LoadMode.Trace));
    register('ct-vscode.loadCurrentFile', async () => toggleCtReal(LoadMode.File));
    register('ct-vscode.loadRecentTraces', async () => toggleCtReal(LoadMode.Trace));
    register('ct-vscode.loadRecentTransactions', async () => toggleCtReal(LoadMode.Tx));

    register('ct-vscode.smartSourceLineJump', () => {
      const ed = vscode.window.activeTextEditor; if (!ed) return;
      ctSourceLineJump(dapVsCodeApi, ed.selection.active.line + 1, ed.document.uri.fsPath, CtJumpBehaviour.SmartJump);
    });
    register('ct-vscode.forwardSourceLineJump', () => {
      const ed = vscode.window.activeTextEditor; if (!ed) return;
      ctSourceLineJump(dapVsCodeApi, ed.selection.active.line + 1, ed.document.uri.fsPath, CtJumpBehaviour.ForwardJump);
    });
    register('ct-vscode.backwardSourceLineJump', () => {
      const ed = vscode.window.activeTextEditor; if (!ed) return;
      ctSourceLineJump(dapVsCodeApi, ed.selection.active.line + 1, ed.document.uri.fsPath, CtJumpBehaviour.BackwardJump);
    });

    register('ct-vscode.addToScratchpad', () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed) { vscode.window.showErrorMessage('No active editor!'); return; }
      const pos = ed.selection.active;
      const word = ed.document.getWordRangeAtPosition(pos);
      const expr = word ? ed.document.getText(word) : '';
      vscode.window.showInformationMessage(`Trying to add the variable: ${expr} to the Scratchpad`);
      ctAddToScratchpad(viewsApi, expr);
    });

    register("ct-vscode.addTracepoint", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showInformationMessage("Open a text file first.");
        return;
      }

      const line = editor.selection.active.line;
      const inset = addTracepoint(context, viewsApi, editor, line)
      tracepointInsets.set(line, inset);
    })
  }

  if (miscDisposables.length === 0) {
    miscDisposables.push(
      vscode.debug.onDidTerminateDebugSession(async (session) => {
        if (session.type === 'codetracer-debug' && ctStarted) {
          await toggleCtReal(LoadMode.None);
        }
      }),
      vscode.window.registerWebviewViewProvider(
        'codetracer-sidebar-panel',
        new utils.CodeTracerViewProvider(context)
      ),
      vscode.workspace.onDidChangeConfiguration(async (e) => {
        if (e.affectsConfiguration('codetracer.runnablePath')) {
          await reinitCommands(context);
        }
      }),
    );
    context.subscriptions.push(...miscDisposables);
  }
}

export async function activate(context: vscode.ExtensionContext) {
  // initial (stub or real)
  await reinitCommands(context);
}

export function deactivate() {
  disposePanels();
  disposeCommands();
  adapterFactoryDisposable?.dispose();
  adapterFactoryDisposable = undefined;
}
