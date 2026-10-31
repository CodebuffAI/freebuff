import type {
  AgentContentBlock,
  ContentBlock,
  ToolContentBlock,
} from '../types/chat'

export const IMPLEMENTOR_AGENT_IDS = [
  'editor-implementor',
  'editor-implementor-opus',
  'editor-implementor-gemini',
  'editor-implementor-gpt-5',
] as const

/** All edit tool names (both direct and proposed variants) */
const ALL_EDIT_TOOL_NAMES = [
  'str_replace',
  'write_file',
  'propose_str_replace',
  'propose_write_file',
] as const

const isProposedToolName = (toolName: ToolContentBlock['toolName']): boolean =>
  typeof toolName === 'string' && toolName.startsWith('propose_')

const getBaseToolName = (toolName: ToolContentBlock['toolName']): string =>
  isProposedToolName(toolName) ? toolName.slice('propose_'.length) : toolName

const SUCCESSFUL_EDIT_MESSAGES = [
  'String replace applied successfully',
  'Created file successfully',
  'Created new file',
  'Overwrote file successfully',
  'Wrote file successfully',
  'Updated file',
  'Proposed new file',
  'Proposed changes',
  'Proposed string replacement',
] as const

const hasProposedTools = (blocks?: ContentBlock[]): boolean => {
  if (!blocks || blocks.length === 0) return false

  return blocks.some(
    (block) => block.type === 'tool' && isProposedToolName(block.toolName),
  )
}

/**
 * Check if an agent is an implementor agent.
 * These agents are rendered differently (as simple status lines instead of full agent blocks).
 */
export const isImplementorAgent = (
  agentBlock: Pick<AgentContentBlock, 'agentType' | 'blocks'>,
): boolean => {
  if (hasProposedTools(agentBlock.blocks)) {
    return true
  }

  return IMPLEMENTOR_AGENT_IDS.some((id) => agentBlock.agentType.includes(id))
}

// Order matters: more specific substrings must be checked before the
// generic 'editor-implementor' suffix, since every variant contains it.
const IMPLEMENTOR_DISPLAY_NAMES = [
  ['editor-implementor-opus', 'Opus'],
  ['editor-implementor-gemini', 'Gemini'],
  ['editor-implementor-gpt-5', 'GPT-5'],
  ['editor-implementor', 'Sonnet'],
] as const

/**
 * Get the display name for an implementor agent.
 */
export const getImplementorDisplayName = (
  agentType: string,
  index?: number,
): string => {
  const match = IMPLEMENTOR_DISPLAY_NAMES.find(([id]) => agentType.includes(id))
  const baseName = match ? match[1] : 'Implementor'

  if (index !== undefined) {
    return `${baseName} #${index + 1}`
  }
  return baseName
}

/**
 * Get the index of an implementor agent among its siblings.
 * Returns the 0-based index among all implementor agents of the same type.
 */
export const getImplementorIndex = (
  currentAgent: AgentContentBlock,
  siblingBlocks: ContentBlock[],
): number | undefined => {
  if (!isImplementorAgent(currentAgent)) return undefined

  // Filter to only implementor agents of the same type
  const implementorSiblings = siblingBlocks.filter(
    (block): block is AgentContentBlock =>
      block.type === 'agent' &&
      isImplementorAgent(block) &&
      block.agentType === currentAgent.agentType,
  )

  // If there's only one, don't show an index
  if (implementorSiblings.length <= 1) {
    return undefined
  }

  // Find the index of the current agent
  return implementorSiblings.findIndex(
    (block) => block.agentId === currentAgent.agentId,
  )
}

/**
 * Group consecutive blocks from a blocks array that match the predicate.
 * Returns the group and the next index to process.
 */
export function groupConsecutiveBlocks<T extends ContentBlock>(
  blocks: ContentBlock[],
  startIndex: number,
  predicate: (block: ContentBlock) => block is T,
): { group: T[]; nextIndex: number } {
  const group: T[] = []
  let i = startIndex

  while (i < blocks.length) {
    const block = blocks[i]
    if (!predicate(block)) {
      break
    }
    group.push(block)
    i++
  }

  return { group, nextIndex: i }
}

/**
 * Group consecutive implementor agents from a blocks array.
 * Returns the group of implementors and the next index to process.
 */
export function groupConsecutiveImplementors(
  blocks: ContentBlock[],
  startIndex: number,
): { group: AgentContentBlock[]; nextIndex: number } {
  return groupConsecutiveBlocks(
    blocks,
    startIndex,
    (block): block is AgentContentBlock =>
      block.type === 'agent' && isImplementorAgent(block),
  )
}

export function groupConsecutiveNonImplementorAgents(
  blocks: ContentBlock[],
  startIndex: number,
): { group: AgentContentBlock[]; nextIndex: number } {
  return groupConsecutiveBlocks(
    blocks,
    startIndex,
    (block): block is AgentContentBlock =>
      block.type === 'agent' && !isImplementorAgent(block),
  )
}

export function groupConsecutiveToolBlocks(
  blocks: ContentBlock[],
  startIndex: number,
): { group: ToolContentBlock[]; nextIndex: number } {
  return groupConsecutiveBlocks(
    blocks,
    startIndex,
    (block): block is ToolContentBlock => block.type === 'tool',
  )
}

/**
 * Extract a value for a key from tool output (key: value format).
 * Supports multi-line values with pipe delimiter.
 */
export function extractValueForKey(output: string, key: string): string | null {
  if (!output || !output.includes(key + ':')) return null

  let lineStart = 0
  const len = output.length

  while (lineStart < len) {
    let lineEnd = output.indexOf('\n', lineStart)
    if (lineEnd === -1) lineEnd = len

    const line = output.slice(lineStart, lineEnd)
    const match = line.match(/^\s*([A-Za-z0-9_]+):\s*(.*)$/)
    if (match && match[1] === key) {
      const rest = match[2]
      if (rest.trim().startsWith('|')) {
        let nextStart = lineEnd + 1
        if (nextStart >= len) return ''

        let nextEnd = output.indexOf('\n', nextStart)
        if (nextEnd === -1) nextEnd = len
        const firstLine = output.slice(nextStart, nextEnd)
        const baseIndent = firstLine.match(/^\s*/)?.[0].length ?? 0

        const acc: string[] = []
        let currStart = nextStart
        while (currStart < len) {
          let currEnd = output.indexOf('\n', currStart)
          if (currEnd === -1) currEnd = len

          const l = output.slice(currStart, currEnd)
          const indent = l.match(/^\s*/)?.[0].length ?? 0
          if (l.trim().length === 0) {
            acc.push('')
          } else {
            if (indent < baseIndent) break
            acc.push(l.slice(baseIndent))
          }

          currStart = currEnd + 1
        }
        return acc.join('\n')
      } else {
        let val = rest.trim()
        if (val.startsWith('"') && val.endsWith('"')) {
          val = val.slice(1, -1)
        }
        return val
      }
    }

    lineStart = lineEnd + 1
  }

  return null
}

/**
 * Extract file path from tool block.
 */
export function extractFilePath(toolBlock: ToolContentBlock): string | null {
  const outputStr = typeof toolBlock.output === 'string' ? toolBlock.output : ''
  const input = toolBlock.input as Record<string, unknown>

  return (
    extractValueForKey(outputStr, 'file') ||
    (typeof input?.path === 'string' ? input.path : null) ||
    (typeof input?.file_path === 'string' ? input.file_path : null)
  )
}

/**
 * Extract unified diff from tool output, or construct from input.
 * For executed tools: use outputRaw/output with unifiedDiff.
 * For proposed tools (implementors): construct diff from input replacements.
 */
export function extractDiff(toolBlock: ToolContentBlock): string | null {
  let hasSuccessfulOutput = false

  // First try to get from outputRaw (for executed tool results)
  // outputRaw is typically an array like [{type: "json", value: {unifiedDiff: "..."}}]
  const outputRaw = toolBlock.outputRaw as unknown
  if (Array.isArray(outputRaw) && outputRaw[0]?.value) {
    const value = outputRaw[0].value as Record<string, unknown>
    if (hasErrorMessage(value)) return null
    if (isSuccessfulEditMessage(value.message)) hasSuccessfulOutput = true
    if (value.unifiedDiff) return value.unifiedDiff as string
    if (value.patch) return value.patch as string
  }
  // Also check direct properties (in case format differs)
  if (typeof outputRaw === 'object' && outputRaw !== null) {
    const rawObj = outputRaw as Record<string, unknown>
    if (hasErrorMessage(rawObj)) return null
    if (isSuccessfulEditMessage(rawObj.message)) hasSuccessfulOutput = true
    if (rawObj.unifiedDiff) return rawObj.unifiedDiff as string
    if (rawObj.patch) return rawObj.patch as string
  }

  // Try to get from output string (key: value format)
  const outputStr = typeof toolBlock.output === 'string' ? toolBlock.output : ''
  const message = extractValueForKey(outputStr, 'message')
  const diffFromOutput =
    extractValueForKey(outputStr, 'unifiedDiff') ||
    extractValueForKey(outputStr, 'patch')

  if (hasFailedEditOutput({ outputStr, message, diffFromOutput })) {
    return null
  }
  if (isSuccessfulEditMessage(message)) {
    hasSuccessfulOutput = true
  }

  if (diffFromOutput) {
    return diffFromOutput
  }

  // For proposed/pending edits, or confirmed successful executions, construct
  // the preview from input when the result omits a diff.
  const canUseInputFallback =
    isProposedToolName(toolBlock.toolName) ||
    outputStr === '' ||
    hasSuccessfulOutput
  if (!canUseInputFallback) {
    return null
  }

  const input = toolBlock.input as Record<string, unknown>
  const baseToolName = getBaseToolName(toolBlock.toolName)

  // Handle str_replace: construct diff from replacements
  if (baseToolName === 'str_replace' && Array.isArray(input?.replacements)) {
    const replacements = input.replacements as ReplacementInput[]
    if (replacements.length > 0) {
      return constructDiffFromReplacements(replacements)
    }
  }

  // Handle write_file: show content as addition
  if (baseToolName === 'write_file' && typeof input?.content === 'string') {
    return constructDiffFromWriteFile(input.content)
  }

  // Fallback: get from input.content (for other tools)
  if (input?.content !== undefined && typeof input.content === 'string') {
    return input.content
  }

  return null
}

function hasErrorMessage(value: Record<string, unknown>): boolean {
  return Boolean(value.errorMessage || (value.value as any)?.errorMessage)
}

function hasFailedEditOutput(params: {
  outputStr: string
  message: string | null
  diffFromOutput: string | null
}): boolean {
  const { outputStr, message, diffFromOutput } = params
  const trimmedOutput = outputStr.trim()
  if (!trimmedOutput) {
    return false
  }
  if (
    extractValueForKey(outputStr, 'errorMessage') ||
    isErrorOutput(outputStr)
  ) {
    return true
  }
  if (diffFromOutput || isSuccessfulEditMessage(message)) {
    return false
  }
  return !isSuccessfulEditMessage(trimmedOutput)
}

function isFailedEditToolBlock(toolBlock: ToolContentBlock): boolean {
  const outputRaw = toolBlock.outputRaw as unknown
  if (Array.isArray(outputRaw) && outputRaw[0]?.value) {
    const value = outputRaw[0].value as Record<string, unknown>
    if (hasErrorMessage(value)) return true
  }
  if (typeof outputRaw === 'object' && outputRaw !== null) {
    const rawObj = outputRaw as Record<string, unknown>
    if (hasErrorMessage(rawObj)) return true
  }

  const outputStr = typeof toolBlock.output === 'string' ? toolBlock.output : ''
  const message = extractValueForKey(outputStr, 'message')
  const diffFromOutput =
    extractValueForKey(outputStr, 'unifiedDiff') ||
    extractValueForKey(outputStr, 'patch')
  return hasFailedEditOutput({ outputStr, message, diffFromOutput })
}

function isSuccessfulEditMessage(message: unknown): boolean {
  if (typeof message !== 'string') {
    return false
  }

  return message
    .split('\n')
    .some((line) =>
      SUCCESSFUL_EDIT_MESSAGES.some((successMessage) =>
        line.trim().startsWith(successMessage),
      ),
    )
}

function isErrorOutput(output: string): boolean {
  const trimmedOutput = output.trim()
  return trimmedOutput.startsWith('Error:') || trimmedOutput.startsWith('Failed ')
}

/**
 * Construct a simple diff view from str_replace replacements.
 */
type ReplacementInput = {
  oldString?: string
  newString?: string
  old?: string
  new?: string
}

function constructDiffFromReplacements(
  replacements: ReplacementInput[],
): string {
  const lines: string[] = []

  for (const replacement of replacements) {
    const oldString = replacement.oldString ?? replacement.old ?? ''
    const newString = replacement.newString ?? replacement.new ?? ''

    // Add old lines as removals
    const oldLines = oldString.split('\n')
    for (const line of oldLines) {
      lines.push(`- ${line}`)
    }
    // Add new lines as additions
    const newLines = newString.split('\n')
    for (const line of newLines) {
      lines.push(`+ ${line}`)
    }
    // Add separator between replacements if there are multiple
    if (replacements.length > 1) {
      lines.push('')
    }
  }

  return lines.join('\n')
}

/**
 * Construct a diff view from write_file content.
 */
function constructDiffFromWriteFile(content: string): string {
  const lines = content.split('\n')
  return lines.map((line) => `+ ${line}`).join('\n')
}

/**
 * Check if a tool is a "create new file" operation.
 */
export function isCreateFile(toolBlock: ToolContentBlock): boolean {
  const outputStr = typeof toolBlock.output === 'string' ? toolBlock.output : ''
  const message = extractValueForKey(outputStr, 'message')
  return (
    typeof message === 'string' &&
    (message.startsWith('Created file successfully') ||
      message.startsWith('Created new file') ||
      message.startsWith('Proposed new file'))
  )
}

function hasToolResultOutput(toolBlock: ToolContentBlock): boolean {
  const outputStr = typeof toolBlock.output === 'string' ? toolBlock.output : ''
  return outputStr.length > 0 || toolBlock.outputRaw !== undefined
}

/**
 * Decide whether the direct edit tool renderer should show a diff preview.
 *
 * Real edit tool calls render immediately with input only, then receive output
 * once the edit completes. Wait for that result before showing diffs so create
 * operations never briefly flash an input-derived full-file diff.
 */
export function shouldShowEditDiff(toolBlock: ToolContentBlock): boolean {
  if (!extractDiff(toolBlock) || isCreateFile(toolBlock)) {
    return false
  }

  if (
    !isProposedToolName(toolBlock.toolName) &&
    !hasToolResultOutput(toolBlock)
  ) {
    return false
  }

  return true
}

export interface TimelineItem {
  type: 'commentary' | 'edit'
  content: string // For commentary: the text. For edits: file path
  diff?: string // For edits: the unified diff
  isCreate?: boolean // For edits: whether this is a new file creation
}

/** Git-style change type for files */
export type FileChangeType = 'A' | 'M' | 'D' | 'R'

export interface DiffStats {
  linesAdded: number
  linesRemoved: number
  hunks: number
}

export interface FileStats {
  path: string
  changeType: FileChangeType
  stats: DiffStats
}

/**
 * Parse diff text and extract statistics.
 */
export function parseDiffStats(diff: string | undefined): DiffStats {
  if (!diff) return { linesAdded: 0, linesRemoved: 0, hunks: 0 }

  const lines = diff.split('\n')
  let linesAdded = 0
  let linesRemoved = 0
  let hunks = 0

  for (const line of lines) {
    // Count hunk headers (lines starting with @@)
    if (line.startsWith('@@')) {
      hunks++
    }
    // Count additions (lines starting with + but not +++ header)
    else if (line.startsWith('+') && !line.startsWith('+++')) {
      linesAdded++
    }
    // Count deletions (lines starting with - but not --- header)
    else if (line.startsWith('-') && !line.startsWith('---')) {
      linesRemoved++
    }
  }

  // If no @@ markers found but we have +/- lines, count as 1 hunk
  if (hunks === 0 && (linesAdded > 0 || linesRemoved > 0)) {
    hunks = 1
  }

  return { linesAdded, linesRemoved, hunks }
}

/**
 * Determine file change type based on tool and context.
 */
export function getFileChangeType(toolBlock: ToolContentBlock): FileChangeType {
  const baseToolName = getBaseToolName(toolBlock.toolName)
  // write_file creating new file = Added; everything else (str_replace and
  // any other edit tool) is a modification.
  if (baseToolName === 'write_file') {
    const isCreate = isCreateFile(toolBlock)
    return isCreate ? 'A' : 'M'
  }

  return 'M'
}

/**
 * Get aggregated file stats from all edit blocks.
 * Groups by file path and sums up the stats.
 */
export function getFileStatsFromBlocks(
  blocks: ContentBlock[] | undefined,
): FileStats[] {
  if (!blocks || blocks.length === 0) return []

  const fileMap = new Map<string, FileStats>()

  for (const block of blocks) {
    if (
      block.type !== 'tool' ||
      !ALL_EDIT_TOOL_NAMES.includes(
        block.toolName as (typeof ALL_EDIT_TOOL_NAMES)[number],
      )
    ) {
      continue
    }
    if (isFailedEditToolBlock(block)) continue

    const filePath = extractFilePath(block)
    if (!filePath) continue

    const diff = extractDiff(block)
    const stats = parseDiffStats(diff ?? undefined)
    const changeType = getFileChangeType(block)

    const existing = fileMap.get(filePath)
    if (existing) {
      // Aggregate stats for same file
      existing.stats.linesAdded += stats.linesAdded
      existing.stats.linesRemoved += stats.linesRemoved
      existing.stats.hunks += stats.hunks
    } else {
      fileMap.set(filePath, {
        path: filePath,
        changeType,
        stats,
      })
    }
  }

  return Array.from(fileMap.values())
}

/**
 * Build an activity timeline from agent blocks.
 * Interleaves commentary (text blocks) and edits (tool calls).
 * Includes both executed tools (str_replace, write_file) and proposed tools.
 */
export function buildActivityTimeline(
  blocks: ContentBlock[] | undefined,
): TimelineItem[] {
  if (!blocks || blocks.length === 0) return []

  const timeline: TimelineItem[] = []

  for (const block of blocks) {
    if (block.type === 'text' && block.textType !== 'reasoning') {
      const content = block.content.trim()
      if (content) {
        timeline.push({ type: 'commentary', content })
      }
    } else if (
      block.type === 'tool' &&
      ALL_EDIT_TOOL_NAMES.includes(
        block.toolName as (typeof ALL_EDIT_TOOL_NAMES)[number],
      )
    ) {
      if (isFailedEditToolBlock(block)) continue

      const filePath = extractFilePath(block)
      const diff = extractDiff(block)
      const isCreate = isCreateFile(block)

      timeline.push({
        type: 'edit',
        content: filePath || 'unknown file',
        diff: diff || undefined,
        isCreate,
      })
    }
  }

  return timeline
}

/**
 * Truncate text to fit within maxWidth, adding ellipsis if needed.
 */
export function truncateWithEllipsis(text: string, maxWidth: number): string {
  if (text.length <= maxWidth) return text
  if (maxWidth <= 3) return text.slice(0, maxWidth)
  return text.slice(0, maxWidth - 3) + '...'
}

export interface MultiPromptProgress {
  /** Total number of implementor agents */
  total: number
  /** Number of successfully completed implementors */
  completed: number
  /** Number of failed/errored implementors */
  failed: number
  /** Whether selector is active (all implementors done, selecting best) */
  isSelecting: boolean
  /** Whether selector has completed (used to detect applying phase) */
  isSelectorComplete: boolean
}

/**
 * Analyze progress of a multi-prompt editor agent.
 * Returns counts of implementor agents and current phase.
 */
export function getMultiPromptProgress(
  blocks: ContentBlock[] | undefined,
): MultiPromptProgress | null {
  if (!blocks || blocks.length === 0) return null

  const implementors = blocks.filter(
    (block): block is AgentContentBlock =>
      block.type === 'agent' && isImplementorAgent(block),
  )

  if (implementors.length === 0) return null

  const completed = implementors.filter((a) => a.status === 'complete').length
  const failed = implementors.filter(
    (a) => a.status === 'failed' || a.status === 'cancelled',
  ).length

  const selectorAgent = blocks.find(
    (block): block is AgentContentBlock =>
      block.type === 'agent' && block.agentType.includes('best-of-n-selector'),
  )
  const isSelecting = selectorAgent?.status === 'running'

  return {
    total: implementors.length,
    completed,
    failed,
    isSelecting,
    isSelectorComplete: selectorAgent?.status === 'complete',
  }
}

/** Expected shape of the set_output data from editor-multi-prompt */
interface MultiPromptSetOutputData {
  implementationId?: string
  chosenStrategy?: string
  reason?: string
  suggestedImprovements?: string
  toolResults?: unknown[]
  error?: string
}

/** Expected shape of the set_output input (data is wrapped in a 'data' property) */
interface SetOutputInput {
  data?: MultiPromptSetOutputData
}

/** Type guard for set_output input with data property */
function hasSetOutputData(input: unknown): input is SetOutputInput {
  return (
    typeof input === 'object' &&
    input !== null &&
    'data' in input &&
    typeof (input as SetOutputInput).data === 'object'
  )
}

/**
 * Extract the selection reason from multi-prompt agent's set_output block.
 * set_output wraps data in a 'data' property, so we need to access input.data.reason
 */
function extractSelectionReason(
  blocks: ContentBlock[] | undefined,
): string | null {
  if (!blocks || blocks.length === 0) return null

  const setOutputBlock = blocks.find(
    (block): block is ToolContentBlock =>
      block.type === 'tool' &&
      block.toolName === 'set_output' &&
      hasSetOutputData(block.input) &&
      typeof block.input.data?.reason === 'string',
  )

  if (!setOutputBlock || !hasSetOutputData(setOutputBlock.input)) {
    return null
  }

  return setOutputBlock.input.data?.reason ?? null
}

/**
 * Generate a progress-focused preview string for multi-prompt editor.
 * @param blocks - The nested content blocks of the agent
 * @param isAgentComplete - Whether the parent agent has finished (status === 'complete')
 */
export function getMultiPromptPreview(
  blocks: ContentBlock[] | undefined,
  isAgentComplete?: boolean,
): string | null {
  const progress = getMultiPromptProgress(blocks)
  if (!progress) return null

  const { total, completed, failed, isSelecting, isSelectorComplete } = progress
  const finished = completed + failed

  // Agent is fully complete - show final state with selection info
  // Use multi-line format: line 1 = count, lines 2-3 = reason (truncated to fit)
  if (isAgentComplete) {
    const reason = extractSelectionReason(blocks)
    if (reason) {
      // Capitalize first letter and truncate to 2 lines (line 1 is the count)
      const formattedReason = reason.charAt(0).toUpperCase() + reason.slice(1)
      const lines = formattedReason.split('\n')
      const truncatedReason =
        lines.length > 2
          ? lines.slice(0, 2).join('\n').trimEnd() + '...'
          : formattedReason
      return `${total} proposals evaluated\n${truncatedReason}`
    }
    return `${total} proposals evaluated`
  }

  // Selector completed but agent still running = applying phase
  if (isSelectorComplete) {
    return 'Applying selected changes...'
  }

  if (isSelecting) {
    return `${total} proposals complete • Selecting best...`
  }

  if (finished === total && total > 0) {
    if (failed > 0) {
      return `${completed}/${total} proposals complete (${failed} failed)`
    }
    return `${total} proposals complete`
  }

  if (finished > 0) {
    if (failed > 0) {
      return `${completed}/${total} complete, ${failed} failed...`
    }
    return `${completed}/${total} proposals complete...`
  }

  return `Generating ${total} proposals...`
}
