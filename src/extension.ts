import * as vscode from "vscode";
import { ChildProcess } from "child_process";
import { initPanels, disposePanels, disposeCommands } from "./initPanels";
import * as utils from "./utils";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import {
  MediatorWithSubscribers,
  DapVsCodeApi,
  setupVsCodeExtensionViewsApi,
  newDapVsCodeApi,
  setupEditorApi,
  setupMiddlewareApis,
  completeMove,
  vsUpdatedFlow
} from "./ct_vscode.js";

let backendProcess: ChildProcess | null = null;
let ctStarted = false;

async function pickTraceFolder(): Promise<string | undefined> {
  const baseDir = path.join(os.homedir(), '.local', 'share', 'codetracer');
  const folders = fs.readdirSync(baseDir).filter(name =>
    fs.statSync(path.join(baseDir, name)).isDirectory()
  ).reverse(); // Reverse the order (latest last => first)

  const picked = await vscode.window.showQuickPick(folders, {
    placeHolder: 'Select a trace folder to use',
    canPickMany: false
  });

  if (picked) {
    return path.join(baseDir, picked);
  }

  return undefined;
}

async function toggleCt(context: vscode.ExtensionContext) {
  if (ctStarted) {
    // Stop CT
    ctStarted = false;
    vscode.window.showInformationMessage("CodeTracer stopped.");

    disposePanels();
    disposeCommands();

    if (backendProcess) {
      backendProcess.kill();
      backendProcess = null;
    }

    if (vscode.debug.activeDebugSession?.type === "codetracer-debug") {
      await vscode.commands.executeCommand("workbench.action.debug.stop");
    }

  } else {
    // Start CT
    
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      vscode.window.showErrorMessage("No workspace folder is open.");
      return;
    }
    
    // Trace selector
    const selectedFile = await pickTraceFolder()
    if (!selectedFile) {
      vscode.window.showWarningMessage('No trace folder selected.');
      return;
    }

    const viewsApi = setupVsCodeExtensionViewsApi(
      "vscode-extension-to-views"
    );
    (vscode.window as any).viewsApi = viewsApi; // easier debugging
    const dapVsCodeApi = newDapVsCodeApi(vscode, context);
    (vscode.window as any).dapVsCodeApi = dapVsCodeApi;

    // Setup middleware
    // dapVsCodeApi.flowFunction = vsUpdatedFlow;
    // dapVsCodeApi.completeMoveFunction = completeMove;
    // completeMove(vscode.window.activeTextEditor, dapVsCodeApi);
    // console.log(dapVsCodeApi);
    setupMiddlewareApis(dapVsCodeApi, viewsApi);
    // setupEditorApi(dapVsCodeApi, vscode, context, vscode.window.activeTextEditor);
    
    // Initialize panels
    const panels = initPanels(context, viewsApi);
    (vscode.window as any).panels = panels; // easier debugging

    // // TODO: Find place for folder selection in the logic
    // Get custom folder
    // const codetracerFolder = vscode.Uri.joinPath(context.extensionUri, 'media', 'codetracer-data');

    // const folderUri = await vscode.window.showOpenDialog({
    //   canSelectFiles: false,
    //   canSelectFolders: true,
    //   canSelectMany: false,
    //   openLabel: 'Select Codetracer Folder',
    //   defaultUri: vscode.Uri.file(codetracerFolder.path)
    // });

    // // TODO: For now hardcode for easier development
    // let selectedFile = "~/.local/share/codetracer/trace-3"

    // if (folderUri && folderUri.length > 0) {
    //   selectedFile = folderUri[0].fsPath;
    //   vscode.window.showInformationMessage(`You selected: ${selectedFile}`);
    // } else {
    //   vscode.window.showWarningMessage('No file selected');
    // }

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
  }
}

export function activate(context: vscode.ExtensionContext) {
  const toggleCT = vscode.commands.registerCommand(
    "ct-vscode.toggleCT",
    async () => toggleCt(context)
  );

  context.subscriptions.push(toggleCT);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      "codetracer-sidebar-panel",
      new utils.CodeTracerViewProvider(context)
    )
  );

  context.subscriptions.push(
    vscode.debug.onDidTerminateDebugSession(async (session) => {
      if (session.type === "codetracer-debug") {
        toggleCt(context);
      }
    })
  );
}

export function deactivate() {
  disposePanels();
  disposeCommands();
}
