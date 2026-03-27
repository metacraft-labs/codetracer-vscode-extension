/**
 * Page object for the VS Code editor pane in WDIO tests.
 *
 * Provides methods to query the active editor state: file name, source content,
 * cursor position, and active line. Since VS Code's editor is not a standard
 * DOM element accessible via WebDriver selectors, all queries go through
 * `browser.executeWorkbench()` which runs code in the extension host.
 */
import { browser } from '@wdio/globals'

export interface EditorState {
  fileName: string
  filePath: string
  lineCount: number
  cursorLine: number   // 1-based
  cursorColumn: number // 1-based
  languageId: string
}

export interface EditorContent {
  text: string
  lineAt: (line: number) => string
}

export class EditorPane {
  /** Get the state of the active text editor. */
  async state(): Promise<EditorState | null> {
    return browser.executeWorkbench(async (vscode) => {
      const editor = vscode.window.activeTextEditor
      if (!editor) return null
      return {
        fileName: editor.document.fileName.split('/').pop() || '',
        filePath: editor.document.fileName,
        lineCount: editor.document.lineCount,
        cursorLine: editor.selection.active.line + 1,
        cursorColumn: editor.selection.active.character + 1,
        languageId: editor.document.languageId,
      }
    })
  }

  /** Wait for a file matching the given name to be opened in the editor. */
  async waitForFile(fileNamePattern: string, timeoutMs = 15000): Promise<EditorState> {
    let lastState: EditorState | null = null
    await browser.waitUntil(
      async () => {
        lastState = await this.state()
        if (!lastState) return false
        return lastState.fileName.includes(fileNamePattern) ||
               lastState.filePath.includes(fileNamePattern)
      },
      {
        timeout: timeoutMs,
        interval: 500,
        timeoutMsg: `Editor did not open file matching '${fileNamePattern}' within ${timeoutMs}ms`
      }
    )
    return lastState!
  }

  /** Get the full text content of the active editor. */
  async getText(): Promise<string> {
    return browser.executeWorkbench(async (vscode) => {
      const editor = vscode.window.activeTextEditor
      if (!editor) return ''
      return editor.document.getText()
    })
  }

  /** Get a specific line of text (1-based line number). */
  async getLine(lineNumber: number): Promise<string> {
    return browser.executeWorkbench(async (vscode, line: number) => {
      const editor = vscode.window.activeTextEditor
      if (!editor) return ''
      // VS Code lines are 0-indexed internally
      const textLine = editor.document.lineAt(line - 1)
      return textLine.text
    }, lineNumber)
  }

  /** Check if the source file contains the given text. */
  async containsText(text: string): Promise<boolean> {
    const content = await this.getText()
    return content.includes(text)
  }

  /** Get all open editor tab file names. */
  async openTabs(): Promise<string[]> {
    return browser.executeWorkbench(async (vscode) => {
      // VS Code doesn't have a direct API for all open tabs in older versions.
      // Use the tab groups API if available.
      const groups = vscode.window.tabGroups
      if (!groups) return []
      const tabs: string[] = []
      for (const group of groups.all) {
        for (const tab of group.tabs) {
          const input = tab.input as any
          if (input?.uri) {
            tabs.push(input.uri.fsPath || input.uri.path || '')
          }
        }
      }
      return tabs
    })
  }

  /** Check if a file is among the open editor tabs. */
  async hasOpenTab(fileNamePattern: string): Promise<boolean> {
    const tabs = await this.openTabs()
    return tabs.some(t => t.includes(fileNamePattern))
  }
}
