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

function getUiJs(
  panel: vscode.WebviewPanel,
  context: vscode.ExtensionContext
): vscode.Uri {
  return panel.webview.asWebviewUri(
    vscode.Uri.joinPath(context.extensionUri, "media", "ui.js")
  );
}

function getFrontendBundle(
  panel: vscode.WebviewPanel,
  context: vscode.ExtensionContext
): vscode.Uri {
  return panel.webview.asWebviewUri(
    vscode.Uri.joinPath(context.extensionUri, "media", "frontend_bundle.js")
  );
}

function getThirdParty(
  panel: vscode.WebviewPanel,
  context: vscode.ExtensionContext
): vscode.Uri {
  return panel.webview.asWebviewUri(
    vscode.Uri.joinPath(
      context.extensionUri,
      "media",
      "third_party",
      "jstree.min.js"
    )
  );
}

function getDarkTheme(
  panel: vscode.WebviewPanel,
  context: vscode.ExtensionContext
): vscode.Uri {
  return panel.webview.asWebviewUri(
    vscode.Uri.joinPath(
      context.extensionUri,
      "media",
      "styles",
      "default_dark_theme_extension.css"
    )
  );
}

function getCommonHtml(
  panel: vscode.WebviewPanel,
  context: vscode.ExtensionContext,
  componentId: string,
  componentFactory: string,
  messageHandler?: string
): string {
  const uiJs = getUiJs(panel, context);
  const frontendBundle = getFrontendBundle(panel, context);
  const thirdParty = getThirdParty(panel, context);
  const defaultDarkTheme = getDarkTheme(panel, context);

  const messageHandlerScript = messageHandler
    ? `\n        ${messageHandler}`
    : "";

  return `
                <!doctype html>
                <html class="component-container-html">
                        <head>
                                <meta charset='utf-8'>
                                <title>CodeTracer</title>
                                <link id='theme' rel='stylesheet' href='${defaultDarkTheme}'>
                        <script>
                                inElectron = false
                                loadScripts = true
                        </script>
                        </head>
                        <body class="component-container-body">
                                <div id="context-menu-container" style="display: none;"></div>
                                <div id='${componentId}-0' class='component-container active-state'></div>

                                <footer>
                                        <div id='search-results'>
                                        </div>
                                        <div id='status'>
                                        </div>
                                </footer>
                                </div>
                                <script src="${frontendBundle}" type="text/javascript"> </script>
                                <script src='${thirdParty}' type='text/javascript'></script>
                                <script src='${uiJs}'></script>
                                <script>
                                        let component = null
                                        window.addEventListener('DOMContentLoaded', () => {
                                            window.component = ${componentFactory}('${componentId}-0');
                                            // for now the message handler/api setup code depends on
                                            // window.component/component being initialized
                                            ${messageHandlerScript}
                                        });
                                </script>
                        </body>
                </html>

        `;
}

export function getStateWebviewContent(
  panel: vscode.WebviewPanel,
  context: vscode.ExtensionContext
): string {
  return getCommonHtml(
    panel,
    context,
    "stateComponent",
    "makeStateComponentForExtension",
    `let viewsApi = newVsCodeViewApi("state view api", vscode, window);
     window.viewsApi = viewsApi; // for easier debugging
     registerStateComponent(window.component, viewsApi);`
  );
}

export function getCalltraceWebviewContent(
  panel: vscode.WebviewPanel,
  context: vscode.ExtensionContext
): string {
  return getCommonHtml(
    panel,
    context,
    "calltraceComponent",
    "makeCalltraceComponentForExtension",
    `let viewsApi = newVsCodeViewApi("calltrace view api", vscode, window);
     window.viewsApi = viewsApi; // for easier debugging
     registerCalltraceComponent(window.component, viewsApi);`
  );
}

export function getEventLogWebviewContent(
  panel: vscode.WebviewPanel,
  context: vscode.ExtensionContext
): string {
  return getCommonHtml(
    panel,
    context,
    "eventLogComponent",
    "makeEventLogComponentForExtension",
    `let viewsApi = newVsCodeViewApi("eventLog view api", vscode, window);
     window.viewsApi = viewsApi; // for easier debugging
     registerEventLogComponent(window.component, viewsApi);`
  );
}

export function getScratchpadWebviewContent(
  panel: vscode.WebviewPanel,
  context: vscode.ExtensionContext
): string {
  return getCommonHtml(
    panel,
    context,
    "scratchpadComponent",
    "makeScratchpadComponentForExtension"
  );
}

export function getTerminalOutputWebviewContent(
  panel: vscode.WebviewPanel,
  context: vscode.ExtensionContext
): string {
  return getCommonHtml(
    panel,
    context,
    "terminalOutputComponent",
    "makeTerminalOutputComponentForExtension",
    `let viewsApi = newVsCodeViewApi("terminal view api", vscode, window);
     window.viewsApi = viewsApi; // for easier debugging
     registerTerminalOutputComponent(window.component, viewsApi);`
  );
}
