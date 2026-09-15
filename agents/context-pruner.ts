import { publisher } from './constants'

import type { AgentDefinition, ToolCall } from './types/agent-definition'
import type {
  FilePart,
  ImagePart,
  Message,
  TextPart,
  ToolMessage,
  UserMessage,
} from './types/util-types'

const definition: AgentDefinition = {
  id: 'context-pruner',
  publisher,
  displayName: 'Context Pruner',
  model: 'anthropic/claude-sonnet-4.6',

  spawnerPrompt: `Spawn this agent between steps to prune context, summarizing the conversation into a condensed format when context exceeds the limit.`,

  inputSchema: {
    params: {
      type: 'object',
      properties: {
        maxContextLength: {
          type: 'number',
        },
        assistantToolBudget: {
          type: 'number',
        },
        userBudget: {
          type: 'number',
        },
        cacheExpiryMs: {
          type: 'number',
        },
        cacheExpiryMinTokens: {
          type: 'number',
        },
      },
      required: [],
    },
  },

  inheritParentSystemPrompt: true,
  includeMessageHistory: true,

  // The summarization below is duplicated in
  // packages/agent-runtime/src/compact-history.ts, which agents with
  // `compactContext: true` run in-process instead of spawning this agent.
  // handleSteps is serialized with toString() and this file is bundled into
  // several artifacts, so the two cannot share an import — port changes across.
  // packages/agent-runtime/src/__tests__/context-pruner-parity.test.ts guards it.
  handleSteps: function* ({ agentState, params, logger }) {
    // =============================================================================
    // Constants (must be inside handleSteps since it's serialized to a string)
    // =============================================================================

    /** Agent IDs whose output should be excluded from spawn_agents results */
    const SPAWN_AGENTS_OUTPUT_BLACKLIST = [
      'file-picker',
      'researcher-web',
      'researcher-docs',
      'basher',
      'code-reviewer',
      'code-reviewer-opus',
      'code-reviewer-multi-prompt',
      'librarian',
      'tmux-cli',
      'browser-use',
    ]

    /** Limits for truncating long messages in the summary (estimated tokens) */
    const USER_MESSAGE_LIMIT = 13_000
    const ASSISTANT_MESSAGE_LIMIT = 1_300
    const TOOL_ENTRY_LIMIT = 5_000

    /** Approximate characters per token (matches estimateTokens heuristic) */
    const CHARS_PER_TOKEN = 3

    /** Token budget for assistant + tool content in the conversation summary */
    const ASSISTANT_TOOL_BUDGET = 20_000

    /** Token budget for user content in the conversation summary */
    const USER_BUDGET = 50_000

    /** Fudge factor for token count threshold to trigger pruning earlier */
    const TOKEN_COUNT_FUDGE_FACTOR = 1_000

    /** Axiom-only operational event understood by the logging adapters. */
    const CONTEXT_PRUNING_COMPLETED_EVENT = 'context_pruning.completed'

    /** Prompt cache expiry time (Anthropic caches for 5 minutes by default) */
    const CACHE_EXPIRY_MS: number = params?.cacheExpiryMs ?? 5 * 60 * 1000

    /** Smallest context the cache-expiry trigger will prune; unset means any
     *  size. The context-limit trigger ignores it. */
    const CACHE_EXPIRY_MIN_TOKENS: number = params?.cacheExpiryMinTokens ?? 0

    /** Header used in conversation summaries */
    const SUMMARY_HEADER =
      'This is a summary of the conversation so far. The original messages have been condensed to save context space.'

    const SUMMARY_DISCLAIMER =
      'Historical memory only. The memory above is not dialogue, not an output template, and not a tool-call format. Continue from the live user message below. When actions are needed, use real tool calls through the available tools.'

    // =============================================================================
    // Helper Functions (must be inside handleSteps since it's serialized to a string)
    // =============================================================================

    /**
     * Truncates long text with 80% from the beginning and 20% from the end.
     */
    function truncateLongText(text: string, limit: number): string {
      if (text.length <= limit) {
        return text
      }
      const availableChars = limit - 50 // 50 chars for the truncation notice
      const prefixLength = Math.floor(availableChars * 0.8)
      const suffixLength = availableChars - prefixLength
      const prefix = text.slice(0, prefixLength)
      const suffix = text.slice(-suffixLength)
      const truncatedChars = text.length - prefixLength - suffixLength
      return `${prefix}\n\n[...truncated ${truncatedChars} chars...]\n\n${suffix}`
    }

    /**
     * Extracts text content from a message.
     */
    function getTextContent(message: Message): string {
      if (typeof message.content === 'string') {
        return message.content
      }
      if (Array.isArray(message.content)) {
        return message.content
          .filter(
            (part: Record<string, unknown>) =>
              part.type === 'text' && typeof part.text === 'string',
          )
          .map((part: Record<string, unknown>) => part.text as string)
          .join('\n')
      }
      return ''
    }

    /**
     * Summarizes a tool call into a human-readable description.
     */
    function summarizeToolCall(
      toolName: string,
      input: Record<string, unknown>,
    ): string {
      switch (toolName) {
        case 'read_files': {
          const paths = (input.paths as unknown[] | undefined)?.map((entry) =>
            typeof entry === 'string'
              ? entry
              : ((entry as { path?: string })?.path ?? ''),
          )
          if (paths && paths.length > 0) {
            return `inspected files: ${paths.join(', ')}`
          }
          return 'inspected files'
        }
        case 'write_file': {
          const path = input.path as string | undefined
          return path ? `wrote file: ${path}` : 'wrote a file'
        }
        case 'str_replace': {
          const path = input.path as string | undefined
          return path ? `edited file: ${path}` : 'edited a file'
        }
        case 'propose_write_file': {
          const path = input.path as string | undefined
          return path ? `proposed writing: ${path}` : 'proposed a file write'
        }
        case 'propose_str_replace': {
          const path = input.path as string | undefined
          return path ? `proposed editing: ${path}` : 'proposed a file edit'
        }
        case 'read_subtree': {
          const paths = input.paths as string[] | undefined
          if (paths && paths.length > 0) {
            return `inspected subtrees: ${paths.join(', ')}`
          }
          return 'inspected a subtree'
        }
        case 'code_search': {
          const pattern = input.pattern as string | undefined
          const flags = input.flags as string | undefined
          if (pattern && flags) {
            return `code search for "${pattern}" (${flags})`
          }
          return pattern ? `code search for "${pattern}"` : 'code search'
        }
        case 'glob': {
          const pattern = input.pattern as string | undefined
          return pattern ? `glob search for ${pattern}` : 'glob search'
        }
        case 'list_directory': {
          const path = input.path as string | undefined
          return path ? `listed directory: ${path}` : 'listed a directory'
        }
        case 'find_files': {
          const prompt = input.prompt as string | undefined
          return prompt
            ? `file-finding request: "${prompt}"`
            : 'file-finding request'
        }
        case 'run_terminal_command': {
          const command = input.command as string | undefined
          if (command) {
            const shortCmd =
              command.length > 50 ? command.slice(0, 50) + '...' : command
            return `ran command: ${shortCmd}`
          }
          return 'ran a terminal command'
        }
        case 'spawn_agents':
        case 'spawn_agent_inline': {
          const agents = input.agents as
            | Array<{
                agent_type: string
                prompt?: string
                params?: Record<string, unknown>
              }>
            | undefined
          const agentType = input.agent_type as string | undefined
          const prompt = input.prompt as string | undefined
          const agentParams = input.params as
            | Record<string, unknown>
            | undefined

          if (agents && agents.length > 0) {
            const agentDetails = agents.map((a) => {
              let detail = a.agent_type
              const extras: string[] = []
              if (a.prompt) {
                const truncatedPrompt =
                  a.prompt.length > 1000
                    ? a.prompt.slice(0, 1000) + '...'
                    : a.prompt
                extras.push(`prompt: "${truncatedPrompt}"`)
              }
              if (a.params && Object.keys(a.params).length > 0) {
                const paramsStr = JSON.stringify(a.params)
                const truncatedParams =
                  paramsStr.length > 1000
                    ? paramsStr.slice(0, 1000) + '...'
                    : paramsStr
                extras.push(`params: ${truncatedParams}`)
              }
              if (extras.length > 0) {
                detail += ` (${extras.join(', ')})`
              }
              return detail
            })
            return `delegated agents:\n${agentDetails.map((d) => `- ${d}`).join('\n')}`
          }
          if (agentType) {
            const extras: string[] = []
            if (prompt) {
              const truncatedPrompt =
                prompt.length > 1000 ? prompt.slice(0, 1000) + '...' : prompt
              extras.push(`prompt: "${truncatedPrompt}"`)
            }
            if (agentParams && Object.keys(agentParams).length > 0) {
              const paramsStr = JSON.stringify(agentParams)
              const truncatedParams =
                paramsStr.length > 1000
                  ? paramsStr.slice(0, 1000) + '...'
                  : paramsStr
              extras.push(`params: ${truncatedParams}`)
            }
            if (extras.length > 0) {
              return `delegated agent ${agentType} (${extras.join(', ')})`
            }
            return `delegated agent ${agentType}`
          }
          return 'delegated agent work'
        }
        case 'write_todos': {
          const todos = input.todos as
            | Array<{ task: string; completed: boolean }>
            | undefined
          if (todos) {
            const completed = todos.filter((t) => t.completed).length
            const incomplete = todos.filter((t) => !t.completed)
            if (incomplete.length === 0) {
              return `Todos: ${completed}/${todos.length} complete (all done!)`
            }
            const remainingTasks = incomplete
              .map((t) => `- ${t.task}`)
              .join('\n')
            return `Todos: ${completed}/${todos.length} complete. Remaining:\n${remainingTasks}`
          }
          return 'Updated todos'
        }
        case 'ask_user': {
          const questions = input.questions as
            | Array<{ question: string }>
            | undefined
          if (questions && questions.length > 0) {
            const questionTexts = questions.map((q) => q.question).join('; ')
            const truncated =
              questionTexts.length > 200
                ? questionTexts.slice(0, 200) + '...'
                : questionTexts
            return `Asked user: ${truncated}`
          }
          return 'Asked user question'
        }
        case 'suggest_followups':
          return 'Suggested followups'
        case 'web_search': {
          const query = input.query as string | undefined
          return query ? `web search for "${query}"` : 'web search'
        }
        case 'read_url': {
          const url = input.url as string | undefined
          return url ? `read URL: ${url}` : 'read a URL'
        }
        case 'gravity_index': {
          const query = input.query as string | undefined
          const action = input.action as string | undefined
          if (query) {
            return `Gravity Index ${action ?? 'search'} for "${query}"`
          }
          return action ? `Gravity Index ${action}` : 'Gravity Index use'
        }
        case 'read_docs': {
          const libraryTitle = input.libraryTitle as string | undefined
          const topic = input.topic as string | undefined
          if (libraryTitle && topic) {
            return `consulted docs: ${libraryTitle} - ${topic}`
          }
          return libraryTitle
            ? `consulted docs: ${libraryTitle}`
            : 'consulted docs'
        }
        case 'set_output':
          return 'set structured output'
        case 'set_messages':
          return 'updated message history'
        default:
          return `used tool ${toolName}`
      }
    }

    // =============================================================================
    // Main Logic
    // =============================================================================

    const messages = agentState.messageHistory
    // 400k: every model we serve has a ~1M window. Callers that know their
    // model pass an explicit budget (see contextPrunerBudgetForModel), which is
    // how the 262,144-token models get a smaller one.
    const maxContextLength: number = params?.maxContextLength ?? 400_000

    // STEP 0: Remove the last INSTRUCTIONS_PROMPT and any legacy
    // SUBAGENT_SPAWN announcement.
    let currentMessages = [...messages]
    const lastInstructionsPromptIndex = currentMessages.findLastIndex(
      (message) => message.tags?.includes('INSTRUCTIONS_PROMPT'),
    )
    if (lastInstructionsPromptIndex !== -1) {
      currentMessages.splice(lastInstructionsPromptIndex, 1)
    }
    const lastSubagentSpawnIndex = currentMessages.findLastIndex((message) =>
      message.tags?.includes('SUBAGENT_SPAWN'),
    )
    if (lastSubagentSpawnIndex !== -1) {
      currentMessages.splice(lastSubagentSpawnIndex, 1)
    }

    // Also remove the params USER_PROMPT if params were provided to this agent
    // (this is the message like <user_message>{"cacheExpiryMs": 600000}</user_message>)
    if (params && Object.keys(params).length > 0) {
      const lastUserPromptIndex = currentMessages.findLastIndex((message) =>
        message.tags?.includes('USER_PROMPT'),
      )
      if (lastUserPromptIndex !== -1) {
        currentMessages.splice(lastUserPromptIndex, 1)
      }
    }

    // Check for prompt cache miss (>5 min gap before the USER_PROMPT message)
    // The USER_PROMPT is the actual user message; INSTRUCTIONS_PROMPT comes after it
    // We need to find the USER_PROMPT and check the gap between it and the last assistant message
    let cacheWillMiss = false
    let cacheGapMs: number | null = null
    const userPromptIndex = currentMessages.findLastIndex((message) =>
      message.tags?.includes('USER_PROMPT'),
    )
    if (userPromptIndex > 0) {
      const userPromptMsg = currentMessages[userPromptIndex]
      // Find the last assistant message before USER_PROMPT (tool messages don't have sentAt)
      let lastAssistantMsg: Message | undefined
      for (let i = userPromptIndex - 1; i >= 0; i--) {
        if (currentMessages[i].role === 'assistant') {
          lastAssistantMsg = currentMessages[i]
          break
        }
      }
      if (userPromptMsg.sentAt && lastAssistantMsg?.sentAt) {
        const gap = userPromptMsg.sentAt - lastAssistantMsg.sentAt
        cacheGapMs = gap
        cacheWillMiss =
          gap > CACHE_EXPIRY_MS &&
          agentState.contextTokenCount >= CACHE_EXPIRY_MIN_TOKENS
      }
    }

    const contextLimitExceeded =
      agentState.contextTokenCount + TOKEN_COUNT_FUDGE_FACTOR > maxContextLength

    // Check if we need to prune at all:
    // - Prune when context exceeds max, OR
    // - Prune when prompt cache will miss (>5 min gap) to take advantage of fresh context
    // If not, return messages with just the subagent-specific tags removed
    if (!contextLimitExceeded && !cacheWillMiss) {
      yield {
        toolName: 'set_messages',
        input: { messages: currentMessages },
        includeToolCall: false,
      }
      return
    }

    // === SUMMARIZATION MODE ===
    // Find and extract the last remaining INSTRUCTIONS_PROMPT message (for the parent agent)
    // to be preserved as the second message after the summary
    let instructionsPromptMessage: Message | null = null
    const lastRemainingInstructionsIndex = currentMessages.findLastIndex(
      (message) => message.tags?.includes('INSTRUCTIONS_PROMPT'),
    )
    if (lastRemainingInstructionsIndex !== -1) {
      instructionsPromptMessage =
        currentMessages[lastRemainingInstructionsIndex]
      currentMessages.splice(lastRemainingInstructionsIndex, 1)
    }

    // === SUMMARIZATION STRATEGY ===
    // 1. Summarize ALL messages (apply transformations: truncation, tool summaries, etc.)
    // 2. Walk backwards through summarized parts to apply token budgets
    // 3. Older summarized parts beyond the budgets are dropped

    const assistantToolBudget: number =
      params?.assistantToolBudget ?? ASSISTANT_TOOL_BUDGET
    const userBudget: number = params?.userBudget ?? USER_BUDGET

    function shouldExcludeMessage(message: Message): boolean {
      if (message.tags?.includes('INSTRUCTIONS_PROMPT')) return true
      if (message.tags?.includes('STEP_PROMPT')) return true
      if (message.tags?.includes('SUBAGENT_SPAWN')) return true
      return false
    }

    function isConversationSummary(message: Message): boolean {
      if (message.role !== 'user') return false
      // Provenance tag first — see CONVERSATION_SUMMARY_TAG in
      // packages/agent-runtime/src/compact-history.ts for why identity by
      // content alone is unsafe (a user message quoting the markers used to
      // steal the summary's identity and erase the older memory).
      if (message.tags?.includes('CONVERSATION_SUMMARY')) return true
      // Legacy fallback for summaries written before the tag existed: require
      // the full envelope, not just the bare tag a user can easily send.
      const text = getTextContent(message)
      return (
        text.includes('<conversation_summary>') &&
        text.includes('</conversation_summary>') &&
        text.includes(SUMMARY_HEADER) &&
        text.includes('<historical_memory>')
      )
    }

    function extractSummaryContent(message: Message): string {
      const text = getTextContent(message)
      const match = text.match(
        /<conversation_summary>([\s\S]*?)<\/conversation_summary>/,
      )
      if (!match) return ''
      let content = match[1].trim()
      if (content.startsWith(SUMMARY_HEADER)) {
        content = content.slice(SUMMARY_HEADER.length).trim()
      }
      const memoryMatch = content.match(
        /<historical_memory>([\s\S]*?)<\/historical_memory>/,
      )
      if (memoryMatch) {
        content = memoryMatch[1].trim()
      }
      return content
    }

    /**
     * Parses a previous summary text blob into role-tagged entries.
     * Splits on the --- separator and determines each chunk's role
     * based on its prefix marker.
     */
    function parseSummaryIntoEntries(
      summaryText: string,
    ): Array<{ role: 'user' | 'assistant_tool'; parts: string[] }> {
      if (!summaryText.trim()) return []

      const separator = '\n\n---\n\n'
      const chunks = summaryText.split(separator).filter((c) => c.trim())

      return chunks.map((chunk) => {
        const trimmed = chunk.trim()
        const isUser =
          trimmed.startsWith('[USER]') ||
          trimmed.startsWith('User request') ||
          trimmed.startsWith('User message') ||
          trimmed.startsWith('Current unresolved user request')
        return {
          role: isUser ? ('user' as const) : ('assistant_tool' as const),
          parts: [trimmed],
        }
      })
    }

    // Extract previous summary content from all messages
    let previousSummaryContent = ''
    for (const message of currentMessages) {
      if (isConversationSummary(message)) {
        previousSummaryContent = extractSummaryContent(message)
      }
    }

    // If pruning happens before the assistant has started responding to the
    // current user prompt, preserve that prompt as a real message after the
    // memory artifact. If pruning happens mid-turn, keep the prompt in the
    // historical memory with the assistant/tool progress that followed it and
    // append a synthetic continuation prompt instead.
    const latestLiveUserPromptIndex = currentMessages.findLastIndex((message) =>
      message.tags?.includes('USER_PROMPT'),
    )
    const latestLiveUserPromptMessage =
      latestLiveUserPromptIndex !== -1
        ? currentMessages[latestLiveUserPromptIndex]
        : null
    const isMidTurnPrune =
      latestLiveUserPromptIndex !== -1 &&
      currentMessages
        .slice(latestLiveUserPromptIndex + 1)
        .some(
          (message) =>
            !shouldExcludeMessage(message) && !isConversationSummary(message),
        )

    // Filter out excluded, conversation summary, and live-prompt messages for summarization
    const messagesToSummarize = currentMessages
      .filter(
        (_message, index) =>
          isMidTurnPrune || index !== latestLiveUserPromptIndex,
      )
      .filter(
        (message) =>
          !shouldExcludeMessage(message) && !isConversationSummary(message),
      )

    // Find the last user message with images to preserve in the final output
    let lastUserImageParts: Array<Record<string, unknown>> = []
    for (let i = messagesToSummarize.length - 1; i >= 0; i--) {
      const msg = messagesToSummarize[i]
      if (msg.role === 'user' && Array.isArray(msg.content)) {
        const imageParts = msg.content.filter(
          (part: Record<string, unknown>) =>
            part.type === 'image' || part.type === 'media',
        )
        if (imageParts.length > 0) {
          lastUserImageParts = imageParts
          break
        }
      }
    }

    // Phase 1: Summarize ALL messages into tagged entries
    type SummaryEntry = {
      role: 'user' | 'assistant_tool'
      parts: string[]
    }
    const summarizedEntries: SummaryEntry[] = []
    let liveUserPromptEntry: SummaryEntry | undefined

    for (const message of messagesToSummarize) {
      if (message.role === 'user') {
        let text = getTextContent(message).trim()
        if (text) {
          text = truncateLongText(text, USER_MESSAGE_LIMIT * CHARS_PER_TOKEN)
          let hasImages = false
          if (Array.isArray(message.content)) {
            hasImages = message.content.some(
              (part: Record<string, unknown>) =>
                part.type === 'image' || part.type === 'media',
            )
          }
          const imageNote = hasImages ? ' [image(s) were attached]' : ''
          const entry: SummaryEntry = {
            role: 'user',
            parts: [`[USER]${imageNote}\n${text}`],
          }
          if (message === latestLiveUserPromptMessage) {
            liveUserPromptEntry = entry
          }
          summarizedEntries.push(entry)
        }
      } else if (message.role === 'assistant') {
        const textParts: string[] = []
        const toolSummaries: string[] = []

        if (Array.isArray(message.content)) {
          for (const part of message.content) {
            if (part.type === 'text' && typeof part.text === 'string') {
              const textWithoutThinkTags = (part.text as string)
                .replace(/<think>[\s\S]*?<\/think>/g, '')
                .trim()
              if (textWithoutThinkTags) {
                textParts.push(textWithoutThinkTags)
              }
            } else if (part.type === 'tool-call') {
              const toolName = part.toolName as string
              const input = (part.input as Record<string, unknown>) || {}
              toolSummaries.push(summarizeToolCall(toolName, input))
            }
          }
        }

        const parts: string[] = []
        if (textParts.length > 0) {
          let combinedText = textParts.join('\n')
          combinedText = truncateLongText(
            combinedText,
            ASSISTANT_MESSAGE_LIMIT * CHARS_PER_TOKEN,
          )
          parts.push(`Progress note:\n${combinedText}`)
        }
        if (toolSummaries.length > 0) {
          parts.push(toolSummaries.join('\n'))
        }

        if (parts.length > 0) {
          summarizedEntries.push({
            role: 'assistant_tool',
            parts,
          })
        }
      } else if (message.role === 'tool') {
        const toolMessage = message as ToolMessage
        const entryParts: string[] = []

        if (Array.isArray(toolMessage.content)) {
          for (const part of toolMessage.content) {
            if (part.type === 'json' && part.value) {
              const value = part.value as Record<string, unknown>

              if (value.errorMessage || value.error) {
                let errorText = String(value.errorMessage || value.error)
                if (errorText.length > 100) {
                  errorText = errorText.slice(0, 100) + '...'
                }
                entryParts.push(
                  `Tool error from ${toolMessage.toolName}: ${errorText}`,
                )
              }

              if (
                toolMessage.toolName === 'run_terminal_command' &&
                'exitCode' in value
              ) {
                const exitCode = value.exitCode as number
                if (exitCode !== 0) {
                  entryParts.push(`Command failed with exit code: ${exitCode}`)
                }
              }

              if (toolMessage.toolName === 'ask_user') {
                if (value.skipped) {
                  entryParts.push('User skipped question')
                } else if ('answers' in value) {
                  const answers = value.answers as
                    | Array<{
                        selectedOption?: string
                        selectedOptions?: string[]
                        otherText?: string
                      }>
                    | undefined
                  if (answers && answers.length > 0) {
                    const answerTexts = answers
                      .map((a) => {
                        if (a.otherText) return a.otherText
                        if (a.selectedOptions)
                          return a.selectedOptions.join(', ')
                        if (a.selectedOption) return a.selectedOption
                        return '(no answer)'
                      })
                      .join('; ')
                    const truncated =
                      answerTexts.length > 10_000
                        ? answerTexts.slice(0, 10_000) + '...'
                        : answerTexts
                    entryParts.push(`User answered: ${truncated}`)
                  }
                }
              }

              if (
                toolMessage.toolName === 'str_replace' ||
                toolMessage.toolName === 'propose_str_replace' ||
                toolMessage.toolName === 'write_file' ||
                toolMessage.toolName === 'propose_write_file'
              ) {
                const resultStr = JSON.stringify(value)
                const truncatedResult =
                  resultStr.length > 2000
                    ? resultStr.slice(0, 2000) + '...'
                    : resultStr
                entryParts.push(
                  `Edit result from ${toolMessage.toolName}:\n${truncatedResult}`,
                )
              }
            }
          }
        }

        if (
          toolMessage.toolName === 'spawn_agents' &&
          Array.isArray(toolMessage.content)
        ) {
          for (const part of toolMessage.content) {
            if (part.type === 'json' && Array.isArray(part.value)) {
              const agentResults = part.value as Array<{
                agentName?: string
                agentType?: string
                value?: {
                  type?: string
                  value?: unknown
                }
              }>
              const includedResults = agentResults.filter(
                (r) =>
                  r.agentType &&
                  !SPAWN_AGENTS_OUTPUT_BLACKLIST.includes(r.agentType),
              )
              if (includedResults.length > 0) {
                const resultSummaries = includedResults.map((r) => {
                  let outputStr = ''
                  if (r.value?.value !== undefined && r.value?.value !== null) {
                    if (typeof r.value.value === 'string') {
                      outputStr = r.value.value
                    } else {
                      outputStr = JSON.stringify(r.value.value)
                    }
                    outputStr = outputStr
                      .replace(/<think>[\s\S]*?<\/think>/g, '')
                      .trim()
                    if (
                      outputStr.length >
                      ASSISTANT_MESSAGE_LIMIT * CHARS_PER_TOKEN
                    ) {
                      outputStr =
                        outputStr.slice(
                          0,
                          ASSISTANT_MESSAGE_LIMIT * CHARS_PER_TOKEN,
                        ) + '...'
                    }
                  }
                  return `- ${r.agentType}: ${outputStr || '(no output)'}`
                })
                entryParts.push(`Agent results:\n${resultSummaries.join('\n')}`)
              }
            }
          }
        }

        if (entryParts.length > 0) {
          const joinedToolEntry = truncateLongText(
            entryParts.join('\n\n'),
            TOOL_ENTRY_LIMIT * CHARS_PER_TOKEN,
          )
          summarizedEntries.push({
            role: 'assistant_tool',
            parts: [joinedToolEntry],
          })
        }
      }
    }

    // Parse previous summary into role-tagged entries and combine with new entries
    const previousSummaryEntries = parseSummaryIntoEntries(
      previousSummaryContent,
    )
    const allEntries: SummaryEntry[] = [
      ...previousSummaryEntries,
      ...summarizedEntries,
    ]

    // Phase 2: Walk backwards through all entries to apply token budgets.
    // Exhausting one role's budget must not evict entries from the other role:
    // user prompts are protected by the user budget independently of how much
    // assistant/tool history the conversation accumulated, and vice versa.
    let assistantToolTokens = 0
    let userTokens = 0
    let assistantToolBudgetExhausted = false
    let userBudgetExhausted = false
    const includedEntries: typeof allEntries = []

    for (let i = allEntries.length - 1; i >= 0; i--) {
      const entry = allEntries[i]
      const entryText = entry.parts.join('\n\n---\n\n')
      const entryTokens = Math.ceil(entryText.length / CHARS_PER_TOKEN)

      if (entry.role === 'user') {
        if (userBudgetExhausted) continue
        if (userTokens + entryTokens > userBudget) {
          userBudgetExhausted = true
          continue
        }
        userTokens += entryTokens
      } else {
        if (assistantToolBudgetExhausted) continue
        if (assistantToolTokens + entryTokens > assistantToolBudget) {
          assistantToolBudgetExhausted = true
          continue
        }
        assistantToolTokens += entryTokens
      }

      includedEntries.push(entry)
    }

    // Preserve the pre-existing guarantee that the newest entry always
    // survives, even when it alone exceeds its role's budget. With independent
    // role selection, entries from the other role may still fit, so the old
    // "summary is empty" fallback is no longer sufficient.
    const newestEntry = allEntries[allEntries.length - 1]
    let newestEntryForced = false
    if (newestEntry && !includedEntries.includes(newestEntry)) {
      // includedEntries is reverse-chronological until Phase 3.
      includedEntries.unshift(newestEntry)
      newestEntryForced = true
    }

    // Phase 3: Build final summary from included entries
    const summaryParts: string[] = []

    for (let i = includedEntries.length - 1; i >= 0; i--) {
      summaryParts.push(...includedEntries[i].parts)
    }

    const summaryText = summaryParts.join('\n\n---\n\n')

    // Create the summarized message with fresh sentAt timestamp
    // Include any images from the last user message that had images
    const now = Date.now()
    const textPart: TextPart = {
      type: 'text',
      text: `<conversation_summary>
${SUMMARY_HEADER}

<historical_memory>
${summaryText}
</historical_memory>
</conversation_summary>

${SUMMARY_DISCLAIMER}`,
    }
    // Build content array with text and any preserved images
    const summaryContentParts: (TextPart | ImagePart | FilePart)[] = [textPart]
    // Append image parts (they're already typed correctly from the original message)
    for (const part of lastUserImageParts) {
      summaryContentParts.push(part as ImagePart | FilePart)
    }
    const summarizedMessage: UserMessage = {
      role: 'user',
      content: summaryContentParts,
      sentAt: now,
      tags: ['CONVERSATION_SUMMARY'],
    }

    const continuationMessage: UserMessage = {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'Continue the existing assistant turn from the historical memory above. The original user request and completed assistant/tool work are recorded there. Do not restart completed work; resume with the next necessary real tool call or final response.',
        },
      ],
      sentAt: now,
    }

    // Build final messages array: summary first, then INSTRUCTIONS_PROMPT if it
    // exists, then either the live user prompt or a mid-turn continuation prompt.
    // Keeping a real user message last makes the next model step continue from
    // normal user input instead of the condensed memory format.
    const finalMessages: Message[] = [summarizedMessage]
    if (instructionsPromptMessage) {
      // Update sentAt to current time so future cache miss checks use fresh timestamps
      finalMessages.push({ ...instructionsPromptMessage, sentAt: now })
    }
    if (isMidTurnPrune) {
      finalMessages.push(continuationMessage)
    } else if (latestLiveUserPromptMessage) {
      finalMessages.push({ ...latestLiveUserPromptMessage, sentAt: now })
    }

    const userEntryCount = allEntries.filter(
      (entry) => entry.role === 'user',
    ).length
    const assistantToolEntryCount = allEntries.length - userEntryCount
    const liveUserPromptHasText = latestLiveUserPromptMessage
      ? getTextContent(latestLiveUserPromptMessage).trim().length > 0
      : false
    const liveUserPromptTextPreserved = latestLiveUserPromptMessage
      ? !isMidTurnPrune ||
        !liveUserPromptHasText ||
        (liveUserPromptEntry !== undefined &&
          includedEntries.includes(liveUserPromptEntry))
      : false
    const includedUserEntryCount = includedEntries.filter(
      (entry) => entry.role === 'user',
    ).length
    const includedAssistantToolEntryCount =
      includedEntries.length - includedUserEntryCount
    const triggerReason = contextLimitExceeded
      ? cacheWillMiss
        ? 'context_limit_and_cache_expiry'
        : 'context_limit'
      : 'cache_expiry'

    // Telemetry is best-effort and must never block the actual pruning update.
    try {
      logger.info(
        {
          axiomEvent: CONTEXT_PRUNING_COMPLETED_EVENT,
          agent_run_id: agentState.runId,
          parent_agent_run_id: agentState.parentId,
          trigger_reason: triggerReason,
          context_token_count: agentState.contextTokenCount,
          max_context_length: maxContextLength,
          ...(cacheGapMs === null ? {} : { cache_gap_ms: cacheGapMs }),
          cache_expiry_ms: CACHE_EXPIRY_MS,
          cache_expiry_min_tokens: CACHE_EXPIRY_MIN_TOKENS,
          previous_summary_entry_count: previousSummaryEntries.length,
          user_budget: userBudget,
          user_entry_count: userEntryCount,
          dropped_user_entry_count: userEntryCount - includedUserEntryCount,
          assistant_tool_budget: assistantToolBudget,
          assistant_tool_entry_count: assistantToolEntryCount,
          dropped_assistant_tool_entry_count:
            assistantToolEntryCount - includedAssistantToolEntryCount,
          mid_turn: isMidTurnPrune,
          live_user_prompt_found: latestLiveUserPromptMessage !== null,
          live_user_prompt_text_preserved: liveUserPromptTextPreserved,
          newest_entry_forced: newestEntryForced,
          summary_estimated_tokens: Math.ceil(
            summaryText.length / CHARS_PER_TOKEN,
          ),
        },
        'Context pruning completed',
      )
    } catch {
      // Ignore logging failures; set_messages below is the critical operation.
    }

    yield {
      toolName: 'set_messages',
      input: {
        messages: finalMessages,
      },
      includeToolCall: false,
    } satisfies ToolCall<'set_messages'>
  },
}

export default definition
