/**
 * Marketing-command TCP listener.
 *
 * GuiAssert's `VsCodeClient` (in GuiAssert/src/gui_assert/driver.nim)
 * sends newline-delimited JSON frames over TCP. This module hosts the
 * server side: a 127.0.0.1-only TCP listener that decodes those
 * frames and invokes the corresponding VS Code commands.
 *
 * The listener is **off by default** so production users never expose
 * a localhost socket that could drive their editor. Set
 * `codetracer.marketingListenerEnabled = true` (declared in
 * package.json under contributes.configuration) to enable it.
 *
 * Frame format (newline-terminated JSON object):
 *
 *   { "command": "open_file", "params": { "path": "src/foo.ts" } }
 *
 * Supported commands:
 *   - open_file       params: { path: string, line?: number }
 *   - goto_line       params: { line: number }
 *   - set_breakpoint  params: { path: string, line: number }
 *   - step_over       params: {}
 *   - continue        params: {}
 *   - focus_window    params: {}
 *
 * Each command maps to either `vscode.commands.executeCommand(...)` or
 * `vscode.workspace.openTextDocument(...) + window.showTextDocument(...)`.
 *
 * ### Testability
 *
 * The transport layer (`MarketingListener` class) is decoupled from
 * `vscode`. It takes a `CommandDispatcher` callback in its constructor,
 * which the production wiring in `extension.ts` resolves to a thin
 * shim that calls into the real VS Code API. Tests pass a mock
 * dispatcher instead, so the parser and routing can be exercised
 * without a running VS Code instance.
 */

import * as net from "net";

/**
 * One decoded frame from the wire.
 */
export interface MarketingFrame {
  command: string;
  params: Record<string, unknown>;
}

/**
 * Callback invoked for each parsed frame. Returns a promise that
 * resolves when the command completes. Throwing rejects the
 * dispatcher's promise so the listener can log the failure.
 */
export type CommandDispatcher = (frame: MarketingFrame) => Promise<void>;

/**
 * Default port — must match GuiAssert's `VsCodeClient` default.
 */
export const DEFAULT_MARKETING_PORT = 7117;

/**
 * Maximum frame size before we forcibly close the connection.
 * Prevents a runaway client from hoarding memory.
 */
const MAX_FRAME_BYTES = 1024 * 1024; // 1 MiB

export class MarketingListener {
  private server: net.Server | undefined;
  private connections = new Set<net.Socket>();

  constructor(
    private readonly dispatcher: CommandDispatcher,
    private readonly logger: (msg: string) => void = console.log,
    private readonly port: number = DEFAULT_MARKETING_PORT,
  ) {}

  /**
   * Start listening on `127.0.0.1:<port>`. Idempotent — if already
   * listening, returns the existing port. Throws on bind failure.
   */
  start(): Promise<number> {
    if (this.server) {
      return Promise.resolve(this.port);
    }
    return new Promise((resolve, reject) => {
      const server = net.createServer((sock) => this.handleConnection(sock));
      server.on("error", (err) => {
        this.logger(`marketing listener error: ${err.message}`);
        reject(err);
      });
      server.listen(this.port, "127.0.0.1", () => {
        const addr = server.address();
        const actualPort = typeof addr === "object" && addr ? addr.port : this.port;
        this.logger(`marketing listener bound to 127.0.0.1:${actualPort}`);
        this.server = server;
        resolve(actualPort);
      });
    });
  }

  /**
   * Stop listening and close all active connections.
   */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      for (const sock of this.connections) {
        try {
          sock.destroy();
        } catch {
          // ignore
        }
      }
      this.connections.clear();
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => {
        this.server = undefined;
        resolve();
      });
    });
  }

  private handleConnection(sock: net.Socket): void {
    this.connections.add(sock);
    let buffer = "";
    sock.setEncoding("utf8");
    sock.on("data", async (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_FRAME_BYTES) {
        this.logger("marketing listener: frame too large, closing connection");
        sock.destroy();
        return;
      }
      // Split on newlines, keeping the trailing fragment in the buffer.
      let nlIndex: number;
      while ((nlIndex = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nlIndex);
        buffer = buffer.slice(nlIndex + 1);
        const trimmed = line.trim();
        if (trimmed.length === 0) {
          continue;
        }
        let frame: MarketingFrame | undefined;
        try {
          const parsed = JSON.parse(trimmed);
          if (typeof parsed !== "object" || parsed === null ||
              typeof parsed.command !== "string") {
            throw new Error("frame missing string 'command'");
          }
          frame = {
            command: parsed.command,
            params: (typeof parsed.params === "object" && parsed.params !== null)
              ? parsed.params as Record<string, unknown>
              : {},
          };
        } catch (err) {
          this.logger(`marketing listener: invalid frame: ${(err as Error).message}`);
          continue;
        }
        try {
          await this.dispatcher(frame);
        } catch (err) {
          this.logger(`marketing listener: dispatch failed for '${frame.command}': ` +
            (err as Error).message);
        }
      }
    });
    sock.on("close", () => {
      this.connections.delete(sock);
    });
    sock.on("error", (err) => {
      this.logger(`marketing listener socket error: ${err.message}`);
      this.connections.delete(sock);
    });
  }
}

/**
 * Build a default VS-Code-backed dispatcher. Imported lazily because
 * the unit test does not depend on the `vscode` module.
 *
 * The function is intentionally synchronous in its construction — the
 * `vscode` import is captured from the caller so test code can pass a
 * mock object instead of the real `vscode` namespace.
 */
export function makeVsCodeDispatcher(vscode: typeof import("vscode")): CommandDispatcher {
  return async (frame) => {
    switch (frame.command) {
      case "open_file": {
        const filePath = String(frame.params.path ?? "");
        if (!filePath) {
          throw new Error("open_file: missing 'path' param");
        }
        const doc = await vscode.workspace.openTextDocument(filePath);
        const editor = await vscode.window.showTextDocument(doc);
        const line = Number(frame.params.line);
        if (Number.isFinite(line) && line > 0) {
          const pos = new vscode.Position(line - 1, 0);
          editor.selection = new vscode.Selection(pos, pos);
          editor.revealRange(new vscode.Range(pos, pos));
        }
        break;
      }
      case "goto_line": {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          throw new Error("goto_line: no active editor");
        }
        const line = Number(frame.params.line);
        if (!Number.isFinite(line) || line <= 0) {
          throw new Error("goto_line: 'line' must be a positive integer");
        }
        const pos = new vscode.Position(line - 1, 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos));
        break;
      }
      case "set_breakpoint": {
        const filePath = String(frame.params.path ?? "");
        const line = Number(frame.params.line);
        if (!filePath || !Number.isFinite(line) || line <= 0) {
          throw new Error("set_breakpoint: requires 'path' and positive 'line'");
        }
        const uri = vscode.Uri.file(filePath);
        const loc = new vscode.Location(uri, new vscode.Position(line - 1, 0));
        vscode.debug.addBreakpoints([new vscode.SourceBreakpoint(loc, true)]);
        break;
      }
      case "step_over":
        await vscode.commands.executeCommand("workbench.action.debug.stepOver");
        break;
      case "continue":
        await vscode.commands.executeCommand("workbench.action.debug.continue");
        break;
      case "focus_window":
        await vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
        break;
      default:
        throw new Error(`unknown marketing command: ${frame.command}`);
    }
  };
}
