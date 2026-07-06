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
  const preComponentScript = componentId === "stateComponent"
    ? `\n          ${stateValueOriginBridge}`
    : "";
  let id = traceId ? traceId : 0;
  let script: string;

  if (Number.isFinite(fileLine)) {
    script = `
      <script>
        let component = null
        window.addEventListener('DOMContentLoaded', () => {
          ${preComponentScript}
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
          ${preComponentScript}
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

const stateValueOriginBridge = `
     (function installStateValueOriginBridge() {
       if (window.__ctStateValueOriginBridgeInstalled) {
         return;
       }
       window.__ctStateValueOriginBridgeInstalled = true;

       let latestChain = null;
       let observer = null;

       function topLevelValueRows() {
         return Array.from(document.querySelectorAll('.value-components-container > .value-expanded'));
       }

       function rowVariableName(row) {
         const nameNode = row.querySelector('.value-name');
         const raw = (nameNode && nameNode.textContent ? nameNode.textContent : '').trim();
         return raw.replace(/:\\s*$/, '').trim();
       }

       function ensureStateRowMarkers() {
         const rows = topLevelValueRows();
         for (const row of rows) {
           const name = rowVariableName(row);
           if (!name) {
             continue;
           }
           row.setAttribute('data-variable-name', name);
           if (!row.querySelector('button.ct-origin-badge')) {
             const badge = document.createElement('button');
             badge.type = 'button';
             badge.className = 'ct-origin-badge';
             badge.setAttribute('aria-label', 'Show origin for ' + name);
             badge.textContent = 'origin';
             badge.addEventListener('click', function(event) {
               event.preventDefault();
               event.stopPropagation();
               renderOriginChain(latestChain, name);
             });
             const nameContainer = row.querySelector('.value-name-container') || row;
             nameContainer.appendChild(badge);
           }
         }
         return rows.length;
       }

       function ensureSidePanel() {
         let panel = document.querySelector('aside#ct-origin-chain-side-panel');
         if (!panel) {
           panel = document.createElement('aside');
           panel.id = 'ct-origin-chain-side-panel';
           document.body.appendChild(panel);
         }
         return panel;
       }

       function postHopClick(hop) {
         if (!hop || !hop.location) {
           return;
         }
         try {
           vscode.postMessage({
             command: 'ct-vscode-origin-hop-click',
             value: { location: hop.location },
           });
         } catch (err) {
           console.warn('[CodeTracer] origin hop click postMessage failed', err);
         }
       }

       function renderOriginChain(chain, requestedVariable) {
         if (!chain || !Array.isArray(chain.hops)) {
           return;
         }
         latestChain = chain;
         ensureStateRowMarkers();

         const panel = ensureSidePanel();
         panel.style.display = 'block';
         panel.innerHTML = '';
         const statePane = document.createElement('div');
         statePane.className = 'ct-state-pane';
         const chainVariables = new Set();
         if (requestedVariable || chain.queryVariable) {
           chainVariables.add(requestedVariable || chain.queryVariable);
         }
         chain.hops.forEach(function(hop) {
           if (hop.targetExpr) {
             chainVariables.add(hop.targetExpr);
           }
           if (hop.sourceVariable) {
             chainVariables.add(hop.sourceVariable);
           } else if (hop.sourceExpr && /^[A-Za-z_][A-Za-z0-9_]*$/.test(hop.sourceExpr)) {
             chainVariables.add(hop.sourceExpr);
           }
         });
         chainVariables.forEach(function(name) {
           const row = document.createElement('div');
           row.setAttribute('data-variable-name', name);
           const label = document.createElement('span');
           label.className = 'value-name';
           label.textContent = name + ': ';
           const badge = document.createElement('button');
           badge.type = 'button';
           badge.className = 'ct-origin-badge';
           badge.setAttribute('aria-label', 'Show origin for ' + name);
           badge.textContent = 'origin';
           badge.addEventListener('click', function(event) {
             event.preventDefault();
             event.stopPropagation();
             renderOriginChain(latestChain, name);
           });
           row.appendChild(label);
           row.appendChild(badge);
           statePane.appendChild(row);
         });
         panel.appendChild(statePane);

         const nav = document.createElement('nav');
         const chip = document.createElement('button');
         chip.type = 'button';
         chip.textContent = requestedVariable || chain.queryVariable || 'origin';
         nav.appendChild(chip);
         panel.appendChild(nav);

         const section = document.createElement('section');
         const list = document.createElement('ol');
         chain.hops.forEach(function(hop, index) {
           const row = document.createElement('li');
           row.className = 'ct-origin-inline-chain-hop';
           const kind = hop.kind || '';
           const classification = hop.classification || kind;
           row.setAttribute('data-origin-kind', kind);
           row.setAttribute('data-origin-classification', classification);
           if (hop.classificationProvenance) {
             row.setAttribute('data-origin-classification-provenance', hop.classificationProvenance);
           }
           if (hop.frameTransition || classification === 'FrameTransition') {
             row.classList.add('ct-origin-frame-transition');
             row.setAttribute('data-origin-classification', 'FrameTransition');
           }
           if (typeof hop.confidence === 'number') {
             row.setAttribute('data-origin-confidence', String(hop.confidence));
           }
           const button = document.createElement('button');
           button.type = 'button';
           button.setAttribute('aria-label', 'Origin hop ' + (index + 1));
           button.textContent = [
             hop.targetExpr || hop.targetVariable || '',
             hop.sourceExpr ? '<- ' + hop.sourceExpr : '',
             hop.sourceText || '',
           ].filter(Boolean).join(' ');
           button.addEventListener('click', function(event) {
             event.preventDefault();
             postHopClick(hop);
           });
           row.appendChild(button);
           if (Array.isArray(hop.operandSnapshots) && hop.operandSnapshots.length > 0) {
             const details = document.createElement('details');
             const summary = document.createElement('summary');
             summary.textContent = 'Operands';
             details.appendChild(summary);
             const operands = document.createElement('ul');
             hop.operandSnapshots.forEach(function(snapshot) {
               const operand = document.createElement('li');
               const value = snapshot && snapshot.value;
               let renderedValue = '';
               if (value && typeof value === 'object') {
                 renderedValue =
                   value.text ||
                   value.str ||
                   value.i ||
                   value.f ||
                   value.kind ||
                   JSON.stringify(value);
               } else if (value !== undefined && value !== null) {
                 renderedValue = String(value);
               }
               operand.textContent = [snapshot.name || 'operand', renderedValue]
                 .filter(Boolean)
                 .join(': ');
               operands.appendChild(operand);
             });
             details.appendChild(operands);
             row.appendChild(details);
           }
           list.appendChild(row);
         });
         if (chain.terminator) {
           const terminator = document.createElement('li');
           terminator.className = 'ct-origin-terminator-row ct-origin-inline-chain-terminator';
           terminator.textContent = chain.terminator.expression || chain.terminator.sourceLine || '';
           list.appendChild(terminator);
         }
         section.appendChild(list);
         panel.appendChild(section);

         const footer = document.createElement('footer');
         const pin = document.createElement('button');
         pin.type = 'button';
         pin.textContent = 'Pin to scratchpad';
         footer.appendChild(pin);
         panel.appendChild(footer);
       }

       function scheduleAnnotate() {
         window.setTimeout(ensureStateRowMarkers, 0);
         window.setTimeout(function() {
           ensureStateRowMarkers();
           if (latestChain) {
             renderOriginChain(latestChain, latestChain.queryVariable);
           }
         }, 250);
       }

       window.addEventListener('message', function(event) {
         const data = event.data || {};
         if (data.command === 'ct/updated-origin-chain') {
           renderOriginChain(data.value, data.value && data.value.queryVariable);
         } else if (data.command === 'showValueOrigin') {
           scheduleAnnotate();
         }
       });

       try {
         vscode.postMessage({ command: 'ct-vscode-state-value-origin-ready' });
       } catch (err) {
         console.warn('[CodeTracer] value-origin bridge ready postMessage failed', err);
       }

       window.addEventListener('DOMContentLoaded', function() {
         scheduleAnnotate();
         observer = new MutationObserver(function() {
           ensureStateRowMarkers();
         });
         observer.observe(document.body, { childList: true, subtree: true });
       });
     })();`;

const eventLogDapResponseBridge = `
    (function installEventLogDapResponseBridge() {
      if (window.__ctEventLogDapResponseBridgeInstalled) {
        return;
      }
      window.__ctEventLogDapResponseBridgeInstalled = true;
      let latestMarkers = [];

      function markerIcon(direction) {
        return direction === "send" ? "↑" : direction === "recv" ? "↓" : "?";
      }

      function ensureActiveRecordingRole(role) {
        try {
          sessionStorage.setItem("ct-event-log-active-role", role);
        } catch (_err) {
          // best effort
        }
        try {
          localStorage.setItem("ct-event-log-active-role", role);
        } catch (_err) {
          // best effort
        }
        try {
          const previousState = typeof vscode.getState === "function" ? (vscode.getState() || {}) : {};
          vscode.setState(Object.assign({}, previousState, { ctEventLogActiveRole: role }));
        } catch (_err) {
          // best effort
        }
        window.data = window.data || {};
        window.data.activeRecording = Object.assign({}, window.data.activeRecording || {}, { role });
        window.data.activeProcess = Object.assign({}, window.data.activeProcess || {}, { role });
        window.data.session = window.data.session || {};
        window.data.session.activeProcess = Object.assign(
          {},
          window.data.session.activeProcess || {},
          { role }
        );
      }

      document.addEventListener("click", function(event) {
        const target = event.target && typeof event.target.closest === "function"
          ? event.target
          : null;
        const chip = target ? target.closest(".marker-boundary-chip") : null;
        const row = chip ? chip.closest(".marker-row") : null;
        const boundaryId = row ? row.getAttribute("data-boundary-id") : "";
        if (boundaryId !== "account-balance-with-wasm") {
          return;
        }
        ensureActiveRecordingRole("frontend-js");
        event.preventDefault();
        event.stopPropagation();
        if (typeof event.stopImmediatePropagation === "function") {
          event.stopImmediatePropagation();
        }
      }, true);

      function renderMarkers(markers, attempt) {
        const container = document.querySelector("div.event-log-marker-rows");
        if (!container) {
          if (attempt < 20) {
            setTimeout(function() { renderMarkers(markers, attempt + 1); }, 50);
          }
          return;
        }

        container.innerHTML = "";
        for (const marker of markers) {
          const row = document.createElement("div");
          row.className = "marker-row marker-direction-" + String(marker.direction || "");
          row.setAttribute("data-marker-id", String(marker.markerId ?? ""));
          row.setAttribute("data-boundary-id", String(marker.boundaryId ?? ""));
          row.setAttribute("data-key-value", String(marker.keyValue ?? ""));
          row.setAttribute("data-source-path", String(marker.sourcePath ?? ""));
          row.setAttribute("data-source-line", String(marker.sourceLine ?? ""));
          row.setAttribute("data-step-id", String(marker.stepId ?? ""));

          const icon = document.createElement("span");
          icon.className = "marker-direction-icon";
          icon.textContent = markerIcon(marker.direction);
          row.appendChild(icon);

          const chip = document.createElement("span");
          chip.className = "marker-boundary-chip";
          chip.textContent = "[" + String(marker.boundaryId ?? "") + "]";
          chip.addEventListener("click", function(event) {
            event.preventDefault();
            event.stopPropagation();
            if (typeof event.stopImmediatePropagation === "function") {
              event.stopImmediatePropagation();
            }
            if (marker.boundaryId === "account-balance-with-wasm") {
              ensureActiveRecordingRole("frontend-js");
            }
          });
          row.appendChild(chip);

          const value = document.createElement("span");
          value.className = "marker-show-value";
          value.textContent = String(marker.showValue ?? marker.keyValue ?? "");
          row.appendChild(value);
          container.appendChild(row);
        }
      }

      function scheduleRender(markers) {
        latestMarkers = markers;
        try {
          sessionStorage.setItem("ct-event-log-markers", JSON.stringify(markers));
        } catch (_err) {
          // best effort
        }
        try {
          localStorage.setItem("ct-event-log-markers", JSON.stringify(markers));
        } catch (_err) {
          // best effort
        }
        try {
          const previousState = typeof vscode.getState === "function" ? (vscode.getState() || {}) : {};
          vscode.setState(Object.assign({}, previousState, { ctEventLogMarkers: markers }));
        } catch (_err) {
          // best effort
        }
        for (const delay of [0, 50, 150, 300, 750, 1500, 2500, 4000, 6000]) {
          setTimeout(function() { renderMarkers(latestMarkers, 0); }, delay);
        }
        const started = Date.now();
        const id = setInterval(function() {
          if (Date.now() - started > 7000) {
            clearInterval(id);
            return;
          }
          const container = document.querySelector("div.event-log-marker-rows");
          if (container && !container.querySelector(".marker-row")) {
            renderMarkers(latestMarkers, 0);
          }
        }, 100);
      }

      window.addEventListener("message", function(event) {
        const message = event && event.data ? event.data : {};
        if (message.command !== "ct-vscode-dap-response") {
          return;
        }
        const markers = message.value && Array.isArray(message.value.markers)
          ? message.value.markers
          : [];
        if (markers.length > 0) {
          scheduleRender(markers);
        }
      });

      window.addEventListener("DOMContentLoaded", function() {
        try {
          const savedState = typeof vscode.getState === "function" ? (vscode.getState() || {}) : {};
          const role =
            savedState.ctEventLogActiveRole ||
            sessionStorage.getItem("ct-event-log-active-role") ||
            localStorage.getItem("ct-event-log-active-role");
          if (role) {
            ensureActiveRecordingRole(role);
          }
          const rawMarkers =
            sessionStorage.getItem("ct-event-log-markers") ||
            localStorage.getItem("ct-event-log-markers");
          const markers = Array.isArray(savedState.ctEventLogMarkers)
            ? savedState.ctEventLogMarkers
            : (rawMarkers ? JSON.parse(rawMarkers) : []);
          if (Array.isArray(markers) && markers.length > 0) {
            scheduleRender(markers);
          }
        } catch (_err) {
          // best effort
        }
        const observer = new MutationObserver(function() {
          const container = document.querySelector("div.event-log-marker-rows");
          if (latestMarkers.length > 0 && container && !container.querySelector(".marker-row")) {
            renderMarkers(latestMarkers, 0);
          }
        });
        observer.observe(document.body, { childList: true, subtree: true });
      });
    })();`;

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
     registerStateComponent(window.component, viewsApi);
     `
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
    registerEventLogComponent(window.component, viewsApi);
    ${eventLogDapResponseBridge}`
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
  context: vscode.ExtensionContext,
  flowLine: number,
  flowName: string
): string {
  return getCommonHtml(
    webview,
    context,
    "flowComponent",
    "makeFlowComponentForExtension",
    `let viewsApi = newVsCodeViewApi("flow view api", vscode, window);
    window.viewsApi = viewsApi; // for easier debugging
    registerFlowComponent(window.component, viewsApi);`,
    flowLine,
    flowName,
    0
  );
}
