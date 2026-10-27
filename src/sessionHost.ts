import * as vscode from "vscode";
import * as path from "path";

/**
 * The extension host's CodeTracer sessions (Shared-DOM-Front-Ends D2).
 *
 * `vscode_host.js` is compiled from codetracer's
 * `src/frontend/entries/vscode_host.nim`. It owns one primary
 * `DebuggerSession` per CodeTracer debug session — attached to the replay VS
 * Code's debug adapter launched, asking through the session's
 * `customRequest` and following its events — and serves every panel webview
 * a mirror of the active one. This module is the TypeScript half: it routes
 * VS Code's debug sessions, their adapter's events and the panels' messages
 * to it, and nothing else; no debugger state lives here.
 */

interface HostModule {
  ctHostCreate(): unknown;
  ctHostOpenSession(
    host: unknown,
    id: string,
    traceFolder: string,
    send: (command: string, args: unknown) => Thenable<unknown>
  ): void;
  ctHostDeliverEvent(host: unknown, id: string, message: unknown): void;
  ctHostActivate(host: unknown, id: string): void;
  ctHostCloseSession(host: unknown, id: string): void;
  ctHostAttachWebview(host: unknown, post: (message: unknown) => void): unknown;
  ctHostDeliverFromWebview(channel: unknown, data: unknown): boolean;
  ctHostDetachWebview(host: unknown, channel: unknown): void;
  ctHostShowValueOrigin(host: unknown, expression: string): void;
  ctHostRunTracepoint(host: unknown, filePath: string, line: number, expression: string): void;
  ctHostOnFlowLines(
    host: unknown,
    listener: (filePath: string, lines: FlowLine[], loops: FlowLoop[]) => void
  ): void;
  ctHostSetSourceFiles(host: unknown, id: string, paths: string[]): void;
  ctHostOnOpenFile(host: unknown, listener: (filePath: string) => void): void;
  ctHostRevealFile(host: unknown, filePath: string): void;
  ctHostAddToScratchpad(
    host: unknown,
    expression: string,
    done: (outcome: ScratchpadAddOutcome, detail: string) => void
  ): void;
  ctHostHistory(host: unknown, back: boolean): void;
  ctHostDispose(host: unknown): void;
}

/** One line of the flow, as VS Code draws it after the line. */
export interface FlowLine {
  line: number;
  text: string;
}

/** A loop of the flow window: its control's line, and whether the debugger is in it. */
export interface FlowLoop {
  line: number;
  locationInside: boolean;
}

const DEBUG_TYPE = "codetracer-debug";

/**
 * What the value-origin path carries, as `{ command, value }`: each
 * `showValueOrigin` request with its expression, and each event the replay
 * sends the host's sessions. The WDIO suites observe it through the
 * extension's `registerPanelOverride` export; nothing in the product reads it.
 */
export interface ObservedMessage {
  command: string;
  value: unknown;
}

const observers: Set<(message: ObservedMessage) => void> = new Set();

/** Observe the value-origin traffic (test seam); dispose to stop. */
export function observeMessages(listener: (message: ObservedMessage) => void): vscode.Disposable {
  observers.add(listener);
  return { dispose: () => observers.delete(listener) };
}

function notifyObservers(message: ObservedMessage): void {
  for (const listener of [...observers]) {
    try {
      listener(message);
    } catch (err) {
      console.warn("[CodeTracer] message observer failed:", err);
    }
  }
}

let mod: HostModule | undefined;
let host: unknown;

/**
 * Load `media/vscode_host.js` and create the host. `false` when the bundle is
 * missing (a TypeScript-only build): the extension then registers its stub
 * commands, as it always has without the Nim build.
 */
export function startSessionHost(context: vscode.ExtensionContext): boolean {
  if (mod) {
    return true;
  }
  try {
    mod = require(path.join(context.extensionPath, "media", "vscode_host.js")) as HostModule;
    host = mod.ctHostCreate();
  } catch (err) {
    console.warn("[CodeTracer] vscode_host.js is not available:", err);
    mod = undefined;
    return false;
  }
  context.subscriptions.push(
    vscode.debug.onDidStartDebugSession((session) => {
      if (session.type === DEBUG_TYPE) {
        openSession(session);
      }
    }),
    vscode.debug.onDidChangeActiveDebugSession((session) => {
      if (session?.type === DEBUG_TYPE) {
        mod?.ctHostActivate(host, session.id);
      }
    }),
    vscode.debug.onDidTerminateDebugSession((session) => {
      if (session.type === DEBUG_TYPE) {
        mod?.ctHostCloseSession(host, session.id);
      }
    }),
    // The replay's events reach the host's session as they leave the adapter.
    vscode.debug.registerDebugAdapterTrackerFactory(DEBUG_TYPE, {
      createDebugAdapterTracker(session) {
        return {
          onDidSendMessage(message: any) {
            if (message?.type === "event") {
              mod?.ctHostDeliverEvent(host, session.id, message);
              if (observers.size > 0) {
                notifyObservers({ command: String(message.event), value: message.body });
              }
            }
          },
        };
      },
    }),
    { dispose: () => stopSessionHost() }
  );
  const active = vscode.debug.activeDebugSession;
  if (active?.type === DEBUG_TYPE) {
    openSession(active);
  }
  return true;
}

function openSession(session: vscode.DebugSession): void {
  const traceFolder = String(session.configuration?.traceFolder ?? "");
  mod?.ctHostOpenSession(host, session.id, traceFolder, (command, args) =>
    session.customRequest(command, args)
  );
  if (vscode.debug.activeDebugSession?.id === session.id) {
    mod?.ctHostActivate(host, session.id);
  }
}

export function stopSessionHost(): void {
  if (mod && host) {
    mod.ctHostDispose(host);
  }
  mod = undefined;
  host = undefined;
}

/**
 * Serve `webview` — one panel — a mirror of the active session. Disposing the
 * result stops serving it.
 */
export function attachWebview(webview: vscode.Webview): vscode.Disposable {
  if (!mod) {
    return { dispose() {} };
  }
  const module = mod;
  const channel = module.ctHostAttachWebview(host, (message) => {
    void webview.postMessage(message);
  });
  const received = webview.onDidReceiveMessage((data) => {
    module.ctHostDeliverFromWebview(channel, data);
  });
  return {
    dispose() {
      received.dispose();
      module.ctHostDetachWebview(host, channel);
    },
  };
}

/** Where `expression`'s value came from: the State pane's origin view. */
export function showValueOrigin(expression: string): boolean {
  notifyObservers({ command: "showValueOrigin", value: { expression } });
  if (!mod || !expression) {
    return false;
  }
  mod.ctHostShowValueOrigin(host, expression);
  return true;
}

/** Run a tracepoint logging `expression` at `filePath`:`line` (1-based). */
export function runTracepoint(filePath: string, line: number, expression: string): boolean {
  if (!mod) {
    return false;
  }
  mod.ctHostRunTracepoint(host, filePath, line, expression);
  return true;
}

/** Follow the active session's flow: its text per line and its loops. */
export function onFlowLines(
  listener: (filePath: string, lines: FlowLine[], loops: FlowLoop[]) => void
): void {
  mod?.ctHostOnFlowLines(host, listener);
}

/** The recording's source files, for debug session `id`'s file tree. */
export function setSourceFiles(id: string, paths: string[]): void {
  mod?.ctHostSetSourceFiles(host, id, paths);
}

/** Where a file opened in CodeTracer's file tree is shown. */
export function onOpenFile(listener: (filePath: string) => void): void {
  mod?.ctHostOnOpenFile(host, listener);
}

/** The editor shows `filePath`: the file tree follows it. */
export function revealFile(filePath: string): void {
  mod?.ctHostRevealFile(host, filePath);
}

/**
 * What "Add to Scratchpad" did (codetracer `entries/vscode_host`
 * `ScratchpadAddOutcome`): a local or watch was `added`, an expression was
 * `evaluated`, its evaluation failed and the scratchpad shows an `error` value,
 * or `noSession` is hosted so nothing was added.
 */
export type ScratchpadAddOutcome = "noSession" | "added" | "evaluated" | "error";

/**
 * Add `expression`'s value at the current stop to the scratchpad. A local or
 * watch of that name is added as the State pane shows it; anything else is
 * evaluated by the session host through the watch path. Resolves once with
 * the outcome and, for `error` / `noSession`, the reason.
 */
export function addToScratchpad(
  expression: string
): Promise<{ outcome: ScratchpadAddOutcome; detail: string }> {
  if (!mod) {
    return Promise.resolve({
      outcome: "noSession",
      detail: "the CodeTracer session host is not loaded",
    });
  }
  return new Promise((resolve) => {
    mod!.ctHostAddToScratchpad(host, expression, (outcome, detail) =>
      resolve({ outcome, detail })
    );
  });
}

/** The debug toolbar's history back (`back`) or forward. */
export function moveInHistory(back: boolean): void {
  mod?.ctHostHistory(host, back);
}

export function sessionHostAvailable(): boolean {
  return mod !== undefined;
}
