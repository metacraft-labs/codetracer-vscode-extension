import * as vscode from "vscode";
import {
  adoptPanel,
  createPanelInset,
  disposeAllPanels,
  getOrCreatePanel,
  viewTypeOf,
} from "./panelManager";
import { runTracepoint } from "./sessionHost";
import { PanelKind } from "./utils";

/**
 * The CodeTracer panels VS Code shows: their titles, the commands that open
 * them, the ones a debug session opens, and their restoration.
 */

interface PanelSpec {
  kind: PanelKind;
  title: string;
  command: string;
}

const PANELS: PanelSpec[] = [
  { kind: "state", title: "State", command: "ct-vscode.openState" },
  { kind: "calltrace", title: "Calltrace", command: "ct-vscode.openCalltrace" },
  { kind: "scratchpad", title: "Scratchpad", command: "ct-vscode.openScratchpad" },
  { kind: "eventLog", title: "Event Log", command: "ct-vscode.openEventLog" },
  { kind: "terminalOutput", title: "Terminal", command: "ct-vscode.openTerminalOutput" },
  { kind: "traceLog", title: "Trace Log", command: "ct-vscode.openTraceLog" },
  { kind: "pointList", title: "Points", command: "ct-vscode.openPointList" },
  { kind: "fileTree", title: "Files", command: "ct-vscode.openFileTree" },
  // The Request Panel role (Shared-DOM-Front-Ends Q8): the shared view over the
  // mirrored session. Not opened with a debug session, as on the desktop, where
  // it is not part of the default layout either (Request-Panel.md).
  { kind: "requestPanel", title: "Requests", command: "ct-vscode.openRequests" },
];

/** The panels a debug session opens, in this order. */
const OPENED_ON_START: PanelKind[] = [
  "state",
  "calltrace",
  "scratchpad",
  "eventLog",
  "terminalOutput",
];

/**
 * Whether CodeTracer's file pane fills the file-tree role, or VS Code's
 * Explorer does (`codetracer.panels.fileTree`, Shared-DOM-Front-Ends D9).
 */
export function fileTreeRole(): "codetracer" | "editor" {
  const value = vscode.workspace
    .getConfiguration("codetracer")
    .get<string>("panels.fileTree", "codetracer");
  return value === "editor" ? "editor" : "codetracer";
}

function specOf(kind: PanelKind): PanelSpec {
  return PANELS.find((spec) => spec.kind === kind)!;
}

export function openPanel(context: vscode.ExtensionContext, kind: PanelKind): vscode.WebviewPanel {
  return getOrCreatePanel(context, kind, specOf(kind).title);
}

let commands: vscode.Disposable[] = [];

/** Register the commands that open each panel. Idempotent. */
export function registerPanelCommands(context: vscode.ExtensionContext): void {
  if (commands.length > 0) {
    return;
  }
  for (const spec of PANELS) {
    commands.push(
      vscode.commands.registerCommand(spec.command, () => openPanel(context, spec.kind))
    );
  }
  context.subscriptions.push(...commands);
}

/**
 * Restore the panels VS Code persisted with the window (SDF-AREQ9: the
 * editor keeps the arrangement). A restored panel shows the session the
 * host makes active.
 */
export function registerPanelSerializers(context: vscode.ExtensionContext): void {
  for (const spec of PANELS) {
    context.subscriptions.push(
      vscode.window.registerWebviewPanelSerializer(viewTypeOf(spec.kind), {
        async deserializeWebviewPanel(panel: vscode.WebviewPanel) {
          adoptPanel(context, spec.kind, panel);
        },
      })
    );
  }
}

/** Open the panels a debug session shows, as tabs of one editor group. */
export async function initPanels(context: vscode.ExtensionContext): Promise<void> {
  registerPanelCommands(context);
  for (const kind of OPENED_ON_START) {
    openPanel(context, kind);
  }
  if (fileTreeRole() === "codetracer") {
    openPanel(context, "fileTree");
  }
  openPanel(context, "state").reveal(vscode.ViewColumn.Two, true);
}

export function disposePanels(): void {
  disposeAllPanels();
}

export function disposeCommands(): void {
  for (const command of commands) {
    command.dispose();
  }
  commands = [];
}

/** The flow's loop control, in an inset on the loop's line (0-based). */
export function addLoopPosition(
  context: vscode.ExtensionContext,
  editor: vscode.TextEditor,
  line: number
): vscode.WebviewEditorInset {
  return createPanelInset(context, editor, "flow", line, 2);
}

/**
 * Add a tracepoint on the cursor's line: VS Code's input box asks for the
 * expression to log, the host runs it over the recording, and the Trace Log
 * shows the hits.
 */
export async function addTracepoint(
  context: vscode.ExtensionContext,
  editor: vscode.TextEditor,
  line: number
): Promise<boolean> {
  const expression = await vscode.window.showInputBox({
    prompt: `Log at line ${line + 1}`,
    placeHolder: "an expression, e.g. x or a + b",
  });
  if (!expression) {
    return false;
  }
  const started = runTracepoint(editor.document.uri.fsPath, line + 1, expression);
  if (started) {
    openPanel(context, "traceLog");
  }
  return started;
}
