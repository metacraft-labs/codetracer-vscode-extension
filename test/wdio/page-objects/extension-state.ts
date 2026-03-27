/**
 * Page object for querying the CodeTracer extension's internal state.
 *
 * Provides methods to check extension activation, registered commands,
 * configuration, and Nim backend availability.
 */
import { browser } from '@wdio/globals'

const EXTENSION_ID = 'metacraft-labs.ct-vscode'

export interface ExtensionInfo {
  id: string
  isActive: boolean
  extensionPath: string
}

export interface NimBackendState {
  dapVsCodeApi: boolean
  viewsApi: boolean
  nimBackendAvailable: boolean
}

export class ExtensionState {
  /** Get information about the CodeTracer extension. */
  async info(): Promise<ExtensionInfo | null> {
    return browser.executeWorkbench(async (vscode, extId: string) => {
      const ext = vscode.extensions.getExtension(extId)
      if (!ext) return null
      return {
        id: ext.id,
        isActive: ext.isActive,
        extensionPath: ext.extensionPath,
      }
    }, EXTENSION_ID)
  }

  /** Check if the extension is active. */
  async isActive(): Promise<boolean> {
    const info = await this.info()
    return info?.isActive ?? false
  }

  /** Activate the extension if not already active. */
  async ensureActivated(): Promise<void> {
    await browser.executeWorkbench(async (vscode, extId: string) => {
      const ext = vscode.extensions.getExtension(extId)
      if (ext && !ext.isActive) {
        await ext.activate()
      }
    }, EXTENSION_ID)
  }

  /** Get the Nim backend availability state. */
  async nimBackendState(): Promise<NimBackendState> {
    return browser.executeWorkbench(async (vscode) => ({
      dapVsCodeApi: !!(vscode.window as any).dapVsCodeApi,
      viewsApi: !!(vscode.window as any).viewsApi,
      nimBackendAvailable: !!(vscode.window as any).dapVsCodeApi && !!(vscode.window as any).viewsApi,
    }))
  }

  /** Get all registered ct-vscode commands. */
  async registeredCommands(): Promise<string[]> {
    return browser.executeWorkbench(async (vscode) => {
      const allCommands = await vscode.commands.getCommands(true)
      return allCommands.filter((cmd: string) => cmd.startsWith('ct-vscode.'))
    })
  }

  /** Wait for ct-vscode commands to be registered, with timeout. */
  async waitForCommands(timeoutMs = 15000): Promise<string[]> {
    let commands: string[] = []
    await browser.waitUntil(
      async () => {
        commands = await this.registeredCommands()
        return commands.length > 0
      },
      {
        timeout: timeoutMs,
        interval: 1000,
        timeoutMsg: `ct-vscode commands were not registered within ${timeoutMs}ms`
      }
    )
    return commands
  }

  /** Get the configured runnablePath setting. */
  async runnablePath(): Promise<string> {
    return browser.executeWorkbench(async (vscode) => {
      return vscode.workspace.getConfiguration('codetracer').get('runnablePath') || ''
    })
  }

  /** Check which media/resource files exist in the extension directory. */
  async resourceFileStatus(): Promise<Record<string, { exists: boolean; size?: number }>> {
    return browser.executeWorkbench(async (vscode, extId: string) => {
      const ext = vscode.extensions.getExtension(extId)
      if (!ext) return {}

      const files = [
        'media/frontend_bundle.js',
        'media/ct_vscode.js',
        'media/third_party/jstree.min.js',
        'media/styles/default_dark_theme_extension.css',
        'out/extension.js',
        'out/ct_vscode.js',
      ]

      const results: Record<string, any> = {}
      for (const f of files) {
        const uri = vscode.Uri.joinPath(vscode.Uri.file(ext.extensionPath), f)
        try {
          const stat = await vscode.workspace.fs.stat(uri)
          results[f] = { exists: true, size: stat.size }
        } catch {
          results[f] = { exists: false }
        }
      }
      return results
    }, EXTENSION_ID)
  }
}
