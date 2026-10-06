/** Types of banners that can appear at the top of the chat */
export type TopBannerType = 'homeDir' | 'gitRoot' | 'discord' | null

export type InputValue = {
  text: string
  cursorPosition: number
  lastEditDueToNav: boolean
}

export type AskUserQuestion = {
  question: string
  header?: string
  options:
    | string[]
    | Array<{
        label: string
        description?: string
      }>
  multiSelect?: boolean
  validation?: {
    maxLength?: number
    minLength?: number
    pattern?: string
    patternError?: string
  }
}

export type AnswerState = number | number[]

export type AskUserState = {
  toolCallId: string
  questions: AskUserQuestion[]
  selectedAnswers: AnswerState[] // Single-select: number (-1 = not answered), Multi-select: number[]
  otherTexts: string[] // Custom text input for each question (empty string if not used)
} | null

export type PendingImageStatus = 'processing' | 'ready' | 'error'

/** Image attachment with processed data */
export type PendingImageAttachment = {
  kind: 'image'
  path: string
  filename: string
  status: PendingImageStatus
  size?: number
  width?: number
  height?: number
  note?: string // Display note: "compressed" | error message
  processedImage?: {
    base64: string
    mediaType: string
  }
}

/** Text attachment (large pasted text) */
export type PendingTextAttachment = {
  kind: 'text'
  id: string
  content: string
  preview: string // First ~100 chars for display
  charCount: number
}

/** File or folder attachment (dragged or copied from file manager) */
export type PendingFileAttachment = {
  kind: 'file'
  id: string
  path: string
  filename: string
  isDirectory: boolean
  content: string
  status: 'processing' | 'ready' | 'error'
  note?: string // e.g. "3.2 KB" / "12 items" / error message
}

/** Unified attachment type with discriminator */
export type PendingAttachment = PendingImageAttachment | PendingTextAttachment | PendingFileAttachment

export type PendingBashMessage = {
  id: string
  command: string
  stdout: string
  stderr: string
  exitCode: number
  /** Whether the command is still running */
  isRunning: boolean
  startTime?: number
  cwd?: string
  /** Whether the message was already added to UI chat history (non-ghost mode) */
  addedToHistory?: boolean
}

export type SuggestedFollowup = {
  prompt: string
  label?: string
}

export type SuggestedFollowupsState = {
  /** The tool call ID that created these followups */
  toolCallId: string
  /** The list of followup suggestions */
  followups: SuggestedFollowup[]
  /** Set of indices that have been clicked */
  clickedIndices: Set<number>
}

/** Map of toolCallId -> Set of clicked indices (persists across followup sets) */
export type ClickedFollowupsMap = Map<string, Set<number>>
