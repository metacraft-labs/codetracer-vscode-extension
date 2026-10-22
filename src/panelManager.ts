import * as vscode from "vscode";
import { attachWebview } from "./sessionHost";
import { getPanelWebviewContent, PanelKind } from "./utils";

/**
 * CodeTracer's webviews: one per panel (Shared-DOM-Front-Ends D9, SDF-AREQ9),
 * each a mirror of the session the extension host owns. Arranging, moving
 * and closing them is VS Code's own behaviour, and VS Code restores them
 * (`registerPanelSerializers`).
 */

/** The view type of panel `kind`'s webview. */
export function viewTypeOf(kind: PanelKind): string {
  return `codetracer.${kind}`;
}

export function webviewOptions(context: vscode.ExtensionContext): vscode.WebviewOptions {
  return {
    enableScripts: true,
    localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
  };
}

const panels: Map<PanelKind, vscode.WebviewPanel> = new Map();

/**
 * Show panel `kind`'s view in `panel` and serve it the host's session. Used
 * for a new panel and for one VS Code restored.
 */
export function adoptPanel(
  context: vscode.ExtensionContext,
  kind: PanelKind,
  panel: vscode.WebviewPanel
): vscode.WebviewPanel {
  panel.webview.options = webviewOptions(context);
  panel.webview.html = getPanelWebviewContent(panel.webview, context, kind);
  const served = attachWebview(panel.webview);
  panel.onDidDispose(() => {
    served.dispose();
    if (panels.get(kind) === panel) {
      panels.delete(kind);
    }
  });
  panels.set(kind, panel);
  return panel;
}

export function getOrCreatePanel(
  context: vscode.ExtensionContext,
  kind: PanelKind,
  title: string
): vscode.WebviewPanel {
  const existing = panels.get(kind);
  if (existing) {
    existing.reveal(undefined, true);
    return existing;
  }
  const panel = vscode.window.createWebviewPanel(
    viewTypeOf(kind),
    title,
    { viewColumn: vscode.ViewColumn.Two, preserveFocus: true },
    // A panel's bundle is the panel's view alone, so a hidden panel keeps its
    // context: it stays a live mirror and shows the current state when
    // revealed.
    { ...webviewOptions(context), retainContextWhenHidden: true }
  );
  return adoptPanel(context, kind, panel);
}

export function activePanels(): Map<PanelKind, vscode.WebviewPanel> {
  return new Map(panels);
}

export function disposeAllPanels(): void {
  for (const panel of [...panels.values()]) {
    panel.dispose();
  }
  panels.clear();
}

/**
 * A panel's view in an editor inset, at `line` (0-based): the flow's loop
 * control. Insets are a proposed VS Code API (`editorInsets`).
 */
export function createPanelInset(
  context: vscode.ExtensionContext,
  editor: vscode.TextEditor,
  kind: PanelKind,
  line: number,
  height: number
): vscode.WebviewEditorInset {
  const inset = vscode.window.createWebviewTextEditorInset(
    editor,
    line,
    height,
    webviewOptions(context)
  );
  const served = attachWebview(inset.webview);
  inset.onDidDispose(() => served.dispose());
  // Set after the inset exists: an inset's webview ignores HTML set in the
  // same tick it was created.
  setTimeout(() => {
    inset.webview.html = getPanelWebviewContent(inset.webview, context, kind);
  }, 0);
  return inset;
}
