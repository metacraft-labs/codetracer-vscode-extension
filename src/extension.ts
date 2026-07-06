/// <reference path="../vscode.proposed.editorInsets.d.ts" />
import * as vscode from "vscode";
import {
  initPanels,
  disposePanels,
  disposeCommands,
  addTracepoint,
  addLoopPosition,
  forwardToEmbeddedPanels,
  _testRegisterPanelOverride,
  PostMessageTarget,
} from "./initPanels";
import * as utils from "./utils";
import * as os from "os";
import * as fs from "fs";
import { access, readFile, readdir, stat } from "fs/promises";
import * as path from 'path';
import { readCtfsMetaDat } from "./ctfs";
import {
  DapVsCodeApi,
  setupVsCodeExtensionViewsApi,
  newDapVsCodeApi,
  setupMiddlewareApis,
  ctSourceLineJump,
  ctAddToScratchpad,
  CtJumpBehaviour,
  LoadMode,
  getRecentTraces,
  getRecentTransactions,
  getTransactionTrace,
  getCurrentTrace,
  getFlowList,
  receive,
  computeFlowInsetData,
  TraceInfo,
  TransactionInfo,
  MediatorWithSubscribers,
} from "./ct_vscode.js";

const tracepointInsets = new Map<number, vscode.WebviewEditorInset>();
let flowInsetPath: string | undefined;
const flowInsets = new Map<number, vscode.WebviewEditorInset>();
let lastFlowLocation: unknown | undefined;
let ctStarted = false;
let adapterFactoryDisposable: vscode.Disposable | undefined;
let pendingLaunchPanels = false;
let panelsInitialized = false;

// CtEventKind values are defined in libs/codetracer/src/common/ct_event.nim.
const enum CtEventKind {
  CtCompleteMove = 8,
  CtLoadFlow = 56,
  CtUpdatedFlow = 57,
  InternalLastCompleteMove = 64,
}

const enum CtFlowMode {
  Call = 0,
  Diff = 1,
}

const FLOW_DECORATION_MAX_VALUES_PER_LINE = 10;
const FLOW_DECORATION_MAX_TEXT_LENGTH = 180;

type FlowValueMap = Record<string, any>;
type FlowLineValue = { line: number; text: string };
type FlowLoopSlider = {
  line: number;
  loopId: number;
  activeIteration: number;
  locationInside?: boolean;
};
type FlowInsetData = {
  lineValues?: FlowLineValue[];
  loopSliders?: FlowLoopSlider[];
};

interface FlowStep {
  position?: number;
  stepCount?: number;
  exprOrder?: string[];
  beforeValues?: FlowValueMap;
  afterValues?: FlowValueMap;
}

interface FlowViewUpdate {
  location?: { highLevelPath?: string; path?: string };
  steps?: FlowStep[];
  renderValueGroups?: any[][];
}

interface FlowUpdate {
  location?: { highLevelPath?: string; path?: string };
  viewUpdates?: Array<FlowViewUpdate | null | undefined> | Record<string, FlowViewUpdate | null | undefined>;
  error?: boolean;
}

interface CtLoadFlowArguments {
  flowMode: CtFlowMode;
  location: unknown;
}

let flowDecorationType: vscode.TextEditorDecorationType | undefined;
const flowLineValuesByPath = new Map<string, FlowLineValue[]>();
const flowLoopSlidersByPath = new Map<string, FlowLoopSlider[]>();
let internalLastCompleteMoveHandlerRegistered = false;
let lastFlowLocationKey: string | undefined;

interface TraceMetadata {
  workdir?: string;
  program?: string;
  args?: string[];
}

function ensureFlowDecorationType(): vscode.TextEditorDecorationType {
  if (!flowDecorationType) {
    flowDecorationType = vscode.window.createTextEditorDecorationType({
      after: {
        margin: "0 0 0 1rem",
        color: new vscode.ThemeColor("editorCodeLens.foreground"),
        fontStyle: "italic",
        backgroundColor: "rgba(128, 128, 128, 0.25)",
      },
    });
  }
  return flowDecorationType;
}

function normalizeFlowPath(rawPath?: string): string | undefined {
  if (!rawPath) {
    return undefined;
  }
  if (rawPath.startsWith("file://")) {
    return vscode.Uri.parse(rawPath).fsPath;
  }
  return path.normalize(rawPath);
}

function getFlowLocationKey(location: unknown): string | undefined {
  if (!location || typeof location !== "object") {
    return undefined;
  }

  const key = (location as { key?: unknown }).key;
  return typeof key === "string" && key.length > 0 ? key : undefined;
}

function sanitizeDecorationText(text: string): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (trimmed.length <= FLOW_DECORATION_MAX_TEXT_LENGTH) {
    return trimmed;
  }
  return `${trimmed.slice(0, FLOW_DECORATION_MAX_TEXT_LENGTH - 3)}...`;
}

function resolveFlowViewUpdates(update: FlowUpdate): FlowViewUpdate[] {
  const viewUpdates = update.viewUpdates;
  if (Array.isArray(viewUpdates)) {
    return viewUpdates.filter((item): item is FlowViewUpdate => Boolean(item));
  }
  if (viewUpdates && typeof viewUpdates === "object") {
    const values = Object.values(viewUpdates);
    return values.filter((item): item is FlowViewUpdate => Boolean(item));
  }
  return [];
}

function updateFlowValuesCache(update: FlowUpdate): void {
  if (!update || update.error) {
    return;
  }

  const viewUpdate = resolveFlowViewUpdates(update)[0];
  if (!viewUpdate) {
    return;
  }

  const pathKey = normalizeFlowPath(
    viewUpdate.location?.highLevelPath ??
    viewUpdate.location?.path ??
    update.location?.highLevelPath ??
    update.location?.path
  );
  if (!pathKey) {
    return;
  }

  let sourceLines: string[] = [];
  try {
    sourceLines = fs.readFileSync(pathKey, "utf8").split(/\r?\n/);
  } catch {
    return;
  }

  const insetData = computeFlowInsetData(
    update,
    sourceLines,
    FLOW_DECORATION_MAX_VALUES_PER_LINE
  ) as FlowInsetData | undefined;
  const lineValues = insetData?.lineValues;
  if (!Array.isArray(lineValues) || lineValues.length === 0) {
    flowLineValuesByPath.delete(pathKey);
  } else {
    flowLineValuesByPath.set(pathKey, lineValues);
  }

  const loopSliders = insetData?.loopSliders;
  if (!Array.isArray(loopSliders) || loopSliders.length === 0) {
    flowLoopSlidersByPath.delete(pathKey);
  } else {
    flowLoopSlidersByPath.set(pathKey, loopSliders);
  }
}

function applyFlowDecorationsForEditor(editor: vscode.TextEditor | undefined): void {
  if (!editor) {
    return;
  }

  const pathKey = normalizeFlowPath(editor.document.uri.fsPath);
  if (!pathKey) {
    return;
  }

  const lineValues = flowLineValuesByPath.get(pathKey);
  const decorationType = ensureFlowDecorationType();
  if (!lineValues || lineValues.length === 0) {
    editor.setDecorations(decorationType, []);
    return;
  }

  const lineCount = editor.document.lineCount;
  const decorations: vscode.DecorationOptions[] = [];
  for (const entry of lineValues) {
    const lineIndex = entry.line - 1; // Flow uses 1-based line numbers.
    if (lineIndex < 0 || lineIndex >= lineCount) {
      continue;
    }
    const text = sanitizeDecorationText(entry.text);
    if (!text) {
      continue;
    }
    const lineEnd = editor.document.lineAt(lineIndex).range.end;
    decorations.push({
      range: new vscode.Range(lineEnd, lineEnd),
      renderOptions: {
        after: {
          contentText: `  ${text}`,
        },
      },
    });
  }

  editor.setDecorations(decorationType, decorations);
}

function clearFlowDecorations(editor?: vscode.TextEditor): void {
  if (!flowDecorationType) {
    flowLineValuesByPath.clear();
    flowLoopSlidersByPath.clear();
    return;
  }
  if (editor) {
    editor.setDecorations(flowDecorationType, []);
  } else {
    for (const visibleEditor of vscode.window.visibleTextEditors) {
      visibleEditor.setDecorations(flowDecorationType, []);
    }
  }
  flowLineValuesByPath.clear();
  flowLoopSlidersByPath.clear();
}

function clearFlowInset(): void {
  for (const [, inset] of flowInsets) {
    inset.dispose();
  }
  flowInsets.clear();
  flowInsetPath = undefined;
}

function syncFlowInsetForEditor(
  context: vscode.ExtensionContext,
  viewsApi: MediatorWithSubscribers,
  editor: vscode.TextEditor | undefined
): void {
  if (!editor) {
    clearFlowInset();
    return;
  }

  const pathKey = normalizeFlowPath(editor.document.uri.fsPath);
  if (!pathKey) {
    clearFlowInset();
    return;
  }

  if (flowInsetPath && flowInsetPath !== pathKey) {
    clearFlowInset();
  }

  const sliders = flowLoopSlidersByPath.get(pathKey);
  if (!Array.isArray(sliders) || sliders.length === 0) {
    if (flowInsetPath === pathKey) {
      clearFlowInset();
    }
    return;
  }

  // Pin inset to the active loop line from shared loop metadata.
  const targetSlider = sliders.find((slider) => slider.locationInside) ?? sliders[0];
  const line = Math.max(0, targetSlider.line);
  const targetLine = Math.max(0, line - 1);

  if (flowInsets.has(line) && flowInsetPath === pathKey) {
    return;
  }

  clearFlowInset();
  const inset = addLoopPosition(context, viewsApi, editor, targetLine);
  flowInsets.set(line, inset);
  flowInsetPath = pathKey;

  // A new inset can miss the latest flow event while the webview initializes.
  // Re-request flow from the last known debugger location right after inset creation.
  if (lastFlowLocation) {
    setTimeout(() => emitCtLoadFlow(viewsApi, lastFlowLocation), 0);
    setTimeout(() => emitCtLoadFlow(viewsApi, lastFlowLocation), 60);
  }
}

function emitCtLoadFlow(viewsApi: MediatorWithSubscribers, location: unknown): void {
  // Avoid sending when the debug session is not ready (prevents customRequest undefined).
  const session = vscode.debug.activeDebugSession;
  if (!session || session.type !== "codetracer-debug" || typeof session.customRequest !== "function") {
    return;
  }
  const args: CtLoadFlowArguments = {
    flowMode: CtFlowMode.Call,
    location,
  };
  receive(viewsApi, CtEventKind.CtLoadFlow, args, viewsApi.asSubscriber);
}

function registerFlowDecorationHandlers(
  context: vscode.ExtensionContext,
  dapApi: DapVsCodeApi,
  viewsApi: MediatorWithSubscribers
): void {
  if (!Array.isArray(dapApi.handlers)) {
    return;
  }
  if (!dapApi.handlers[CtEventKind.CtUpdatedFlow] || !dapApi.handlers[CtEventKind.CtCompleteMove]) {
    return;
  }

  if (
    !internalLastCompleteMoveHandlerRegistered &&
    Array.isArray(viewsApi.handlers) &&
    Array.isArray(viewsApi.handlers[CtEventKind.InternalLastCompleteMove])
  ) {
    viewsApi.handlers[CtEventKind.InternalLastCompleteMove].push((_kind: number, _value: unknown, _sub: unknown) => {
      if (!lastFlowLocation) {
        return;
      }
      emitCtLoadFlow(viewsApi, lastFlowLocation);
      setTimeout(() => emitCtLoadFlow(viewsApi, lastFlowLocation), 50);
    });
    internalLastCompleteMoveHandlerRegistered = true;
  }

  // Track flow updates as they arrive from the DAP so we can decorate immediately.
  dapApi.handlers[CtEventKind.CtUpdatedFlow].push((_kind: number, update: FlowUpdate, _sub: any) => {
    lastFlowLocationKey = getFlowLocationKey(update?.location) ?? lastFlowLocationKey;
    updateFlowValuesCache(update);
    const activeEditor = vscode.window.activeTextEditor;
    applyFlowDecorationsForEditor(activeEditor);
    syncFlowInsetForEditor(context, viewsApi, activeEditor);
  });

  // Same-function moves should reuse the current flow shape; reloading on every step
  // shrinks loop iteration metadata to the current position and resets the slider.
  dapApi.handlers[CtEventKind.CtCompleteMove].push((_kind: number, response: { location?: unknown }) => {
    if (response?.location) {
      const nextLocationKey = getFlowLocationKey(response.location);
      const shouldReloadFlow =
        !nextLocationKey ||
        !lastFlowLocationKey ||
        nextLocationKey !== lastFlowLocationKey;

      lastFlowLocation = response.location;
      lastFlowLocationKey = nextLocationKey ?? lastFlowLocationKey;

      if (shouldReloadFlow) {
        emitCtLoadFlow(viewsApi, response.location);
      }
    }
  });
}

// Value Origin Tracking (M6, spec §8.2) — message commands used by the
// extension → embedded-webview post-message bridge. These constants are
// shared between the command handler and the DAP-event forwarder so the
// embedded panels can route them through one router on their side.
//
// `SHOW_VALUE_ORIGIN_COMMAND` is what `ct-vscode.showValueOrigin` emits;
// the embedded `StateVM.onShowOrigin` listens for it.
//
// `UPDATED_ORIGIN_CHAIN_EVENT` is the DAP event the db-backend emits as a
// lazy continuation alongside the canonical `ct/originChain` response
// (spec §5.2). The TypeScript side does not parse the body — it just
// hands the entire event payload over to the embedded webview, which
// already knows how to merge the update into `OriginChainVM`.
const SHOW_VALUE_ORIGIN_COMMAND = "showValueOrigin";
const UPDATED_ORIGIN_CHAIN_EVENT = "ct/updated-origin-chain";

/**
 * Resolve the expression to query for "Show Value Origin" from the active
 * editor. Mirrors the heuristic used by `ct-vscode.addToScratchpad`:
 *
 *   1. If the user has a non-empty selection, use the selected text verbatim
 *      (this is the path the `editor/context` menu entry takes when the
 *      `editorHasSelection` clause matches).
 *   2. Otherwise fall back to the word range under the cursor — the same
 *      thing VS Code's "F2 to rename" / "Ctrl+click" features use, so the
 *      gesture matches user expectation.
 *   3. If neither resolves, return `undefined` so the caller can decide
 *      whether to bail or forward an empty payload (the side-panel itself
 *      will then prompt for an expression).
 */
function resolveValueOriginExpression(
  editor: vscode.TextEditor | undefined
): { expression: string; location: { path: string; line: number; column: number } } | undefined {
  if (!editor) {
    return undefined;
  }

  const selection = editor.selection;
  let expression = "";
  if (!selection.isEmpty) {
    expression = editor.document.getText(selection).trim();
  }
  if (expression.length === 0) {
    const wordRange = editor.document.getWordRangeAtPosition(selection.active);
    if (wordRange) {
      expression = editor.document.getText(wordRange).trim();
    }
  }
  if (expression.length === 0) {
    return undefined;
  }

  // Use 1-based line numbers to match the convention used everywhere in the
  // CodeTracer DAP protocol (see `ctSourceLineJump`'s `selection.active.line + 1`).
  return {
    expression,
    location: {
      path: editor.document.uri.fsPath,
      line: selection.active.line + 1,
      column: selection.active.character + 1,
    },
  };
}

function inferValueOriginExpressionFromLine(
  editor: vscode.TextEditor | undefined
): { expression: string; location: { path: string; line: number; column: number } } | undefined {
  if (!editor) {
    return undefined;
  }

  const lines = editor.document.getText().split(/\r?\n/);
  const patterns: RegExp[] = [
    /\bprint\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/,
    /\bconsole\.log\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/,
    /\bputs\s+([A-Za-z_][A-Za-z0-9_]*)\b/,
    /\bprintln!\s*\([^)]*,\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/,
    /\bprintf\s*\([^)]*,\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/,
  ];

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    for (const pattern of patterns) {
      const match = line.match(pattern);
      const expression = match?.[1]?.trim();
      if (expression) {
        const column = line.indexOf(expression) + 1;
        return {
          expression,
          location: {
            path: editor.document.uri.fsPath,
            line: lineIndex + 1,
            column: column > 0 ? column : 1,
          },
        };
      }
    }
  }

  return undefined;
}

function shouldUseInferredOriginExpression(
  editor: vscode.TextEditor | undefined,
  resolved: { expression: string; location: { path: string; line: number; column: number } } | undefined
): boolean {
  if (!editor || !resolved) {
    return true;
  }
  if (!editor.selection.isEmpty) {
    return false;
  }
  const line = editor.document.lineAt(editor.selection.active.line).text.trim();
  return line.startsWith("//") || line.startsWith("#") || line.length === 0;
}

type ValueOriginResolvedExpression = {
  expression: string;
  location: { path: string; line: number; column: number };
};

function currentOriginStepId(): number {
  const location = lastFlowLocation as { rrTicks?: unknown } | undefined;
  return typeof location?.rrTicks === "number" ? location.rrTicks : -1;
}

function isResolvedValueOriginExpression(value: unknown): value is ValueOriginResolvedExpression {
  const candidate = value as ValueOriginResolvedExpression;
  return (
    typeof candidate?.expression === "string" &&
    candidate.expression.length > 0 &&
    typeof candidate.location?.path === "string" &&
    typeof candidate.location?.line === "number" &&
    typeof candidate.location?.column === "number"
  );
}

function valueOriginHoverProvider(): vscode.HoverProvider {
  return {
    provideHover(document, position) {
      const range = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
      if (!range) {
        return undefined;
      }
      const expression = document.getText(range).trim();
      if (!expression) {
        return undefined;
      }
      const payload: ValueOriginResolvedExpression = {
        expression,
        location: {
          path: document.uri.fsPath,
          line: position.line + 1,
          column: position.character + 1,
        },
      };
      const args = encodeURIComponent(JSON.stringify([payload]));
      const contents = new vscode.MarkdownString(`[↑ origin](command:ct-vscode.showValueOrigin?${args})`);
      contents.isTrusted = { enabledCommands: ["ct-vscode.showValueOrigin"] };
      return new vscode.Hover(contents, range);
    },
  };
}

/**
 * Handler for `ct-vscode.showValueOrigin` (M6, spec §8.2).
 *
 * Resolves the variable/expression from the active editor, then forwards
 * the request into every embedded CodeTracer panel via the existing
 * `panel.webview.postMessage(...)` bridge. The embedded `StateVM` listens
 * for `command: "showValueOrigin"` and dispatches the actual
 * `ct/originChain` DAP request itself — the extension intentionally does
 * not own that DAP round-trip (no logic duplication between host and
 * embedded panels).
 *
 * Returns the number of panels the message was delivered to, so the test
 * suite can assert the forwarding actually fired even when the embedded
 * panels haven't fully mounted yet.
 */
async function showValueOriginHandler(explicit?: unknown): Promise<number> {
  const editor = vscode.window.activeTextEditor;
  let resolved = isResolvedValueOriginExpression(explicit)
    ? explicit
    : resolveValueOriginExpression(editor);
  if (shouldUseInferredOriginExpression(editor, resolved)) {
    resolved = inferValueOriginExpressionFromLine(editor) ?? resolved;
  }
  const message = {
    command: SHOW_VALUE_ORIGIN_COMMAND,
    value: resolved ?? { expression: "", location: null },
  };
  const delivered = forwardToEmbeddedPanels(message);
  if (delivered === 0) {
    console.warn(
      "[CodeTracer] ct-vscode.showValueOrigin: no embedded panels available; " +
      "the message was not delivered. Start a CodeTracer debug session first."
    );
  }

  const session = vscode.debug.activeDebugSession;
  if (session?.type === "codetracer-debug" && resolved?.expression) {
    try {
      const chain = await session.customRequest("ct/originChain", {
        variableName: resolved.expression,
        variable_name: resolved.expression,
        variablePath: [],
        variable_path: [],
        frameId: -1,
        frame_id: -1,
        stepId: currentOriginStepId(),
        step_id: currentOriginStepId(),
        threadId: 0,
        thread_id: 0,
        maxHops: 16,
        max_hops: 16,
        lazy: false,
        continuationToken: null,
        continuation_token: null,
        sessionId: "",
        session_id: "",
        classifySource: true,
        classify_source: true,
      });
      forwardToEmbeddedPanels({
        command: UPDATED_ORIGIN_CHAIN_EVENT,
        value: chain,
      });
    } catch (err) {
      console.warn("[CodeTracer] ct-vscode.showValueOrigin: ct/originChain failed:", err);
    }
  }
  return delivered;
}

/// Candidate file names for an executable, accounting for the Windows `.exe`
/// suffix. The bare name is tried first so POSIX layouts keep working.
function executableCandidates(binaryName: string): string[] {
  if (process.platform === 'win32') {
    // On Windows, prefer the `.exe` variant but also accept extension-less
    // files (some toolchains ship wrapper scripts without an extension).
    return [`${binaryName}.exe`, binaryName];
  }
  return [binaryName];
}

/// Locate a binary by name in the system PATH.
/// Returns the absolute path if found, or undefined otherwise.
///
/// This is implemented purely with `fs` lookups (no shell-out) so it works
/// identically on Windows, macOS and Linux. The Nix dev shell / direnv
/// environment and the Windows `env.ps1` both place the CodeTracer binaries
/// on PATH, so a PATH scan is sufficient.
function findInPath(binaryName: string): string | undefined {
  const pathVar = process.env.PATH ?? '';
  const segments = pathVar.split(path.delimiter).filter(Boolean);
  const names = executableCandidates(binaryName);
  for (const segment of segments) {
    for (const name of names) {
      const candidate = path.join(segment, name);
      try {
        const st = fs.statSync(candidate);
        if (st.isFile()) {
          return candidate;
        }
      } catch {
        // not here; keep scanning
      }
    }
  }
  return undefined;
}

/// Names of the DAP replay server binary, newest first.
///
/// The replay backend was historically called `db-backend`; the Phase 4
/// naming alignment in the codetracer repo renamed the on-disk binary to
/// `replay-server` (see codetracer/src/db-backend/Cargo.toml and
/// src/common/paths.nim `dbBackendExe`). We accept both so the extension
/// works against old and new CodeTracer builds.
const DAP_SERVER_BINARY_NAMES = ['replay-server', 'db-backend'] as const;

/// Locate the directory containing the CodeTracer backend binaries
/// (`replay-server`, `ct`, …).
function getBackendBinPath(context: vscode.ExtensionContext): string {
  // If runnablePath is set (e.g. /path/to/codetracer/src/build-debug/bin/ct),
  // derive the backend bin directory from it — the replay server lives in the
  // same dir.
  const cfg = vscode.workspace.getConfiguration('codetracer');
  const runnablePath = cfg.get<string>('runnablePath')?.trim();
  if (runnablePath) {
    return path.dirname(runnablePath);
  }
  // Try to find the replay server or ct in PATH (set up by direnv / nix dev
  // shells on POSIX, or env.ps1 on Windows).
  for (const name of DAP_SERVER_BINARY_NAMES) {
    const inPath = findInPath(name);
    if (inPath) {
      return path.dirname(inPath);
    }
  }
  const ctInPath = findInPath('ct');
  if (ctInPath) {
    return path.dirname(ctInPath);
  }
  // Fallback: bundled layout (extension ships with libs/codetracer/)
  return path.join(
    context.extensionPath,
    'libs',
    'codetracer',
    'src',
    'build-debug',
    'bin'
  );
}

/// Resolve the absolute path to the DAP replay server executable.
///
/// Looks inside the backend bin directory for `replay-server` (current) or
/// `db-backend` (legacy), trying the platform-specific executable suffixes.
/// Falls back to a `replay-server` path in the bin directory so the
/// DebugAdapterExecutable still produces a meaningful spawn error if the
/// binary is genuinely missing.
function resolveDapServerPath(context: vscode.ExtensionContext): string {
  const binDir = getBackendBinPath(context);
  for (const name of DAP_SERVER_BINARY_NAMES) {
    for (const candidateName of executableCandidates(name)) {
      const candidate = path.join(binDir, candidateName);
      try {
        if (fs.statSync(candidate).isFile()) {
          return candidate;
        }
      } catch {
        // keep looking
      }
    }
  }
  // Also consult PATH directly — getBackendBinPath may have fallen back to the
  // bundled layout while the binary actually lives elsewhere on PATH.
  for (const name of DAP_SERVER_BINARY_NAMES) {
    const inPath = findInPath(name);
    if (inPath) {
      return inPath;
    }
  }
  // Last resort: a (possibly non-existent) path so the spawn error is clear.
  const fallbackName = process.platform === 'win32'
    ? `${DAP_SERVER_BINARY_NAMES[0]}.exe`
    : DAP_SERVER_BINARY_NAMES[0];
  return path.join(binDir, fallbackName);
}

function makeEnvWithBackend(context: vscode.ExtensionContext): NodeJS.ProcessEnv {
  const backendBin = getBackendBinPath(context);
  const rrEnv = resolveRrEnvironment();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...rrEnv,
    PATH: `${backendBin}${path.delimiter}${process.env.PATH ?? ''}`,
  };

  // Prepend the backend bin dir using the platform PATH delimiter so the
  // replay server can locate its sibling binaries (recorders, rr, ...).
  if (process.platform === 'darwin') {
    env.DYLD_LIBRARY_PATH = `${backendBin}${path.delimiter}${process.env.DYLD_LIBRARY_PATH ?? ''}`;
  } else if (process.platform !== 'win32') {
    env.LD_LIBRARY_PATH = `${backendBin}${path.delimiter}${process.env.LD_LIBRARY_PATH ?? ''}`;
  }
  return env;
}

function normalizeEnv(env: NodeJS.ProcessEnv): { [key: string]: string } {
  const out: { [key: string]: string } = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

// `findExecutableInPath` was a near-duplicate of `findInPath` that used an
// `X_OK` access check; that check is unreliable for Windows `.exe` files, so
// callers now use `findInPath`, which scans PATH with the correct
// platform-specific executable suffixes.

function resolveRrEnvironment(): NodeJS.ProcessEnv {
  const cfg = vscode.workspace.getConfiguration('codetracer');
  const rrWorkerPath = cfg.get<string>('rrWorkerPath')?.trim() ?? "";
  const rrExePath = cfg.get<string>('rrExePath')?.trim() ?? "";
  const env: NodeJS.ProcessEnv = {};

  if (rrWorkerPath) {
    const rrSupportDir = path.dirname(rrWorkerPath);
    if (!process.env.CT_RR_SUPPORT_BINARIES_PATH) {
      env.CT_RR_SUPPORT_BINARIES_PATH = rrSupportDir;
    }
    if (!rrExePath) {
      const siblingRr = path.join(rrSupportDir, "rr");
      try {
        fs.accessSync(siblingRr, fs.constants.X_OK);
        env.CT_RR_EXE = siblingRr;
      } catch {
        // ignore; will fall back to PATH
      }
    }
  }

  if (rrExePath) {
    env.CT_RR_EXE = rrExePath;
  }

  return env;
}

function hasNargoToml(dirPath: string): boolean {
  return fs.existsSync(path.join(dirPath, "Nargo.toml"));
}

function findNargoRoot(startDir: string, stopDir?: string): string | undefined {
  let current = path.resolve(startDir);
  const stop = stopDir ? path.resolve(stopDir) : undefined;
  while (true) {
    if (hasNargoToml(current)) {
      return current;
    }
    if (stop && current === stop) {
      return undefined;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

function findRubyProjectRoot(startDir: string, stopDir?: string): string | undefined {
  let current = path.resolve(startDir);
  const stop = stopDir ? path.resolve(stopDir) : undefined;
  while (true) {
    if (fs.existsSync(path.join(current, "Gemfile"))) {
      return current;
    }
    if (fs.existsSync(path.join(current, "Rakefile"))) {
      return current;
    }
    if (fs.existsSync(path.join(current, "config.ru"))) {
      return current;
    }
    const gemspecs = fs.readdirSync(current).filter((entry: string) => entry.endsWith(".gemspec"));
    if (gemspecs.length > 0) {
      return current;
    }
    if (stop && current === stop) {
      return undefined;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

function isRubySourceFile(filePath: string): boolean {
  if (!fs.existsSync(filePath)) {
    return false;
  }
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      return false;
    }
  } catch {
    return false;
  }

  if (filePath.endsWith(".rb")) {
    return true;
  }

  try {
    const content = fs.readFileSync(filePath, "utf8");
    const firstLine = content.split(/\r?\n/, 1)[0] ?? "";
    return firstLine.includes("ruby");
  } catch {
    return false;
  }
}

function isRrSourceFile(filePath: string, languageId: string): boolean {
  if (["c", "cpp", "rust", "nim"].includes(languageId)) {
    return true;
  }
  const ext = path.extname(filePath).toLowerCase();
  return [".c", ".cc", ".cpp", ".cxx", ".rs", ".nim"].includes(ext);
}

/**
 * Detect BEAM-language source files (Elixir + Erlang) for the
 * codetracer-beam-recorder dispatch path. Used by the future "Record current
 * file" command on .ex/.exs/.erl/.hrl files; M15 introduces only the
 * predicate so language detection is consistent with package.json's
 * debuggers.languages registration. Source-of-truth for the recorder pipeline
 * (Mix vs. raw erlc compilation) lives in
 * codetracer-beam-recorder/scripts/prepare-beam-fixtures.sh.
 */
function isBeamSourceFile(filePath: string, languageId: string): boolean {
  if (["elixir", "erlang"].includes(languageId)) {
    return true;
  }
  const ext = path.extname(filePath).toLowerCase();
  return [".ex", ".exs", ".erl", ".hrl"].includes(ext);
}

function isRrTraceFolder(traceFolder: string): boolean {
  return fs.existsSync(path.join(traceFolder, "rr"));
}

function findRubyEntryPoint(startDir: string, stopDir: string | undefined, fallbackFile: string): string {
  const root = findRubyProjectRoot(startDir, stopDir) ?? startDir;
  const projectName = path.basename(root);
  const candidates = [
    path.join(root, "bin", "rails"),
    path.join(root, "config.ru"),
    path.join(root, "bin", projectName),
    path.join(root, "main.rb"),
    path.join(root, "app.rb"),
    path.join(root, "lib", `${projectName}.rb`),
  ];

  // Prefer conventional Ruby entrypoints that point to Ruby source.
  for (const candidate of candidates) {
    if (isRubySourceFile(candidate)) {
      return candidate;
    }
  }

  return isRubySourceFile(fallbackFile) ? fallbackFile : fallbackFile;
}

async function runCurrent(codetracerExe: string, isNixOS: boolean): Promise<string | undefined> {
  const trace: TraceInfo | undefined = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Preparing trace file...",
      cancellable: false,
    },
    async () => {
      if (vscode.window.activeTextEditor) {
        const editor = vscode.window.activeTextEditor;
        const filePath = editor.document.uri.fsPath;
        const isNoirFile = editor.document.languageId === "noir" || filePath.endsWith(".nr");
        const isRubyFile = editor.document.languageId === "ruby" || filePath.endsWith(".rb");
        const isRrFile = isRrSourceFile(filePath, editor.document.languageId);
        // BEAM (Elixir/Erlang) source files use the full file path so the
        // recorder can locate the surrounding Mix/rebar3 project. Detection
        // matches the languages registered in package.json.debuggers.languages.
        const isBeamFile = isBeamSourceFile(filePath, editor.document.languageId);
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
        const workspaceRoot = workspaceFolder?.uri.fsPath;

        if (isRubyFile) {
          const startDir = path.dirname(filePath);
          const entryPoint = findRubyEntryPoint(startDir, workspaceRoot, filePath);
          return await getCurrentTrace(codetracerExe, entryPoint, isNixOS);
        }

        if (!isNoirFile) {
          if (isRrFile) {
            // RR-based recordings need the full source file path.
            return await getCurrentTrace(codetracerExe, filePath, isNixOS);
          }
          if (isBeamFile) {
            // BEAM materialized recordings (Elixir/Erlang) need the file
            // path so prepare-beam-fixtures.sh / Mix can locate the project.
            return await getCurrentTrace(codetracerExe, filePath, isNixOS);
          }
          const rootPath = workspaceRoot ?? vscode.workspace.workspaceFolders?.[0].uri.fsPath;
          if (rootPath) {
            return await getCurrentTrace(codetracerExe, rootPath, isNixOS);
          }
          vscode.window.showErrorMessage("No workspace found for the active file.");
          return;
        }

        const startDir = path.dirname(filePath);

        if (hasNargoToml(startDir)) {
          return await getCurrentTrace(codetracerExe, startDir, isNixOS);
        }

        const action = await vscode.window.showWarningMessage(
          "No Nargo.toml found in the current file's folder. Search parent folders?",
          "Search Upwards", "Cancel"
        );
        if (action !== "Search Upwards") {
          vscode.window.showInformationMessage("Select a Noir file and try again.");
          return;
        }

        const nargoRoot = findNargoRoot(startDir, workspaceRoot);
        if (!nargoRoot) {
          vscode.window.showErrorMessage("No Nargo.toml found in parent folders.");
          return;
        }

        return await getCurrentTrace(codetracerExe, nargoRoot, isNixOS);
      }
      else {
        vscode.window.showErrorMessage("No active text editor!");
      }
    }
  );

  return trace?.outputFolder;
}

async function recordTraceForWorkdir(
  codetracerExe: string,
  workDir: string,
  isNixOS: boolean,
  progressTitle: string
): Promise<TraceInfo | undefined> {
  return await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: progressTitle,
      cancellable: false,
    },
    async () => {
      return await getCurrentTrace(codetracerExe, workDir, isNixOS);
    }
  );
}

async function initPanelsIfNeeded(context: vscode.ExtensionContext, viewsApi: MediatorWithSubscribers): Promise<void> {
  if (panelsInitialized) {
    return;
  }
  // Mark initialised up-front so a second debug-session start while the
  // sequential panel creation is still in flight does not create panels twice.
  panelsInitialized = true;
  const panels = await initPanels(context, viewsApi);
  (vscode.window as any).panels = panels; // easier debugging
}

async function loadFlow() {

}

function resolveTraceFileCopyPath(traceFolder: string, originalPath: string): string {
  const filesRoot = path.join(traceFolder, "files");
  if (path.isAbsolute(originalPath)) {
    const strippedRoot = path.relative(path.parse(originalPath).root, originalPath);
    return path.join(filesRoot, strippedRoot);
  }
  return path.join(filesRoot, originalPath);
}

async function readTraceMetadata(traceFolder: string): Promise<TraceMetadata | undefined> {
  // Trace metadata format: https://github.com/metacraft-labs/CodeTracer/blob/main/libs/runtime_tracing/docs/trace_json_spec.md
  const metadataPath = path.join(traceFolder, "trace_metadata.json");
  try {
    const raw = await readFile(metadataPath, "utf8");
    const parsed = JSON.parse(raw) as TraceMetadata;
    return parsed ?? undefined;
  } catch {
    return undefined;
  }
}

async function readTracePaths(traceFolder: string): Promise<string[]> {
  // Trace paths format: https://github.com/metacraft-labs/CodeTracer/blob/main/libs/runtime_tracing/docs/trace_json_spec.md
  const pathsFile = path.join(traceFolder, "trace_paths.json");
  try {
    const raw = await readFile(pathsFile, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Heuristic: does a path look like recorder runtime/stdlib source rather
 * than user code? Recorders intern stdlib files (e.g. the Ruby/Python
 * standard library, language runtime) alongside the user's program. When
 * picking a file to surface in the editor we prefer the user's own code.
 */
function looksLikeRuntimeSource(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  return (
    normalized.includes("/lib/ruby/") ||
    normalized.includes("/site-packages/") ||
    normalized.includes("/lib/python") ||
    normalized.includes("/gems/") ||
    /\/nix\/store\//.test(normalized) ||
    normalized.includes("/runtime/")
  );
}

async function findFirstTraceSourceFile(traceFolder: string): Promise<string | undefined> {
  // Prefer explicit program paths, then trace paths, then any bundled file copy.
  const candidates: string[] = [];

  // Current CTFS-only recorders carry the source file list inside the
  // `.ct` container's binary `meta.dat`; the legacy JSON sidecars
  // (trace_metadata.json / trace_paths.json) are no longer written.
  // Read the container first and surface the user's program, then any
  // remaining (non-runtime) source paths it references.
  const ctfsMeta = readCtfsMetaDat(traceFolder);
  if (ctfsMeta) {
    if (ctfsMeta.program) {
      const programPath = ctfsMeta.workdir && !path.isAbsolute(ctfsMeta.program)
        ? path.join(ctfsMeta.workdir, ctfsMeta.program)
        : ctfsMeta.program;
      candidates.push(programPath);
    }
    const userPaths = ctfsMeta.paths.filter((p) => !looksLikeRuntimeSource(p));
    const runtimePaths = ctfsMeta.paths.filter((p) => looksLikeRuntimeSource(p));
    candidates.push(...userPaths, ...runtimePaths);
  }

  // Legacy JSON-sidecar traces (trace_metadata.json / trace_paths.json).
  const metadata = await readTraceMetadata(traceFolder);
  if (metadata?.program) {
    const programPath = metadata.workdir && !path.isAbsolute(metadata.program)
      ? path.join(metadata.workdir, metadata.program)
      : metadata.program;
    candidates.push(programPath);
  }

  const tracePaths = await readTracePaths(traceFolder);
  candidates.push(...tracePaths);

  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile()) {
        return candidate;
      }
    } catch {
      // ignore missing files on disk
    }

    const traceCopy = resolveTraceFileCopyPath(traceFolder, candidate);
    try {
      const stat = fs.statSync(traceCopy);
      if (stat.isFile()) {
        return traceCopy;
      }
    } catch {
      // ignore missing trace copies
    }
  }

  // Fall back to any file in the trace bundle if no direct path resolves.
  const filesRoot = path.join(traceFolder, "files");
  const pending: string[] = [filesRoot];
  let visited = 0;
  while (pending.length > 0 && visited < 5000) {
    const current = pending.shift();
    if (!current) {
      continue;
    }
    visited += 1;
    try {
      const entries = await readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        const entryPath = path.join(current, entry.name);
        if (entry.isFile()) {
          return entryPath;
        }
        if (entry.isDirectory()) {
          pending.push(entryPath);
        }
      }
    } catch {
      // ignore unreadable directories
    }
  }

  return undefined;
}

async function openTraceSourceFile(traceFolder: string): Promise<boolean> {
  // Ensure "Load recent trace" brings up a source file even if no editor is open.
  const candidate = await findFirstTraceSourceFile(traceFolder);
  if (!candidate) {
    return false;
  }
  try {
    const document = await vscode.workspace.openTextDocument(candidate);
    await vscode.window.showTextDocument(document, { preview: true });
    return true;
  } catch {
    return false;
  }
}

async function pickTraceFolder(codetracerExe: string, isNixOS: boolean): Promise<string | undefined> {
  const recentTraces: TraceInfo[] | undefined = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Loading recent traces...",
      cancellable: false,
    },
    async () => {
      return await getRecentTraces(codetracerExe, isNixOS);
    }
  );
  if (!recentTraces || recentTraces.length === 0) {
    vscode.window.showWarningMessage("No recent trace folders found.");
    return;
  }

  const options = recentTraces
    .filter(trace => fs.existsSync(trace.outputFolder))
    .map(trace => {
      const folderName = trace.program;
      return {
        label: folderName,
        description: trace.outputFolder,
        fullPath: trace.outputFolder
      };
    });

  const picked = await vscode.window.showQuickPick(options, {
    placeHolder: "Select a trace folder to use",
    canPickMany: false
  });

  return picked?.fullPath;
}

async function pickTxFolder(codetracerExe: string, isNixOS: boolean): Promise<string | undefined> {
  const recentTransactions: TransactionInfo[] | undefined = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Loading recent transactions...",
      cancellable: false,
    },
    async () => {
      return await getRecentTransactions(codetracerExe, isNixOS);
    }
  );

  if (!recentTransactions || recentTransactions.length === 0) {
    vscode.window.showWarningMessage("No recent transactions found.");
    return;
  }

  const options = recentTransactions
    .map(trace => {
      const folderName = trace.toAddress;
      return {
        label: folderName,
        description: trace.toAddress,
        txHash: trace.txHash
      };
    });

  const picked = await vscode.window.showQuickPick(options, {
    placeHolder: "Select a transaction to use",
    canPickMany: false
  });

  if (picked) {
    let trace: TraceInfo | undefined = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Loading trace for transaction...",
        cancellable: false,
      },
      async () => {
        return await getTransactionTrace(codetracerExe, picked.txHash, isNixOS);
      }
    );
    return trace?.outputFolder;
  }

  return undefined;
}

async function toggleCt(context: vscode.ExtensionContext, dapVsCodeApi: DapVsCodeApi, viewsApi: MediatorWithSubscribers, codetracerExe: string, loadMode: LoadMode) {
  if (ctStarted) {
    // Stop CT
    ctStarted = false;

    disposePanels();
    disposeCommands();
    panelsInitialized = false;

    for (const [line, inset] of tracepointInsets) {
      inset.dispose();
      tracepointInsets.delete(line);
    }

    clearFlowDecorations();
    clearFlowInset();
    lastFlowLocation = undefined;
    internalLastCompleteMoveHandlerRegistered = false;

    adapterFactoryDisposable?.dispose();
    adapterFactoryDisposable = undefined;

    if (vscode.debug.activeDebugSession?.type === "codetracer-debug") {
      await vscode.commands.executeCommand("workbench.action.debug.stop");
    }

    // Toggle off context menu functions
    vscode.commands.executeCommand('setContext', 'codetracer:active', false);

  } else {
    // Start CT
    const isNixOS = os.version().includes("NixOS");

    // Trace selector
    let selectedFilePromise: Promise<string | undefined> | undefined;
    switch (loadMode) {
      case LoadMode.Trace:
        selectedFilePromise = pickTraceFolder(codetracerExe, isNixOS);
        break;
      case LoadMode.Tx:
        selectedFilePromise = pickTxFolder(codetracerExe, isNixOS);
        break;
      case LoadMode.File:
        selectedFilePromise = runCurrent(codetracerExe, isNixOS);
        break;
    }
    const selectedFile = await selectedFilePromise;

    if (!selectedFile) {
      return;
    }

    // Setup middleware
    setupMiddlewareApis(dapVsCodeApi, viewsApi);

    // Initialize panels
    const panels = initPanels(context, viewsApi);
    (vscode.window as any).panels = panels; // easier debugging

    const editor = vscode.window.activeTextEditor;
    if (!editor && (loadMode === LoadMode.Trace || loadMode === LoadMode.Tx)) {
      const opened = await openTraceSourceFile(selectedFile);
      if (!opened) {
        vscode.window.showWarningMessage("No trace source file found to open automatically.");
      }
    }

    const debugConfig = {
      type: "codetracer-debug",
      request: "launch",
      name: "Launch Codetracer",
      cwd: "",
      traceFolder: selectedFile
    };

    if (isRrTraceFolder(selectedFile)) {
      const cfg = vscode.workspace.getConfiguration('codetracer');
      const rrWorkerPath = cfg.get<string>('rrWorkerPath')?.trim() ?? "";
      const rrExePath = cfg.get<string>('rrExePath')?.trim() ?? "";
      if (!rrWorkerPath) {
        vscode.window.showErrorMessage(
          "RR trace requires ct-native-replay. Set 'codetracer.rrWorkerPath' to the ct-native-replay executable."
        );
        return;
      }
      const rrWorkerExecutable = await isExecutable(rrWorkerPath);
      if (!rrWorkerExecutable) {
        vscode.window.showErrorMessage(
          "Configured ct-native-replay path is not executable. Update 'codetracer.rrWorkerPath' to a valid ct-native-replay binary."
        );
        return;
      }
      if (!rrExePath) {
        const rrSupportDir = path.dirname(rrWorkerPath);
        const siblingRr = path.join(rrSupportDir, "rr");
        let rrResolved = false;
        try {
          fs.accessSync(siblingRr, fs.constants.X_OK);
          rrResolved = true;
        } catch {
          const pathRr = findInPath("rr");
          rrResolved = Boolean(pathRr);
        }
        if (!rrResolved) {
          vscode.window.showErrorMessage(
            "RR trace requires 'rr' executable. Set 'codetracer.rrExePath' or add rr to PATH."
          );
          return;
        }
      }
      (debugConfig as any).ctRRWorkerExe = rrWorkerPath;
      (debugConfig as any).rawDiffIndex = null;
      (debugConfig as any).restoreLocation = null;
    }

    const started = await vscode.debug.startDebugging(
      undefined,
      debugConfig
    );
    if (!started) {
      vscode.window.showErrorMessage(
        "Failed to start Codetracer debugger."
      );
    }

    ctStarted = true;

    // Toggle on context menu functions
    vscode.commands.executeCommand('setContext', 'codetracer:active', true);

  }
}

let commandDisposables: vscode.Disposable[] = [];
let miscDisposables: vscode.Disposable[] = []; // e.g. listeners registered once

export async function isExecutable(p?: string): Promise<boolean> {
  if (!p) {
    return false;
  }
  try {
    const fileStat = await stat(p);
    if (!fileStat.isFile()) {
      return false;
    } else if (p.endsWith(".AppImage")) {
      return true;
    }
    await access(p, fs.constants.X_OK);
    return true;
  }
  catch { return false; }
}

function disposeAll() {
  for (const d of commandDisposables) {
    d.dispose();
  }
  commandDisposables = [];
}

async function promptForExecutablePath(): Promise<void> {
  // Guide the user to fix the Codetracer path when auto-start is invoked.
  const action = await vscode.window.showErrorMessage(
    'CodeTracer AppImage path is not set or not executable.',
    'Set Path…', 'Reload Window'
  );
  if (action === 'Set Path…') {
    vscode.commands.executeCommand('workbench.action.openSettings', 'codetracer.runnablePath');
  } else if (action === 'Reload Window') {
    vscode.commands.executeCommand('workbench.action.reloadWindow');
  }
}

async function reinitCommands(context: vscode.ExtensionContext) {
  disposeAll();

  const cfg = vscode.workspace.getConfiguration('codetracer');
  let codetracerExe = cfg.get<string>('runnablePath')?.trim();
  let valid = await isExecutable(codetracerExe);

  // If runnablePath is not configured, try to discover ct from the system PATH.
  // The Nix dev shell / direnv environment places ct and db-backend on PATH.
  if (!valid) {
    const ctFromPath = findInPath('ct');
    if (ctFromPath && await isExecutable(ctFromPath)) {
      codetracerExe = ctFromPath;
      valid = true;
      console.log('[CodeTracer] Discovered ct binary from PATH:', ctFromPath);
    }
  }

  // The Nim-compiled ct_vscode.js may not be available in development/test
  // environments that only run `npm run compile` (TypeScript-only build).
  // Gracefully degrade so that stub commands are still registered.
  let dapVsCodeApi: DapVsCodeApi | undefined;
  let viewsApi: MediatorWithSubscribers | undefined;
  let nimBackendAvailable = false;
  try {
    dapVsCodeApi = newDapVsCodeApi(vscode, context);
    viewsApi = setupVsCodeExtensionViewsApi(
      "vscode-extension-to-views"
    );
    nimBackendAvailable = true;
  } catch {
    console.warn('[CodeTracer] Nim backend (ct_vscode.js) not available — running in stub mode');
  }
  if (dapVsCodeApi) {
    (vscode.window as any).dapVsCodeApi = dapVsCodeApi;
  }
  if (viewsApi) {
    (vscode.window as any).viewsApi = viewsApi;
  }
  if (nimBackendAvailable && dapVsCodeApi && viewsApi) {
    registerFlowDecorationHandlers(context, dapVsCodeApi, viewsApi);
  }

  if (!valid) {
    // Show the prompt asynchronously (fire-and-forget) so it doesn't block
    // extension activation. The stub commands below will also prompt when invoked.
    void promptForExecutablePath();
  }

  // Set the codetracer executable and the args
  if (!adapterFactoryDisposable) {
    adapterFactoryDisposable =
      vscode.debug.registerDebugAdapterDescriptorFactory(
        "codetracer-debug",
        new (class implements vscode.DebugAdapterDescriptorFactory {
          async createDebugAdapterDescriptor(
            session: vscode.DebugSession
          ): Promise<vscode.DebugAdapterDescriptor | undefined> {
            const args = ["dap-server", "--stdio"];

            const env = normalizeEnv(makeEnvWithBackend(context));
            const dbBackendPath = resolveDapServerPath(context);

            console.log('[CodeTracer] debug adapter: dbBackendPath =', dbBackendPath);

            return new vscode.DebugAdapterExecutable(
              dbBackendPath,
              args,
              { env }
            );
          }
        })()
      );
  }

  context.subscriptions.push(adapterFactoryDisposable);

  const register = (id: string, fn: (...a: any[]) => any) =>
    commandDisposables.push(vscode.commands.registerCommand(id, fn));

  const stub = (id: string) =>
    register(id, async () => {
      await promptForExecutablePath();
    });

  const exe = codetracerExe!;
  const toggleCtReal = async (mode: LoadMode) =>
    toggleCt(context, dapVsCodeApi!, viewsApi!, exe, mode);
  const maybeToggleCt = async (mode: LoadMode) => {
    if (!valid) {
      await promptForExecutablePath();
      return;
    }
    await toggleCtReal(mode);
  };

  if (!valid || !nimBackendAvailable) {
    // ---- stub (“dunder”) registrations ----
    stub('ct-vscode.toggleCT');
    stub('ct-vscode.loadCurrentFile');
    stub('ct-vscode.loadRecentTraces');
    stub('ct-vscode.loadRecentTransactions');
    stub('ct-vscode.smartSourceLineJump');
    stub('ct-vscode.forwardSourceLineJump');
    stub('ct-vscode.backwardSourceLineJump');
    stub('ct-vscode.addToScratchpad');
    stub('ct-vscode.addTracepoint');
    // Value Origin Tracking (M6): the command is *always* contributed in
    // package.json so the verification suite finds it after activation,
    // regardless of whether the Nim backend has finished loading. When the
    // backend is unavailable we still register a real handler that forwards
    // an empty payload into any embedded panels that are mounted — this
    // preserves the post-message contract for tests that simulate trigger
    // before a real DAP session is alive.
    register('ct-vscode.showValueOrigin', (payload?: unknown) => showValueOriginHandler(payload));
  } else {
    // ---- real registrations ----
    register('ct-vscode.toggleCT', async () => toggleCtReal(LoadMode.Trace));
    register('ct-vscode.loadCurrentFile', async () => toggleCtReal(LoadMode.File));
    register('ct-vscode.loadRecentTraces', async () => toggleCtReal(LoadMode.Trace));
    register('ct-vscode.loadRecentTransactions', async () => toggleCtReal(LoadMode.Tx));

    register('ct-vscode.smartSourceLineJump', () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed) {
        return;
      }
      ctSourceLineJump(dapVsCodeApi!, ed.selection.active.line + 1, ed.document.uri.fsPath, CtJumpBehaviour.SmartJump);
    });
    register('ct-vscode.forwardSourceLineJump', () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed) {
        return;
      }
      ctSourceLineJump(dapVsCodeApi!, ed.selection.active.line + 1, ed.document.uri.fsPath, CtJumpBehaviour.ForwardJump);
    });
    register('ct-vscode.backwardSourceLineJump', () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed) {
        return;
      }
      ctSourceLineJump(dapVsCodeApi!, ed.selection.active.line + 1, ed.document.uri.fsPath, CtJumpBehaviour.BackwardJump);
    });

    register('ct-vscode.addToScratchpad', () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed) { vscode.window.showErrorMessage('No active editor!'); return; }
      const pos = ed.selection.active;
      const word = ed.document.getWordRangeAtPosition(pos);
      const expr = word ? ed.document.getText(word) : '';
      vscode.window.showInformationMessage(`Trying to add the variable: ${expr} to the Scratchpad`);
      ctAddToScratchpad(viewsApi!, expr);
    });

    register("ct-vscode.addTracepoint", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showInformationMessage("Open a text file first.");
        return;
      }

      const line = editor.selection.active.line;
      const existingInset = tracepointInsets.get(line);
      if (existingInset) {
        existingInset.dispose();
        tracepointInsets.delete(line);
      }
      const inset = addTracepoint(context, viewsApi, editor, line);
      tracepointInsets.set(line, inset);
    });

    // Value Origin Tracking (M6): the command resolves the variable name to
    // query, then forwards into the embedded webview's `StateVM.onShowOrigin`
    // via the existing post-message bridge. The extension itself does NOT
    // render any TreeView, hover provider, decoration type or standalone
    // webview — every origin chain affordance is rendered by the embedded
    // CodeTracer panels (spec §8.2). This handler is the thin command-plumbing
    // half of M6; the other half is the `ct/updated-origin-chain` DAP-event
    // forwarder registered below.
    register('ct-vscode.showValueOrigin', (payload?: unknown) => showValueOriginHandler(payload));
  }

  if (miscDisposables.length === 0) {
    miscDisposables.push(
      vscode.languages.registerHoverProvider({ scheme: "file" }, valueOriginHoverProvider()),
      vscode.debug.onDidStartDebugSession(async (session) => {
        console.log('[CodeTracer] onDidStartDebugSession:', session.type, session.name);
        console.log('[CodeTracer] pendingLaunchPanels=', pendingLaunchPanels, 'ctStarted=', ctStarted);
        // When users hit Run | Debug, auto-start Codetracer against the active file.
        if (session.type === 'codetracer-debug') {
          if (pendingLaunchPanels && !ctStarted) {
            console.log('[CodeTracer] Initializing panels for launch...');
            await reinitCommands(context);
            const viewsApi = (vscode.window as any).viewsApi as MediatorWithSubscribers | undefined;
            const dapVsCodeApi = (vscode.window as any).dapVsCodeApi as DapVsCodeApi | undefined;
            console.log('[CodeTracer] viewsApi=', !!viewsApi, 'dapVsCodeApi=', !!dapVsCodeApi);
            if (viewsApi && dapVsCodeApi) {
              setupMiddlewareApis(dapVsCodeApi, viewsApi);
              await initPanelsIfNeeded(context, viewsApi);

              // Open a source file from the trace so the editor isn't empty
              const traceFolder = session.configuration?.traceFolder as string | undefined;
              if (traceFolder) {
                const opened = await openTraceSourceFile(traceFolder);
                if (!opened) {
                  console.warn('[CodeTracer] No trace source file found to open automatically');
                }
              }

              // Enable CodeTracer context menu items
              vscode.commands.executeCommand('setContext', 'codetracer:active', true);

              console.log('[CodeTracer] Panels initialized successfully');
            } else {
              console.error('[CodeTracer] Cannot init panels: viewsApi or dapVsCodeApi missing');
            }
            pendingLaunchPanels = false;
            ctStarted = true;
          } else {
            console.log('[CodeTracer] Skipping panel init: pendingLaunchPanels=', pendingLaunchPanels, 'ctStarted=', ctStarted);
          }
          return;
        }
        if (ctStarted) {
          return;
        }
        await maybeToggleCt(LoadMode.File);
      }),
      vscode.debug.onDidTerminateDebugSession(async (session) => {
        if (session.type === 'codetracer-debug' && ctStarted) {
          await toggleCtReal(LoadMode.None);
        }
      }),
      vscode.window.registerWebviewViewProvider(
        'codetracer-sidebar-panel',
        new utils.CodeTracerViewProvider(context)
      ),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        applyFlowDecorationsForEditor(editor);
        const viewsApi = (vscode.window as any).viewsApi as MediatorWithSubscribers | undefined;
        if (viewsApi) {
          syncFlowInsetForEditor(context, viewsApi, editor);
        }
      }),
      vscode.workspace.onDidChangeConfiguration(async (e) => {
        if (e.affectsConfiguration('codetracer.runnablePath')) {
          await reinitCommands(context);
        }
      }),
      // Value Origin Tracking (M6, spec §5.2) — the db-backend emits
      // `ct/updated-origin-chain` as a lazy continuation alongside the
      // canonical `ct/originChain` response so frontends can update an
      // already-rendered chain without re-issuing the request. The
      // TypeScript side does NOT parse the event body (everything is
      // rendered inside the embedded panels per spec §8.2); it just
      // re-broadcasts the payload to every embedded CodeTracer panel.
      // Using `onDidReceiveDebugSessionCustomEvent` rather than the
      // Nim-side CtEventKind table keeps the bridge independent of the
      // (potentially older) CodeTracer submodule pin shipped with the
      // extension.
      vscode.debug.onDidReceiveDebugSessionCustomEvent((event) => {
        if (event.session.type !== "codetracer-debug") {
          return;
        }
        if (event.event !== UPDATED_ORIGIN_CHAIN_EVENT) {
          return;
        }
        forwardToEmbeddedPanels({
          command: UPDATED_ORIGIN_CHAIN_EVENT,
          value: event.body,
        });
      }),
    );
    context.subscriptions.push(...miscDisposables);
  }
}

/**
 * The object returned from `activate(...)` is exposed to other extensions
 * (and to the M6 verification suite) via `vscode.extensions.getExtension(...).exports`.
 *
 * The surface is intentionally narrow — only the helpers the value-origin
 * test suite needs to verify the extension-side bridge from §8.2:
 *
 *   - `registerPanelOverride(name, target)` lets a test install a fake
 *     panel that captures `postMessage` calls from
 *     `forwardToEmbeddedPanels(...)`, so we can verify
 *     `ct-vscode.showValueOrigin` and the `ct/updated-origin-chain` event
 *     forwarder land the expected message without depending on the full
 *     CodeTracer toolchain being available in the test environment.
 *
 *   - `forwardToEmbeddedPanels(message)` is the same function the
 *     command handler and the DAP-event subscription call internally —
 *     exposing it lets tests directly exercise the post-message bridge.
 */
export interface CodeTracerExtensionExports {
  registerPanelOverride(name: string, target: PostMessageTarget): () => void;
  forwardToEmbeddedPanels(message: unknown): number;
}

export async function activate(context: vscode.ExtensionContext): Promise<CodeTracerExtensionExports> {
  // initial (stub or real)
  await reinitCommands(context);
  // Cross-repo test diagnostic: when ``CODETRACER_DAP_TRACE_PATH`` is
  // set (the WDIO harness points it at
  // ``test/wdio/diagnostics/dap-trace.log``) capture every DAP message
  // between VS Code and the db-backend replay-server.  Local + CI runs
  // diverged identically on the ct/load-locals response in cross-repo
  // run 27710063852 — having the full request/response stream lets us
  // pin the divergence to a specific message instead of inferring it
  // from the empty ``variablesByScope`` in dap-state-*.json.
  const dapTracePath = process.env.CODETRACER_DAP_TRACE_PATH;
  if (dapTracePath) {
    try {
      fs.mkdirSync(path.dirname(dapTracePath), { recursive: true });
      fs.appendFileSync(dapTracePath,
        `\n=== DAP trace session started ${new Date().toISOString()} pid=${process.pid} ===\n`);
    } catch { /* best-effort */ }
    context.subscriptions.push(vscode.debug.registerDebugAdapterTrackerFactory('codetracer-debug', {
      createDebugAdapterTracker(session) {
        const sid = session.id;
        const log = (direction: string, msg: any) => {
          try {
            // Truncate huge payloads (``locals`` can be 100s of KB)
            // so the trace stays readable.  Keep the first 8 KB of
            // any single message — enough for any locals response we
            // care about while preventing log explosion on long runs.
            let serialised = JSON.stringify(msg);
            if (serialised.length > 8192) {
              serialised = serialised.substring(0, 8192) + `…[+${serialised.length - 8192}B truncated]`;
            }
            fs.appendFileSync(dapTracePath, `${new Date().toISOString()} ${sid} ${direction} ${serialised}\n`);
          } catch { /* best-effort */ }
        };
        return {
          onWillStartSession: () => log('SESSION_START', { id: sid, type: session.type, name: session.name }),
          onWillReceiveMessage: msg => log('-> adapter', msg),
          onDidSendMessage:    msg => log('<- adapter', msg),
          onError:             err => log('ERROR', { message: err.message, stack: err.stack }),
          onExit:              (code, signal) => log('EXIT', { code, signal }),
          onWillStopSession:   () => log('SESSION_STOP', { id: sid }),
        };
      },
    }));
  }
  context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('codetracer-debug', {
    provideDebugConfigurations(_folder) {
      return [{
        type: "codetracer-debug",
        request: "launch",
        name: "Launch Codetracer",
        cwd: "",
        traceFolder: ""
      }];
    },
    resolveDebugConfiguration(_folder, config) {
      console.log('[CodeTracer] resolveDebugConfiguration:', JSON.stringify(config));
      const normalizedTraceFolder = typeof config.traceFolder === "string"
        ? config.traceFolder.trim()
        : "";
      if (normalizedTraceFolder.length > 0 || config.traceFile || config.pid) {
        // Signal the onDidStartDebugSession handler to set up panels
        pendingLaunchPanels = true;
        console.log('[CodeTracer] resolveDebugConfiguration: pendingLaunchPanels set to true');
        return config;
      }

      // Mirror the "Record and Run Current File" sidebar action.
      void vscode.commands.executeCommand("ct-vscode.loadCurrentFile");
      return undefined;
    }
  }));

  return {
    registerPanelOverride: _testRegisterPanelOverride,
    forwardToEmbeddedPanels,
  };
}

export function deactivate() {
  disposePanels();
  disposeCommands();
  adapterFactoryDisposable?.dispose();
  adapterFactoryDisposable = undefined;
  clearFlowDecorations();
  clearFlowInset();
  lastFlowLocation = undefined;
  internalLastCompleteMoveHandlerRegistered = false;
  flowDecorationType?.dispose();
  flowDecorationType = undefined;
}
