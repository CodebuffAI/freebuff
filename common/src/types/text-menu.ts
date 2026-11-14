/** Sanitized Chromium context-menu data shared by the native and hosted renderers. */
export interface TextMenuParams {
  selectionText: string
  isEditable: boolean
  editFlags: {
    canUndo: boolean
    canRedo: boolean
    canCut: boolean
    canCopy: boolean
    canPaste: boolean
    canSelectAll: boolean
  }
  misspelledWord: string
  dictionarySuggestions: string[]
  linkURL: string
}

export type TextEditCommand = 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll' | 'lookUp'

export interface TextMenuBridge {
  platform: string
  onTextContextMenu?: (handler: (params: TextMenuParams) => void) => () => void
  textEdit?: {
    (command: TextEditCommand): void
    (command: 'replaceMisspelling' | 'learnSpelling', word: string): void
  }
  openExternal?: (url: string) => Promise<unknown>
}
