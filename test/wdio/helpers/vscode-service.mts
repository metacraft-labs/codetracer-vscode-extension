/**
 * `wdio-vscode-service` for the WDIO suite, with this repository's VS Code
 * launcher: the service's worker, whose `beforeSession` also points the
 * capabilities at `run-vscode.cjs` (`useRepoVSCodeLauncher`, see
 * `vscode-launcher.cjs` for why), and the service's own launcher service,
 * unchanged.
 *
 * `wdio.conf.ts` names this module by absolute path in `services`. WDIO then
 * loads it as it loads a service package: `launcher` runs in the launcher
 * process (`onPrepare`: VS Code and ChromeDriver resolution) and `default` in
 * each worker. It has to be a subclass rather than a `beforeSession` hook in
 * the config, because WDIO starts the config's and the services'
 * `beforeSession` hooks together (`executeHooksWithArgs` in `@wdio/utils`), so
 * a config hook is not guaranteed to run after the service has set the binary.
 *
 * An ES module because `wdio-vscode-service` is one, and the class must be
 * extended when this module is evaluated.
 */
import VSCodeWorkerService, { launcher as VSCodeServiceLauncher } from 'wdio-vscode-service'
// `vscode-launcher.cjs` is CommonJS, so it is imported whole.
import vscodeLauncher from './vscode-launcher.cjs'

const { useRepoVSCodeLauncher } = vscodeLauncher

export default class VSCodeWorkerServiceWithRepoLauncher extends VSCodeWorkerService {
  async beforeSession(option: any, capabilities: any): Promise<void> {
    // The service sets the shim only for a desktop VS Code capability; a web
    // session or another browser's capability is left as the service leaves it.
    const desktopVSCode = capabilities?.browserName === 'vscode' && Boolean(capabilities['wdio:vscodeOptions'])
    await super.beforeSession(option, capabilities)
    if (desktopVSCode) {
      useRepoVSCodeLauncher(capabilities)
    }
  }
}

export const launcher = VSCodeServiceLauncher
