/** Types for `vscode-launcher.cjs`; see that file for what it does and why. */

/** This repository's VS Code launcher (`run-vscode.cjs`), the file ChromeDriver is to execute. */
export declare const REPO_VSCODE_LAUNCHER: string

/** The launcher `wdio-vscode-service` sets as the browser binary. */
export declare function upstreamVSCodeShim(): string

/** Points `caps` (as left by `wdio-vscode-service`'s `beforeSession`) at
 *  `REPO_VSCODE_LAUNCHER`, in place, and returns it. Throws when `caps` does
 *  not name the service's shim, or on Windows. */
export declare function useRepoVSCodeLauncher<C extends Record<string, any>>(caps: C): C
