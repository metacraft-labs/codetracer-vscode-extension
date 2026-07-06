import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
	files: 'out/test/**/*.test.js',
	...(process.env.VSCODE_INSIDERS_PATH
		? {
			version: 'insiders',
			useInstallation: { fromPath: process.env.VSCODE_INSIDERS_PATH },
		}
		: {}),
});
