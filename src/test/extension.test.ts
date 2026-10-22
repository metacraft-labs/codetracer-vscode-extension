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
		for (const lang of ['noir', 'ruby', 'rust']) {
			assert.ok(languages.includes(lang), `expected debugger language: ${lang}`);
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
