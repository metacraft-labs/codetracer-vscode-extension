import * as vscode from 'vscode';

type PanelId = 'stateComponent' | 'calltraceComponent' | 'scratchpadComponent' | 'eventLogComponent' | 'terminalOutputComponent';

export interface PanelConfig {
    id: PanelId;
    title: string;
    getContent: (panel: vscode.WebviewPanel, context: vscode.ExtensionContext) => string;
}

const panels: Map<PanelId, vscode.WebviewPanel> = new Map();

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
            retainContextWhenHidden: true
        }
    );

    panel.webview.html = config.getContent(panel, context);

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