/**
 * Re-export all page objects for convenient imports.
 */
export { EditorPane } from './editor-pane'
export type { EditorState, EditorContent } from './editor-pane'

export { DebugSession } from './debug-session'
export type { BreakpointInfo, StoppedLocation } from './debug-session'

export { ExtensionState } from './extension-state'
export type { ExtensionInfo, NimBackendState } from './extension-state'

export {
  getPanelStatus,
  isPanelOpen,
  openPanel,
  openStatePanel,
  openCalltracePanel,
  openEventLogPanel,
  openTerminalPanel,
  openScratchpadPanel,
  inspectWebviews,
} from './panels'
export type { PanelInfo } from './panels'

export {
  OriginChainPanelPageObject,
  ORIGIN_SELECTORS,
} from './originChainPanel'
export type { HopDescriptor } from './originChainPanel'
