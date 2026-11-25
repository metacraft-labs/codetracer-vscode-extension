import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

// VS Code identifies an extension as `<publisher>.<name>` from its
// package.json (here `metacraft-labs.ct-vscode`); the bare `name` matches
// nothing, so getExtension() returns undefined. Derive the id from the
// manifest so a rename cannot silently break every lookup again. This file
// compiles to out/test/, two levels below the extension root.
const EXTENSION_ID = (() => {
	const manifest = JSON.parse(
		fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')
	) as { publisher: string; name: string };
	return `${manifest.publisher}.${manifest.name}`;
})();
const EXPECTED_COMMANDS = [
	'ct-vscode.toggleCT',
	'ct-vscode.loadCurrentFile',
	'ct-vscode.loadRecentTraces',
	'ct-vscode.loadRecentTransactions',
	'ct-vscode.openCalltrace',
	'ct-vscode.openState',
	'ct-vscode.openScratchpad',
	'ct-vscode.openEventLog',
	'ct-vscode.openTerminalOutput',
	'ct-vscode.smartSourceLineJump',
	'ct-vscode.forwardSourceLineJump',
	'ct-vscode.backwardSourceLineJump',
	'ct-vscode.addToScratchpad',
	'ct-vscode.addTracepoint',
];

suite('Extension Test Suite', () => {
	test('Extension activates', async () => {
		const extension = vscode.extensions.getExtension(EXTENSION_ID);
		assert.ok(extension, 'extension should be installed');
		await extension!.activate();
		assert.strictEqual(extension!.isActive, true, 'extension should be active');
	});

	test('Commands are registered', async () => {
		const extension = vscode.extensions.getExtension(EXTENSION_ID);
		assert.ok(extension, 'extension should be installed');
		await extension!.activate();

		const commands = await vscode.commands.getCommands(true);
		for (const command of EXPECTED_COMMANDS) {
			assert.ok(
				commands.includes(command),
				`expected command to be registered: ${command}`
			);
		}
	});

	test('Configuration defaults are available', () => {
		const cfg = vscode.workspace.getConfiguration('codetracer');
		assert.strictEqual(typeof cfg.get('runnablePath'), 'string');
		assert.strictEqual(typeof cfg.get('rrWorkerPath'), 'string');
		assert.strictEqual(typeof cfg.get('rrExePath'), 'string');
	});

	test('package.json contributes debugger languages', () => {
		const extension = vscode.extensions.getExtension(EXTENSION_ID);
		assert.ok(extension, 'extension should be installed');
		const pkgPath = path.join(extension!.extensionPath, 'package.json');
		const raw = fs.readFileSync(pkgPath, 'utf8');
		const pkg = JSON.parse(raw) as {
			contributes?: { debuggers?: Array<{ languages?: string[] }> };
		};
		const languages = pkg.contributes?.debuggers?.[0]?.languages ?? [];
		// VS Code lets a user set a breakpoint only in a file whose language a
		// debugger names (unless `debug.allowBreakpointsEverywhere` is on), so
		// every language CodeTracer records has to be here.  Python, JavaScript
		// and C were missing once, and F9 in their files did nothing.
		for (const lang of ['c', 'cpp', 'rust', 'nim', 'go', 'python', 'ruby', 'javascript',
			'typescript', 'shellscript', 'php', 'noir', 'solidity', 'elixir', 'erlang']) {
			assert.ok(languages.includes(lang), `expected debugger language: ${lang}`);
		}
	});

	test('package.json lets a user set breakpoints in every recorded language', () => {
		const extension = vscode.extensions.getExtension(EXTENSION_ID);
		assert.ok(extension, 'extension should be installed');
		const pkgPath = path.join(extension!.extensionPath, 'package.json');
		const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
			contributes?: {
				debuggers?: Array<{ languages?: string[] }>;
				breakpoints?: Array<{ language?: string }>;
			};
		};
		// The languages a debugger names are not what VS Code consults when a
		// user presses F9: `Toggle Breakpoint` does nothing in a file unless
		// some extension contributes `breakpoints` for its language. Without
		// this contribution F9 in a recording's Python, JavaScript or C source
		// set no breakpoint, even with the language in the debugger's list.
		const breakpointLanguages = (pkg.contributes?.breakpoints ?? []).map((b) => b.language);
		for (const lang of pkg.contributes?.debuggers?.[0]?.languages ?? []) {
			assert.ok(breakpointLanguages.includes(lang), `expected breakpoints contribution: ${lang}`);
		}
	});

	test('package.json exposes codetracer settings', () => {
		const extension = vscode.extensions.getExtension(EXTENSION_ID);
		assert.ok(extension, 'extension should be installed');
		const pkgPath = path.join(extension!.extensionPath, 'package.json');
		const raw = fs.readFileSync(pkgPath, 'utf8');
		const pkg = JSON.parse(raw) as {
			contributes?: { configuration?: { properties?: Record<string, unknown> } };
		};
		const props = pkg.contributes?.configuration?.properties ?? {};
		for (const key of ['codetracer.runnablePath', 'codetracer.rrWorkerPath', 'codetracer.rrExePath']) {
			assert.ok(Object.prototype.hasOwnProperty.call(props, key), `expected setting: ${key}`);
		}
	});
});
