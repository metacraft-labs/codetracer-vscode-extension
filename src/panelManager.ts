import * as vscode from 'vscode';

type PanelId = 'stateComponent' | 'calltraceComponent' | 'scratchpadComponent' | 'eventLogComponent' | 'terminalOutputComponent' | 'flowComponent' | 'tracepointComponent';

export interface PanelConfig {
    id: PanelId;
    title: string;
    getContent?: (panel: vscode.Webview, context: vscode.ExtensionContext) => string;
    getFlowContent?: (panel: vscode.Webview, context: vscode.ExtensionContext, flowLine: number, flowFile: string) => string;
    getTraceContent?: (panel: vscode.Webview, context: vscode.ExtensionContext, traceLine: number, traceFile: string, traceId: number) => string;
}

const panels: Map<PanelId, vscode.WebviewPanel> = new Map();
let traceId = 0;

function setInsetHtmlAsync(inset: vscode.WebviewEditorInset, html: string): void {
    // Defer initial HTML attachment until the inset has been mounted by VS Code.
    setTimeout(() => {
        inset.webview.html = html;
    }, 0);
}

export function createFlowPanel(
    config: PanelConfig,
    editor: vscode.TextEditor,
    line: number,
    context: vscode.ExtensionContext,
    onMessage?: (msg: any, panel: vscode.WebviewEditorInset) => void
): vscode.WebviewEditorInset {
    const inset = vscode.window.createWebviewTextEditorInset(
        editor,
        line,
        1,
        {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(context.extensionUri, "media"),
                vscode.Uri.joinPath(context.extensionUri, "public")
            ],
        }
    );
    if (onMessage) {
        inset.webview.onDidReceiveMessage(
            message => onMessage(message, inset),
            undefined,
            context.subscriptions
        );
    }

    const html = config.getFlowContent
        ? config.getFlowContent(inset.webview, context, line + 1, editor.document.fileName)
        : (config.getContent ? config.getContent(inset.webview, context) : "");
    setInsetHtmlAsync(inset, html);

    return inset;
}

export function createTracepointPanel(
    config: PanelConfig,
    editor: vscode.TextEditor,
    line: number,
    context: vscode.ExtensionContext,
    onMessage?: (msg: any, panel: vscode.WebviewEditorInset) => void
): vscode.WebviewEditorInset {
    const inset = vscode.window.createWebviewTextEditorInset(
        editor,
        line,
        20,
        {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(context.extensionUri, "media"),
                vscode.Uri.joinPath(context.extensionUri, "public")
            ],
        }
    );
    if (onMessage) {
        inset.webview.onDidReceiveMessage(
            message => onMessage(message, inset),
            undefined,
            context.subscriptions
        );
    }

    const html = config.getTraceContent ? config.getTraceContent(inset.webview, context, line + 1, editor.document.fileName, traceId) : "";
    setInsetHtmlAsync(inset, html);
    traceId += 1;
    return inset;
}

export function getOrCreatePanel(
    config: PanelConfig,
    context: vscode.ExtensionContext,
    onMessage?: (msg: any, panel: vscode.WebviewPanel) => void
): vscode.WebviewPanel {
    const existing = panels.get(config.id);
    if (existing) {
        existing.reveal();
        return existing;
    }

    const panel = vscode.window.createWebviewPanel(
        config.id,
        config.title,
        vscode.ViewColumn.Two,
        {
            enableScripts: true,
            // `retainContextWhenHidden: false` so a hidden panel releases
            // its renderer/iframe context. The CodeTracer webview loads a
            // large (~44 MB) frontend bundle plus a ~14 MB Nim `ui.js`;
            // keeping the context alive for every hidden panel kept a copy
            // of all that resident in the VS Code renderer for each of the
            // five panels at once. With this off, only the visible panel
            // holds the bundle; hidden panels reload it when revealed.
            retainContextWhenHidden: false,
            localResourceRoots: [
                vscode.Uri.joinPath(context.extensionUri, "media"),
                vscode.Uri.joinPath(context.extensionUri, "public"),
            ],
        }
    );

    panel.webview.html = config.getContent ? config.getContent(panel.webview, context) : "";

    if (onMessage) {
        panel.webview.onDidReceiveMessage(
            message => onMessage(message, panel),
            undefined,
            context.subscriptions
        );
    }

    panel.onDidDispose(() => {
        panels.delete(config.id);
    });

    panels.set(config.id, panel);
    return panel;
}
