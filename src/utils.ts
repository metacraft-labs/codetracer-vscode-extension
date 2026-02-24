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

function getUiJs(
  webview: vscode.Webview,
  context: vscode.ExtensionContext
): vscode.Uri {
  return webview.asWebviewUri(
    vscode.Uri.joinPath(context.extensionUri, "media", "ui.js")
  );
}

function getFrontendBundle(
  webview: vscode.Webview,
  context: vscode.ExtensionContext
): vscode.Uri {
  return webview.asWebviewUri(
    vscode.Uri.joinPath(context.extensionUri, "media", "frontend_bundle.js")
  );
}

function getThirdParty(
  webview: vscode.Webview,
  context: vscode.ExtensionContext
): vscode.Uri {
  return webview.asWebviewUri(
    vscode.Uri.joinPath(
      context.extensionUri,
      "media",
      "third_party",
      "jstree.min.js"
    )
  );
}

function getDarkTheme(
  webview: vscode.Webview,
  context: vscode.ExtensionContext
): vscode.Uri {
  return webview.asWebviewUri(
    vscode.Uri.joinPath(
      context.extensionUri,
      "media",
      "styles",
      "default_dark_theme_extension.css"
    )
  );
}

function getCommonHtml(
  webview: vscode.Webview,
  context: vscode.ExtensionContext,
  componentId: string,
  componentFactory: string,
  messageHandler?: string,
  fileLine?: number,
  fileName?: string,
  traceId?: number
): string {
  const uiJs = getUiJs(webview, context);
  const frontendBundle = getFrontendBundle(webview, context);
  const thirdParty = getThirdParty(webview, context);
  const defaultDarkTheme = getDarkTheme(webview, context);
  const messageHandlerScript = messageHandler
    ? `\n        ${messageHandler}`
    : "";

  let script: string;
  let id = traceId ? traceId : 0;

  if (Number.isFinite(fileLine)) {
    script = `
      <script>
        let component = null
        window.addEventListener('DOMContentLoaded', () => {
          window.component = ${componentFactory} ('${componentId}-${traceId}', ${fileLine}, '${fileName}', ${traceId});
          // for now the message handler/api setup code depends on
          // window.component/component being initialized
          ${messageHandlerScript}
        });
      </script>
    `;
  } else {
    script = `
      <script>
        let component = null
        window.addEventListener('DOMContentLoaded', () => {
          window.component = ${componentFactory} ('${componentId}-0');
          // for now the message handler/api setup code depends on
          // window.component/component being initialized
          ${messageHandlerScript}
        });
      </script>
    `;
  }

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
            <body class="component-container-body" id="ROOT">
                    <div id="context-menu-container" style="display: none;"></div>
                    <div id='${componentId}-${id}' class='component-container active-state'></div>

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
                    ${script}
            </body>
    </html>

  `;
}

export function getStateWebviewContent(
  webview: vscode.Webview,
  context: vscode.ExtensionContext
): string {
  return getCommonHtml(
    webview,
    context,
    "stateComponent",
    "makeStateComponentForExtension",
    `let viewsApi = newVsCodeViewApi("state view api", vscode, window);
     window.viewsApi = viewsApi; // for easier debugging
     registerStateComponent(window.component, viewsApi);`
  );
}

export function getCalltraceWebviewContent(
  webview: vscode.Webview,
  context: vscode.ExtensionContext
): string {
  return getCommonHtml(
    webview,
    context,
    "calltraceComponent",
    "makeCalltraceComponentForExtension",
    `let viewsApi = newVsCodeViewApi("calltrace view api", vscode, window);
     window.viewsApi = viewsApi; // for easier debugging
     registerCalltraceComponent(window.component, viewsApi);`
  );
}

export function getEventLogWebviewContent(
  webview: vscode.Webview,
  context: vscode.ExtensionContext
): string {
  return getCommonHtml(
    webview,
    context,
    "eventLogComponent",
    "makeEventLogComponentForExtension",
    `let viewsApi = newVsCodeViewApi("eventLog view api", vscode, window);
    window.viewsApi = viewsApi; // for easier debugging
    registerEventLogComponent(window.component, viewsApi);`
  );
}

export function getScratchpadWebviewContent(
  webview: vscode.Webview,
  context: vscode.ExtensionContext
): string {
  return getCommonHtml(
    webview,
    context,
    "scratchpadComponent",
    "makeScratchpadComponentForExtension",
    `let viewsApi = newVsCodeViewApi("terminal view api", vscode, window);
    window.viewsApi = viewsApi; // for easier debugging
    registerScratchpadComponent(window.component, viewsApi);`
  );
}

export function getTerminalOutputWebviewContent(
  webview: vscode.Webview,
  context: vscode.ExtensionContext
): string {
  return getCommonHtml(
    webview,
    context,
    "terminalOutputComponent",
    "makeTerminalOutputComponentForExtension",
    `let viewsApi = newVsCodeViewApi("terminal view api", vscode, window);
    window.viewsApi = viewsApi; // for easier debugging
    registerTerminalOutputComponent(window.component, viewsApi);`
  );
}

export function getTracepointWebviewContent(
  webview: vscode.Webview,
  context: vscode.ExtensionContext,
  traceLine: number,
  traceName: string,
  traceId: number
): string {
  return getCommonHtml(
    webview,
    context,
    "trace",
    "makeTracepointComponentForExtension",
    `let viewsApi = newVsCodeViewApi("tracepoint view api", vscode, window);
    window.viewsApi = viewsApi; // for easier debugging
    registerTracepointComponent(window.component, viewsApi);`,
    traceLine,
    traceName,
    traceId
  );
}

export function getFlowComponent(
  webview: vscode.Webview,
  context: vscode.ExtensionContext
): string {
  return getCommonHtml(
    webview,
    context,
    "flowComponent",
    "makeFlowComponentForExtension",
    `let viewsApi = newVsCodeViewApi("flow view api", vscode, window);
    window.viewsApi = viewsApi; // for easier debugging
    registerFlowComponent(window.component, viewsApi);`
  );
}
