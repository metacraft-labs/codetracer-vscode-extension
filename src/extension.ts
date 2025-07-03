import * as vscode from "vscode";
import { ChildProcess } from "child_process";
import { initPanels, disposePanels, disposeCommands } from "./initPanels";
import * as utils from "./utils";
import {
  MediatorWithSubscribers,
  DapVsCodeApi,
  setupVsCodeExtensionViewsApi,
  newDapVsCodeApi,
  setupMiddlewareApis,
} from "./ct_vscode.js";

let backendProcess: ChildProcess | null = null;

let ctStarted = false;

let nextStepDisposable: vscode.Disposable | null = null;

const TYPE_KIND_INT = 7;

function intValue(i: number): any {
  return { kind: TYPE_KIND_INT, i: i.toString() };
}

export function activate(context: vscode.ExtensionContext) {
  const toggleCT = vscode.commands.registerCommand(
    "ct-vscode.toggleCT",
    async () => {
      if (ctStarted) {
        // Stop CT
        ctStarted = false;
        vscode.window.showInformationMessage("CodeTracer stopped.");

        if (nextStepDisposable) {
          nextStepDisposable.dispose();
          nextStepDisposable = null;
        }

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
        ctStarted = true;
        // const callerPid = process.pid.toString();
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
          vscode.window.showErrorMessage("No workspace folder is open.");
          return;
        }

        let viewsApi = setupVsCodeExtensionViewsApi(
          "vscode-extension-to-views"
        );
        let dapVsCodeApi = newDapVsCodeApi(vscode, context);

        let backendApi = setupMiddlewareApis(dapVsCodeApi, viewsApi);

        const panels = initPanels(context, viewsApi);

        // context.subscriptions.push(
        //   vscode.debug.registerDebugAdapterTrackerFactory("*", {
        //     createDebugAdapterTracker(session: vscode.DebugSession) {
        //       return {
        //         onDidSendMessage: async (msg) => {
        //           if (msg.type === "event" && msg.event === "stopped") {
        //             // ->
        //             // Currently the args are not used in the db-backend but are used in the rr-backend!
        //             let res =
        //               await vscode.debug.activeDebugSession?.customRequest(
        //                 "ct/load-locals",
        //                 { rrTicks: 0, countBudget: 0, minCountLimit: 0 }
        //               );
        //             panels.state.webview.postMessage({
        //               command: "loaded-locals",
        //               arg: res,
        //             });
        //           }
        //         },
        //       };
        //     },
        //   })
        // );

        const debugConfig = {
          type: "codetracer-debug",
          request: "launch",
          name: "Launch Codetracer",
          cwd: "",
          traceFolder: "~/.local/share/codetracer/trace-425",
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

        // Init webviewPanels:

        // Register nextStep command
        nextStepDisposable = vscode.commands.registerCommand(
          "ct-vscode.nextStep",
          () => {
            vscode.window.showInformationMessage("Next clicked");
            panels.state.webview.postMessage({ command: "next" });
            // viewsApiEmit(viewsApi, CtLoadedLocals, {..});
            // panels.state.webview.postMessage({
            //   command: "loaded-locals",
            //   arg: { locals: [{ expression: "a", value: intValue(10) }] },
            // });
          }
        );

        context.subscriptions.push(nextStepDisposable);
      }
    }
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      "codetracer-sidebar-panel",
      new utils.CodeTracerViewProvider(context)
    )
  );

  vscode.debug.onDidTerminateDebugSession((session) => {
    if (session.type === "codetracer-debug") {
      ctStarted = false;
    }
  });

  context.subscriptions.push(toggleCT);
}

export function deactivate() {
  disposePanels();
  disposeCommands();
}
