import * as vscode from "vscode";

export class CodeTracerViewProvider implements vscode.WebviewViewProvider {
  constructor(private context: vscode.ExtensionContext) { }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    const webview = webviewView.webview;
    const fontUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.context.extensionUri,
        'media',
        'fonts',
        'SpaceGrotesk-VariableFont_wght.ttf'
      )
    );

    const darkCssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.context.extensionUri,
        'media',
        'styles',
        'default_dark_theme_extension.css'
      )
    );

    webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "media"),
      ],
    };

    webview.html = this.getHtml(darkCssUri, fontUri);
    webviewView.webview.onDidReceiveMessage((message) => {
      switch (message.command) {
        case "loadCurrentFile":
          vscode.commands.executeCommand("ct-vscode.loadCurrentFile");
          break;
        case "loadRecentTraces":
          vscode.commands.executeCommand("ct-vscode.loadRecentTraces");
          break;
        case "loadRecentTransactions":
          vscode.commands.executeCommand("ct-vscode.loadRecentTransactions");
          break;
        case "openState":
          vscode.commands.executeCommand("ct-vscode.openState");
          break;
        case "openScratchpad":
          vscode.commands.executeCommand("ct-vscode.openScratchpad");
          break;
        case "openCalltrace":
          vscode.commands.executeCommand("ct-vscode.openCalltrace");
          break;
        case "openEventLog":
          vscode.commands.executeCommand("ct-vscode.openEventLog");
          break;
        case "openTerminalOutput":
          vscode.commands.executeCommand("ct-vscode.openTerminalOutput");
          break;
      }
    });
  }

  private getHtml(cssUri: vscode.Uri, fontUri: vscode.Uri): string {
    return `
          <!DOCTYPE html>
          <html lang="en">
          <head>
            <meta charset="UTF-8">
            <link id='theme' rel='stylesheet' href='${cssUri}'>
            <style>
              @font-face {
                font-family: 'SpaceGroteskVs';
                src: url('${fontUri}') format('truetype');
              }
              body {
                font-family: 'SpaceGroteskVs' !important;
              }
            </style>
          </head>
          <body class="sidebar-menu-body">
            <div class="sidebar-menu-header">COMMAND MODULE</div>
            <div class="sidebar-menu-items">
              <div class="sidebar-menu-item" id="loadCurrentFile">Record and Run Current File</div>
              <div class="sidebar-menu-item" id="loadRecentTraces">Load Recent Traces</div>
              <div class="sidebar-menu-item" id="loadRecentTransactions">Load Recent Transactions</div>
              <div class="sidebar-menu-item" id="sidebar-state">Open State</div>
              <div class="sidebar-menu-item" id="sidebar-scratchpad">Open Scratchpad</div>
              <div class="sidebar-menu-item" id="sidebar-calltrace">Open Calltrace</div>
              <div class="sidebar-menu-item" id="sidebar-eventLog">Open EventLog</div>
              <div class="sidebar-menu-item" id="sidebar-terminalOutput">Open Terminal Output</div>
            </div>
            
      
            <script>
              const vscode = acquireVsCodeApi();
              document.getElementById('loadCurrentFile').addEventListener('click', () => {
                vscode.postMessage({ command: 'loadCurrentFile' });
              });
              document.getElementById('loadRecentTraces').addEventListener('click', () => {
                vscode.postMessage({ command: 'loadRecentTraces' });
              });
              document.getElementById('loadRecentTransactions').addEventListener('click', () => {
                vscode.postMessage({ command: 'loadRecentTransactions' });
              });
              document.getElementById('sidebar-state').addEventListener('click', () => {
                vscode.postMessage({ command: 'openState' });
              });
              document.getElementById('sidebar-scratchpad').addEventListener('click', () => {
                vscode.postMessage({ command: 'openScratchpad' });
              });
              document.getElementById('sidebar-calltrace').addEventListener('click', () => {
                vscode.postMessage({ command: 'openCalltrace' });
              });
              document.getElementById('sidebar-eventLog').addEventListener('click', () => {
                vscode.postMessage({ command: 'openEventLog' });
              });
              document.getElementById('sidebar-terminalOutput').addEventListener('click', () => {
                vscode.postMessage({ command: 'openTerminalOutput' });
              });
            </script>
          </body>
          </html>
        `;
  }
}

/**
 * The panels a webview can show — the kinds `vscode_panel.js` mounts
 * (codetracer `src/frontend/entries/vscode_panel.nim`).
 */
export type PanelKind =
  | "state"
  | "calltrace"
  | "eventLog"
  | "terminalOutput"
  | "scratchpad"
  | "traceLog"
  | "flow"
  | "pointList"
  | "fileTree";

/**
 * The HTML of one CodeTracer panel's webview.
 *
 * It loads `vscode_panel.js` — the panel's view over a mirror of the session
 * the extension host owns (Shared-DOM-Front-Ends D5) — and the design-system
 * CSS (whose fonts and icons `just build` copies under `media/`), and
 * nothing else: no `ui.js`, no webpack bundle, no Monaco, no jQuery.
 * `<body data-ct-panel>` names the panel the script mounts into
 * `#ct-panel-root`.
 */
export function getPanelWebviewContent(
  webview: vscode.Webview,
  context: vscode.ExtensionContext,
  kind: PanelKind
): string {
  const media = (...segments: string[]) =>
    webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "media", ...segments));
  const panelJs = media("vscode_panel.js");
  const theme = media("styles", "default_dark_theme_extension.css");
  return `<!doctype html>
<html class="component-container-html">
  <head>
    <meta charset="utf-8">
    <title>CodeTracer</title>
    <link id="theme" rel="stylesheet" href="${theme}">
  </head>
  <body class="component-container-body" data-ct-panel="${kind}">
    <div id="context-menu-container" style="display: none;"></div>
    <div id="ct-panel-root" class="component-container active-state"></div>
    <script src="${panelJs}"></script>
  </body>
</html>
`;
}
