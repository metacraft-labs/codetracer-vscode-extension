// Configuration for `npx vscode-test` (@vscode/test-cli), which `just
// test-vscode` runs under Xvfb.
//
// Which VS Code it launches:
//
// - In the Nix dev shell, flake.nix exports VSCODE_INSIDERS_EXECUTABLE, the
//   Electron executable of the pinned VS Code Insiders. It must be the
//   Electron binary itself, not the `bin/code-insiders` CLI launcher that
//   VSCODE_INSIDERS_PATH names for WDIO: the launcher starts the app detached
//   and exits 0 immediately, so @vscode/test-electron saw exit 0 and the run
//   "passed" without one test reporting. The checks below refuse such a path
//   by name instead of letting it pass silently.
// - Outside the dev shell (neither variable set), test-cli's default applies:
//   it downloads a VS Code build into .vscode-test/.
import { defineConfig } from '@vscode/test-cli';
import * as fs from 'node:fs';

const EXECUTABLE_VAR = 'VSCODE_INSIDERS_EXECUTABLE';
const LAUNCHER_VAR = 'VSCODE_INSIDERS_PATH';
const REMEDY =
	'Re-enter the dev shell (`repro exec . -- just test-vscode`) so flake.nix ' +
	`exports ${EXECUTABLE_VAR}, or point it at VS Code's Electron executable ` +
	'(Linux: <vscode>/lib/vscode/code-insiders; macOS: ' +
	'<App>.app/Contents/MacOS/Electron), not at the bin/ CLI launcher.';

/**
 * Throws unless `file` is a regular, executable, non-script file: the
 * Electron binary @vscode/test-electron can spawn and wait on.
 * @param {string} file
 */
function assertElectronExecutable(file) {
	const refuse = (why) => {
		throw new Error(`.vscode-test.mjs: ${EXECUTABLE_VAR}=${file} ${why}. ${REMEDY}`);
	};
	let stat;
	try {
		stat = fs.statSync(file);
	} catch (err) {
		refuse(`does not exist (${err.code ?? err.message})`);
	}
	if (!stat.isFile()) {
		refuse('is not a regular file');
	}
	try {
		fs.accessSync(file, fs.constants.X_OK);
	} catch {
		refuse('is not executable');
	}
	// A `#!` script is a launcher (such as bin/code-insiders), which detaches
	// the app and exits 0 before any test runs.
	const head = Buffer.alloc(2);
	const fd = fs.openSync(file, 'r');
	try {
		fs.readSync(fd, head, 0, 2, 0);
	} finally {
		fs.closeSync(fd);
	}
	if (head.toString('latin1') === '#!') {
		refuse('is a script (it starts with #!), i.e. a launcher that exits 0 before the tests run');
	}
}

function installation() {
	const executable = process.env[EXECUTABLE_VAR];
	if (executable) {
		assertElectronExecutable(executable);
		return { version: 'insiders', useInstallation: { fromPath: executable } };
	}
	if (process.env[LAUNCHER_VAR]) {
		// In the dev shell, but from an environment derived before flake.nix
		// exported the executable. Downloading a VS Code here would test a
		// different build than the pinned one, so refuse.
		throw new Error(
			`.vscode-test.mjs: ${LAUNCHER_VAR} is set (${process.env[LAUNCHER_VAR]}) ` +
			`but ${EXECUTABLE_VAR} is not; the dev shell environment is stale. ${REMEDY}`
		);
	}
	return {};
}

export default defineConfig({
	files: 'out/test/**/*.test.js',
	// A run that encounters no tests fails instead of passing.
	mocha: { failZero: true },
	...installation(),
});
