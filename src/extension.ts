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
  CtJumpBehaviour
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

async function toggleCt(context: vscode.ExtensionContext, dapVsCodeApi: DapVsCodeApi) {
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
    const selectedFile = await pickTraceFolder()
    if (!selectedFile) {
      vscode.window.showWarningMessage('No trace folder selected.');
      return;
    }

    const viewsApi = setupVsCodeExtensionViewsApi(
      "vscode-extension-to-views"
    );
    (vscode.window as any).viewsApi = viewsApi; // easier debugging
    
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
