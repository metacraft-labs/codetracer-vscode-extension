import * as vscode from 'vscode';

export class CodeTracerViewProvider implements vscode.WebviewViewProvider {
    constructor(private context: vscode.ExtensionContext) { }

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        const webview = webviewView.webview;
        webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this.context.extensionUri, 'media')
            ]
        };

        webview.html = this.getHtml();
        webviewView.webview.onDidReceiveMessage(
            message => {
                switch (message.command) {
                    case 'toggleCT':
                        vscode.commands.executeCommand('ct-vscode.toggleCT');
                        break;
                    case 'openState':
                        vscode.commands.executeCommand('ct-vscode.openState');
                        break;
                    case 'openScratchpad':
                        vscode.commands.executeCommand('ct-vscode.openScratchpad');
                        break;
                    case 'openCalltrace':
                        vscode.commands.executeCommand('ct-vscode.openCalltrace');
                        break;
                    case 'openEventLog':
                        vscode.commands.executeCommand('ct-vscode.openEventLog');
                        break;
                    case 'openTerminalOutput':
                        vscode.commands.executeCommand('ct-vscode.openTerminalOutput');
                        break;
                }
            },
        );
    }

    private getHtml(): string {
        return `
          <!DOCTYPE html>
          <html lang="en">
          <head>
            <meta charset="UTF-8">
            <style>
              body { font-family: sans-serif; padding: 10px; }
              div { display: flex; flex-direction: column }
            </style>
          </head>
          <body>
            <h3>Command Module</h3>
            <button id="toggleBtn">Toggle CT</button>
            </br>
            <div>
                <button id="state">Open State</button>
                <button id="scratchpad">Open Scratchpad</button>
                <button id="calltrace">Open Calltrace</button>
                <button id="eventLog">Open EventLog</button>
                <button id="terminalOutput">Open Terminal Output</button>
            </div>
            
      
            <script>
              const vscode = acquireVsCodeApi();
              document.getElementById('toggleBtn').addEventListener('click', () => {
                vscode.postMessage({ command: 'toggleCT' });
              });
              document.getElementById('state').addEventListener('click', () => {
                vscode.postMessage({ command: 'openState' });
              });
              document.getElementById('scratchpad').addEventListener('click', () => {
                vscode.postMessage({ command: 'openScratchpad' });
              });
              document.getElementById('calltrace').addEventListener('click', () => {
                vscode.postMessage({ command: 'openCalltrace' });
              });
              document.getElementById('eventLog').addEventListener('click', () => {
                vscode.postMessage({ command: 'openEventLog' });
              });
              document.getElementById('terminalOutput').addEventListener('click', () => {
                vscode.postMessage({ command: 'openTerminalOutput' });
              });
            </script>
          </body>
          </html>
        `;
    }
}

function getUiJs(panel: vscode.WebviewPanel, context: vscode.ExtensionContext): vscode.Uri {
    return panel.webview.asWebviewUri(
        vscode.Uri.joinPath(context.extensionUri, 'media', 'ui.js')
    );
}

function getFrontendBundle(panel: vscode.WebviewPanel, context: vscode.ExtensionContext): vscode.Uri {
    return panel.webview.asWebviewUri(
        vscode.Uri.joinPath(context.extensionUri, 'media', 'frontend_bundle.js')
    );
}

function getThirdParty(panel: vscode.WebviewPanel, context: vscode.ExtensionContext): vscode.Uri {
    return panel.webview.asWebviewUri(
        vscode.Uri.joinPath(context.extensionUri, 'media', 'third_party', 'jstree.min.js')
    );
}

function getDarkTheme(panel: vscode.WebviewPanel, context: vscode.ExtensionContext): vscode.Uri {
    return panel.webview.asWebviewUri(
        vscode.Uri.joinPath(context.extensionUri, 'media', 'styles', 'default_dark_theme.css')
    );
}

export function getStateWebviewContent(panel: vscode.WebviewPanel, context: vscode.ExtensionContext): string {
    let uiJs = getUiJs(panel, context);
    let frontendBundle = getFrontendBundle(panel, context);
    let thirdParty = getThirdParty(panel, context);
    let defaultDarkTheme = getDarkTheme(panel, context);

    // TODO: Add .css file to webViewContent

    return `
		<!doctype html>
		<html>
			<head>
				<meta charset='utf-8'>
				<title>CodeTracer</title>
				<link id='theme' rel='stylesheet' href='${defaultDarkTheme}'>
			<script>
				inElectron = false
				loadScripts = true
			</script>
			</head>
			<body>
				<div id='stateComponent-0' class='component-container active-state'></div>

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
						window.component = makeStateComponentForExtension('stateComponent-0');
					});
					window.addEventListener('message', event => {
						if (event.data.command === 'loaded-locals') {
								registerLocals(window.component, event.data.values)
							}
					});
				</script>
			</body>
		</html>

	`;
}

export function getCalltraceWebviewContent(panel: vscode.WebviewPanel, context: vscode.ExtensionContext): string {
    let uiJs = getUiJs(panel, context);
    let frontendBundle = getFrontendBundle(panel, context);
    let thirdParty = getThirdParty(panel, context);
    let defaultDarkTheme = getDarkTheme(panel, context);

    // TODO: Add .css file to webViewContent

    return `
		<!doctype html>
		<html>
			<head>
				<meta charset='utf-8'>
				<title>CodeTracer</title>
				<link id='theme' rel='stylesheet' href='${defaultDarkTheme}'>
			<script>
				inElectron = false
				loadScripts = true
			</script>
			</head>
			<body>
				<div id='calltraceComponent-0' class='component-container active-state'></div>

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
						window.component = makeCalltraceComponentForExtension('calltraceComponent-0');
					});
					window.addEventListener('message', event => {
						if (event.data.command === 'complete-call-move') {
							updateCalltrace(window.component, event.data.callKey)
						}
					});
				</script>
			</body>
		</html>
	`;
}

export function getEventLogWebviewContent(panel: vscode.WebviewPanel, context: vscode.ExtensionContext): string {
    let uiJs = getUiJs(panel, context);
    let frontendBundle = getFrontendBundle(panel, context);
    let thirdParty = getThirdParty(panel, context);
    let defaultDarkTheme = getDarkTheme(panel, context);

    // TODO: Add .css file to webViewContent

    return `
		<!doctype html>
		<html>
			<head>
				<meta charset='utf-8'>
				<title>CodeTracer</title>
				<link id='theme' rel='stylesheet' href='${defaultDarkTheme}'>
			<script>
				inElectron = false
				loadScripts = true
			</script>
			</head>
			<body>
				<div id='eventLogComponent-0' class='component-container active-state'></div>

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
						window.component = makeEventLogComponentForExtension('eventLogComponent-0');
					});
				</script>
			</body>
		</html>
	`;
}

export function getScratchpadWebviewContent(panel: vscode.WebviewPanel, context: vscode.ExtensionContext): string {
    let uiJs = getUiJs(panel, context);
    let frontendBundle = getFrontendBundle(panel, context);
    let thirdParty = getThirdParty(panel, context);
    let defaultDarkTheme = getDarkTheme(panel, context);

    // TODO: Add .css file to webViewContent

    return `
		<!doctype html>
		<html>
			<head>
				<meta charset='utf-8'>
				<title>CodeTracer</title>
				<link id='theme' rel='stylesheet' href='${defaultDarkTheme}'>
			<script>
				inElectron = false
				loadScripts = true
			</script>
			</head>
			<body>
				<div id='scratchpadComponent-0' class='component-container active-state'></div>

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
						window.component = makeScratchpadComponentForExtension('scratchpadComponent-0');
					});
				</script>
			</body>
		</html>
	`;
}

export function getTerminalOutputWebviewContent(panel: vscode.WebviewPanel, context: vscode.ExtensionContext): string {
    let uiJs = getUiJs(panel, context);
    let frontendBundle = getFrontendBundle(panel, context);
    let thirdParty = getThirdParty(panel, context);
    let defaultDarkTheme = getDarkTheme(panel, context);

    // TODO: Add .css file to webViewContent

    return `
		<!doctype html>
		<html>
			<head>
				<meta charset='utf-8'>
				<title>CodeTracer</title>
				<link id='theme' rel='stylesheet' href='${defaultDarkTheme}'>
			<script>
				inElectron = false
				loadScripts = true
			</script>
			</head>
			<body>
				<div id='terminalOutputComponent-0' class='component-container active-state'></div>

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
						window.component = makeTerminalOutputComponentForExtension('terminalOutputComponent-0');
					});
				</script>
			</body>
		</html>
	`;
}
