// Positive control for `just test-vscode`: a test that always throws.
//
// `just test-vscode-control` (scripts/check-test-vscode-control.sh) runs this
// file alone through `npx vscode-test --run` and requires the run to exit
// non-zero AND to name this test as failing. If VS Code is launched in a way
// that never reports test results (for example through the bin/ CLI launcher,
// which detaches the app and exits 0), the run exits 0 and the control fails.
//
// It lives outside src/test/ and is not named *.test.ts, so tsc compiles it
// but the `out/test/**/*.test.js` glob of .vscode-test.mjs never picks it up.
suite('test-vscode positive control', () => {
	test('this test always throws', () => {
		throw new Error('POSITIVE-CONTROL: this failure is expected');
	});
});
