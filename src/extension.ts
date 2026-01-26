/// <reference path="../vscode.proposed.editorInsets.d.ts" />
import * as vscode from "vscode";
import { initPanels, disposePanels, disposeCommands, addTracepoint, addLoopPosition } from "./initPanels";
import * as utils from "./utils";
import * as os from "os";
import * as fs from "fs";
import { access, lstat, readFile, readdir } from "fs/promises";
import * as path from 'path';
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
  TraceInfo,
  TransactionInfo,
  MediatorWithSubscribers,
} from "./ct_vscode.js";

const tracepointInsets = new Map<number, vscode.WebviewEditorInset>();
// const flowInsets = new Map<number, vscode.WebviewEditorInset>();
let ctStarted = false;
let adapterFactoryDisposable: vscode.Disposable | undefined;
let pendingLaunchPanels = false;
let panelsInitialized = false;

interface TraceMetadata {
  workdir?: string;
  program?: string;
  args?: string[];
}

function getBackendBinPath(context: vscode.ExtensionContext): string {
  return path.join(
    context.extensionPath,
    'libs',
    'codetracer',
    'src',
    'build-debug',
    'bin'
  );
}

function makeEnvWithBackend(context: vscode.ExtensionContext): NodeJS.ProcessEnv {
  const backendBin = getBackendBinPath(context);
  const rrEnv = resolveRrEnvironment();

  return {
    ...process.env,
    ...rrEnv,
    PATH: `${backendBin}:${process.env.PATH ?? ''}`,
  };
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

function findExecutableInPath(binaryName: string): string | undefined {
  const pathVar = process.env.PATH ?? "";
  const segments = pathVar.split(path.delimiter).filter(Boolean);
  for (const segment of segments) {
    const candidate = path.join(segment, binaryName);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // continue
    }
  }
  return undefined;
}

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
    const gemspecs = fs.readdirSync(current).filter((entry) => entry.endsWith(".gemspec"));
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

function initPanelsIfNeeded(context: vscode.ExtensionContext, viewsApi: MediatorWithSubscribers): void {
  if (panelsInitialized) {
    return;
  }
  const panels = initPanels(context, viewsApi);
  (vscode.window as any).panels = panels; // easier debugging
  panelsInitialized = true;
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

async function findFirstTraceSourceFile(traceFolder: string): Promise<string | undefined> {
  // Prefer explicit program paths, then trace paths, then any bundled file copy.
  const candidates: string[] = [];
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

    // for (const [line, inset] of flowInsets) {
    //   inset.dispose();
    //   flowInsets.delete(line);
    // }

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

    // const line = editor.selection.active.line;
    // const inset = addLoopPosition(context, viewsApi, editor, line - 1);
    // flowInsets.set(line, inset);


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
          "RR trace requires ct-rr-support. Set 'codetracer.rrWorkerPath' to the ct-rr-support executable."
        );
        return;
      }
      const rrWorkerExecutable = await isExecutable(rrWorkerPath);
      if (!rrWorkerExecutable) {
        vscode.window.showErrorMessage(
          "Configured ct-rr-support path is not executable. Update 'codetracer.rrWorkerPath' to a valid ct-rr-support binary."
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
          const pathRr = findExecutableInPath("rr");
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
    const stat = await lstat(p);
    if (!stat.isFile()) {
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
  const codetracerExe = cfg.get<string>('runnablePath')?.trim();
  const valid = await isExecutable(codetracerExe);
  const dapVsCodeApi = newDapVsCodeApi(vscode, context);
  const viewsApi = setupVsCodeExtensionViewsApi(
    "vscode-extension-to-views"
  );
  (vscode.window as any).viewsApi = viewsApi; // easier debugging
  (vscode.window as any).dapVsCodeApi = dapVsCodeApi;

  if (!valid) {
    await promptForExecutablePath();
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
  
            if (!codetracerExe) {
              return undefined;
            }
  
            const args = ["dap-server", "--stdio"];
  
            const env = normalizeEnv(makeEnvWithBackend(context));
  
            return new vscode.DebugAdapterExecutable(
              "db-backend",   // resolves via injected PATH
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
    toggleCt(context, dapVsCodeApi, viewsApi, exe, mode);
  const maybeToggleCt = async (mode: LoadMode) => {
    if (!valid) {
      await promptForExecutablePath();
      return;
    }
    await toggleCtReal(mode);
  };

  if (!valid) {
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
      ctSourceLineJump(dapVsCodeApi, ed.selection.active.line + 1, ed.document.uri.fsPath, CtJumpBehaviour.SmartJump);
    });
    register('ct-vscode.forwardSourceLineJump', () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed) {
        return;
      }
      ctSourceLineJump(dapVsCodeApi, ed.selection.active.line + 1, ed.document.uri.fsPath, CtJumpBehaviour.ForwardJump);
    });
    register('ct-vscode.backwardSourceLineJump', () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed) {
        return;
      }
      ctSourceLineJump(dapVsCodeApi, ed.selection.active.line + 1, ed.document.uri.fsPath, CtJumpBehaviour.BackwardJump);
    });

    register('ct-vscode.addToScratchpad', () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed) { vscode.window.showErrorMessage('No active editor!'); return; }
      const pos = ed.selection.active;
      const word = ed.document.getWordRangeAtPosition(pos);
      const expr = word ? ed.document.getText(word) : '';
      vscode.window.showInformationMessage(`Trying to add the variable: ${expr} to the Scratchpad`);
      ctAddToScratchpad(viewsApi, expr);
    });

    register("ct-vscode.addTracepoint", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showInformationMessage("Open a text file first.");
        return;
      }

      const line = editor.selection.active.line;
      const inset = addTracepoint(context, viewsApi, editor, line);
      tracepointInsets.set(line, inset);
    });
  }

  if (miscDisposables.length === 0) {
    miscDisposables.push(
      vscode.debug.onDidStartDebugSession(async (session) => {
        // When users hit Run | Debug, auto-start Codetracer against the active file.
        if (session.type === 'codetracer-debug') {
          if (pendingLaunchPanels && !ctStarted) {
            await reinitCommands(context);
            const viewsApi = (vscode.window as any).viewsApi as MediatorWithSubscribers | undefined;
            const dapVsCodeApi = (vscode.window as any).dapVsCodeApi as DapVsCodeApi | undefined;
            if (viewsApi && dapVsCodeApi) {
              setupMiddlewareApis(dapVsCodeApi, viewsApi);
              initPanelsIfNeeded(context, viewsApi);
            }
            pendingLaunchPanels = false;
            ctStarted = true;
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
      vscode.workspace.onDidChangeConfiguration(async (e) => {
        if (e.affectsConfiguration('codetracer.runnablePath')) {
          await reinitCommands(context);
        }
      }),
    );
    context.subscriptions.push(...miscDisposables);
  }
}

export async function activate(context: vscode.ExtensionContext) {
  // initial (stub or real)
  await reinitCommands(context);
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
      const normalizedTraceFolder = typeof config.traceFolder === "string"
        ? config.traceFolder.trim()
        : "";
      if (normalizedTraceFolder.length > 0 || config.traceFile || config.pid) {
        return config;
      }

      // Mirror the "Record and Run Current File" sidebar action.
      void vscode.commands.executeCommand("ct-vscode.loadCurrentFile");
      return undefined;
    }
  }));
}

export function deactivate() {
  disposePanels();
  disposeCommands();
  adapterFactoryDisposable?.dispose();
  adapterFactoryDisposable = undefined;
}
