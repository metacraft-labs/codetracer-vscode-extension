/**
 * Tests for the marketing-command TCP listener.
 *
 * The listener is decoupled from the `vscode` module — the unit test
 * instantiates `MarketingListener` with a mock `CommandDispatcher`
 * and exercises the wire-protocol parsing layer.
 *
 * Run with `ts-node` (or compile to JS first and run with `node`).
 * The harness avoids the `vscode` import entirely so we don't need
 * a running VS Code instance.
 *
 * NOTE: This file lives under `test/` so it isn't picked up by the
 * extension's TypeScript build (which only includes `src/**`).
 */

import * as net from "net";
import * as assert from "assert";

// Hard-coded relative import — the test runner compiles this file
// alongside the production source via `tsc --noEmit`-style typecheck.
import { MarketingListener, makeVsCodeDispatcher, DEFAULT_MARKETING_PORT, MarketingFrame, CommandDispatcher }
  from "../src/marketing_listener";

function pickPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      if (typeof addr === "object" && addr) {
        const port = addr.port;
        s.close(() => resolve(port));
      } else {
        reject(new Error("failed to allocate test port"));
      }
    });
  });
}

function sendFrame(port: number, line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = net.createConnection({ host: "127.0.0.1", port }, () => {
      client.write(line);
      client.end();
    });
    client.on("end", () => resolve());
    client.on("error", reject);
  });
}

async function runTest(name: string, fn: () => Promise<void>) {
  process.stdout.write(`[test] ${name}... `);
  try {
    await fn();
    process.stdout.write("OK\n");
  } catch (err) {
    process.stdout.write("FAIL\n");
    console.error("  ", err);
    process.exitCode = 1;
    throw err;
  }
}

async function main() {
  // -------------------------------------------------------------------
  // Test 1 — wire parses a single newline-delimited frame and
  // routes it to the dispatcher with command + params intact.
  // -------------------------------------------------------------------
  await runTest("parses single frame", async () => {
    const port = await pickPort();
    const received: MarketingFrame[] = [];
    const dispatcher: CommandDispatcher = async (frame) => {
      received.push(frame);
    };
    const listener = new MarketingListener(dispatcher, () => {}, port);
    await listener.start();
    try {
      await sendFrame(port, JSON.stringify({
        command: "open_file",
        params: { path: "/tmp/x.ts", line: 3 },
      }) + "\n");
      // Allow the event loop to flush.
      await new Promise((r) => setTimeout(r, 80));
      assert.strictEqual(received.length, 1, "expected exactly one frame");
      assert.strictEqual(received[0].command, "open_file");
      assert.strictEqual(received[0].params.path, "/tmp/x.ts");
      assert.strictEqual(received[0].params.line, 3);
    } finally {
      await listener.stop();
    }
  });

  // -------------------------------------------------------------------
  // Test 2 — multiple frames in one TCP burst are split correctly.
  // -------------------------------------------------------------------
  await runTest("splits multiple frames on newlines", async () => {
    const port = await pickPort();
    const received: MarketingFrame[] = [];
    const listener = new MarketingListener(
      async (frame) => { received.push(frame); },
      () => {},
      port,
    );
    await listener.start();
    try {
      const a = JSON.stringify({ command: "step_over", params: {} });
      const b = JSON.stringify({ command: "continue", params: {} });
      const c = JSON.stringify({ command: "goto_line", params: { line: 7 } });
      await sendFrame(port, a + "\n" + b + "\n" + c + "\n");
      await new Promise((r) => setTimeout(r, 100));
      assert.strictEqual(received.length, 3);
      assert.deepStrictEqual(
        received.map((f) => f.command),
        ["step_over", "continue", "goto_line"]);
      assert.strictEqual(received[2].params.line, 7);
    } finally {
      await listener.stop();
    }
  });

  // -------------------------------------------------------------------
  // Test 3 — invalid frames are logged and skipped without crashing.
  // -------------------------------------------------------------------
  await runTest("rejects malformed frames without crashing", async () => {
    const port = await pickPort();
    const received: MarketingFrame[] = [];
    const errors: string[] = [];
    const listener = new MarketingListener(
      async (frame) => { received.push(frame); },
      (msg) => errors.push(msg),
      port,
    );
    await listener.start();
    try {
      // First frame is invalid JSON; second is valid.
      await sendFrame(port,
        "{not valid json\n" +
        JSON.stringify({ command: "step_over", params: {} }) + "\n");
      await new Promise((r) => setTimeout(r, 80));
      assert.strictEqual(received.length, 1,
        "valid frame must still be delivered");
      assert.strictEqual(received[0].command, "step_over");
      assert.ok(errors.some((e) => e.includes("invalid frame")),
        "logger should record the parse failure");
    } finally {
      await listener.stop();
    }
  });

  // -------------------------------------------------------------------
  // Test 4 — makeVsCodeDispatcher invokes the right command IDs
  // when given a mock `vscode` namespace.
  // -------------------------------------------------------------------
  await runTest("makeVsCodeDispatcher maps commands to vscode API", async () => {
    const executed: string[] = [];
    const openedPaths: string[] = [];
    const addedBreakpoints: Array<{ path: string; line: number }> = [];
    let revealedRange: { startLine: number } | undefined;

    class FakePosition {
      constructor(public line: number, public character: number) {}
    }
    class FakeRange {
      constructor(public start: FakePosition, public end: FakePosition) {}
    }
    class FakeSelection extends FakeRange {}
    class FakeLocation {
      public range: any;
      constructor(public uri: any, posOrRange: any) {
        // Mirror real vscode.Location: accept a Position and lift it
        // into a zero-length Range, otherwise pass through.
        if (posOrRange instanceof FakeRange) {
          this.range = posOrRange;
        } else {
          this.range = new FakeRange(posOrRange, posOrRange);
        }
      }
    }
    class FakeSourceBreakpoint {
      constructor(public location: FakeLocation, public enabled: boolean) {}
    }
    const fakeEditor: any = {
      selection: undefined as any,
      revealRange(r: FakeRange) {
        revealedRange = { startLine: r.start.line };
      },
    };
    const vscode: any = {
      commands: {
        executeCommand: async (id: string) => { executed.push(id); },
      },
      workspace: {
        openTextDocument: async (path: string) => {
          openedPaths.push(path);
          return { uri: { fsPath: path } };
        },
      },
      window: {
        activeTextEditor: fakeEditor,
        showTextDocument: async () => fakeEditor,
      },
      debug: {
        addBreakpoints: (bps: any[]) => {
          for (const bp of bps) {
            addedBreakpoints.push({
              path: bp.location.uri.fsPath ?? bp.location.uri,
              line: bp.location.range.start.line + 1,
            });
          }
        },
      },
      Uri: {
        file: (p: string) => ({ fsPath: p }),
      },
      Position: FakePosition,
      Range: FakeRange,
      Selection: FakeSelection,
      Location: FakeLocation,
      SourceBreakpoint: FakeSourceBreakpoint,
    };
    const dispatcher = makeVsCodeDispatcher(vscode);

    await dispatcher({ command: "open_file", params: { path: "/foo.ts", line: 5 } });
    assert.deepStrictEqual(openedPaths, ["/foo.ts"]);
    assert.strictEqual(revealedRange?.startLine, 4);

    await dispatcher({ command: "step_over", params: {} });
    await dispatcher({ command: "continue", params: {} });
    await dispatcher({ command: "focus_window", params: {} });
    assert.deepStrictEqual(executed, [
      "workbench.action.debug.stepOver",
      "workbench.action.debug.continue",
      "workbench.action.focusActiveEditorGroup",
    ]);

    await dispatcher({
      command: "set_breakpoint",
      params: { path: "/bar.ts", line: 11 },
    });
    assert.deepStrictEqual(addedBreakpoints, [{ path: "/bar.ts", line: 11 }]);

    await dispatcher({ command: "goto_line", params: { line: 9 } });
    assert.strictEqual((fakeEditor.selection as any).start.line, 8);

    try {
      await dispatcher({ command: "unknown", params: {} });
      assert.fail("unknown command must throw");
    } catch (err) {
      assert.ok(String(err).includes("unknown marketing command"));
    }
  });

  // -------------------------------------------------------------------
  // Test 5 — DEFAULT_MARKETING_PORT matches the GuiAssert client's
  // default (7117) so configuration drift is caught here.
  // -------------------------------------------------------------------
  await runTest("DEFAULT_MARKETING_PORT matches GuiAssert client", async () => {
    assert.strictEqual(DEFAULT_MARKETING_PORT, 7117);
  });
}

main().catch((err) => {
  console.error("test runner failure:", err);
  process.exit(1);
});
