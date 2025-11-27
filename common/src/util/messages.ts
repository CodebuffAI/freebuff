import { cloneDeep, has, isEqual } from 'lodash'

import type {
  AssistantMessage,
  AuxiliaryMessageData,
  Message,
  SystemMessage,
  ToolMessage,
  UserMessage,
} from '../types/messages/codebuff-message'
import type { ProviderMetadata } from '../types/messages/provider-metadata'
import type {
  AssistantModelMessage,
  ModelMessage,
  SystemModelMessage,
  ToolModelMessage,
  UserModelMessage,
} from 'ai'

export function toContentString(msg: ModelMessage): string {
  const { content } = msg
  if (typeof content === 'string') return content
  return content.map((item) => (item as any)?.text ?? '').join('\n')
}

export function withCacheControl<
  T extends { providerOptions?: ProviderMetadata },
>(obj: T): T {
  const wrapper = cloneDeep(obj)
  if (!wrapper.providerOptions) {
    wrapper.providerOptions = {}
  }

  /* 'codebuff' provider name is not compatible with providerMetadata for
   * messages, so we need to use 'openaiCompatible' instead.
   * https://github.com/vercel/ai/blob/8e4fdac31b4f8c6a8d07a606a8833e74adf99470/packages/openai-compatible/src/chat/convert-to-openai-compatible-chat-messages.ts#L9
   */
  for (const provider of [
    'anthropic',
    'openrouter',
    'openaiCompatible',
  ] as const) {
    if (!wrapper.providerOptions[provider]) {
      wrapper.providerOptions[provider] = {}
    }
    wrapper.providerOptions[provider].cache_control = { type: 'ephemeral' }
  }

  return wrapper
}

export function withoutCacheControl<
  T extends { providerOptions?: ProviderMetadata },
>(obj: T): T {
  const wrapper = cloneDeep(obj)

  for (const provider of [
    'anthropic',
    'openrouter',
    'openaiCompatible',
  ] as const) {
    if (has(wrapper.providerOptions?.[provider]?.cache_control, 'type')) {
      delete wrapper.providerOptions?.[provider]?.cache_control?.type
    }
    if (
      Object.keys(wrapper.providerOptions?.[provider]?.cache_control ?? {})
        .length === 0
    ) {
      delete wrapper.providerOptions?.[provider]?.cache_control
    }
    if (Object.keys(wrapper.providerOptions?.[provider] ?? {}).length === 0) {
      delete wrapper.providerOptions?.[provider]
    }
  }

  if (Object.keys(wrapper.providerOptions ?? {}).length === 0) {
    delete wrapper.providerOptions
  }

  return wrapper
}

type NonStringContent<T extends { content: any }> = Omit<T, 'content'> & {
  content: Exclude<T['content'], string>
}
type ModelMessageWithAuxiliaryData = (
  | SystemModelMessage
  | NonStringContent<UserModelMessage>
  | NonStringContent<AssistantModelMessage>
  | ToolModelMessage
) &
  AuxiliaryMessageData

function assistantToCodebuffMessage(
  message: Omit<AssistantMessage, 'content'> & {
    content: Exclude<AssistantMessage['content'], string>[number]
  },
): AssistantMessage {
  // if (message.content.type === 'tool-call') {
  //   return cloneDeep({
  //     ...message,
  //     content: [
  //       {
  //         type: 'text',
  //         text: getToolCallString(
  //           message.content.toolName,
  //           message.content.input,
  //           false,
  //         ),
  //       },
  //     ],
  //   })
  // }
  return cloneDeep({ ...message, content: [message.content] })
}

function convertToolResultMessage(
  message: ToolMessage,
): ModelMessageWithAuxiliaryData[] {
  const messages: ModelMessageWithAuxiliaryData[] = [
    cloneDeep<ToolModelMessage>({
      ...message,
      role: 'tool',
      content: [
        {
          ...message,
          output: { type: 'json', value: message.content.value },
          type: 'tool-result',
        },
      ],
    }),
  ]

  for (const c of message.content.media ?? []) {
    messages.push(
      cloneDeep<UserMessage>({
        ...message,
        role: 'user',
        content: [{ type: 'file', data: c.data, mediaType: c.mediaType }],
      }),
    )
  }

  return messages
}

function convertToolMessage(message: Message): ModelMessageWithAuxiliaryData[] {
  if (message.role === 'system') {
    return [
      {
        ...message,
        content: message.content.map(({ text }) => text).join('\n\n'),
      },
    ]
  }
  if (message.role === 'user') {
    return [cloneDeep(message)]
  }
  if (message.role === 'assistant') {
    if (typeof message.content === 'string') {
      return [
        cloneDeep({
          ...message,
          content: [{ type: 'text' as const, text: message.content }],
        }),
      ]
    }
    return message.content.map((c) => {
      return assistantToCodebuffMessage({
        ...message,
        content: c,
      })
    })
  }
  if (message.role === 'tool') {
    return convertToolResultMessage(message)
  }
  message satisfies never
  const messageAny = message as any
  throw new Error(`Invalid message role: ${messageAny.role}`)
}

function convertToolMessages(
  messages: Message[],
): ModelMessageWithAuxiliaryData[] {
  const withoutToolMessages: ModelMessageWithAuxiliaryData[] = []
  for (const message of messages) {
    withoutToolMessages.push(...convertToolMessage(message))
  }
  return withoutToolMessages
}

export function convertCbToModelMessages({
  messages,
  includeCacheControl = true,
}: {
  messages: Message[]
  includeCacheControl?: boolean
}): ModelMessage[] {
  const toolMessagesConverted: ModelMessageWithAuxiliaryData[] =
    convertToolMessages(messages)

  const aggregated: ModelMessageWithAuxiliaryData[] = []
  for (const message of toolMessagesConverted) {
    if (aggregated.length === 0) {
      aggregated.push(message)
      continue
    }

    const lastMessage = aggregated[aggregated.length - 1]
    if (
      lastMessage.timeToLive !== message.timeToLive ||
      !isEqual(lastMessage.providerOptions, message.providerOptions) ||
      !isEqual(lastMessage.tags, message.tags)
    ) {
      aggregated.push(message)
      continue
    }
    if (lastMessage.role === 'system' && message.role === 'system') {
      lastMessage.content += '\n\n' + message.content
      continue
    }
    if (lastMessage.role === 'user' && message.role === 'user') {
      lastMessage.content.push(...message.content)
      continue
    }
    if (lastMessage.role === 'assistant' && message.role === 'assistant') {
      lastMessage.content.push(...message.content)
      continue
    }

    aggregated.push(message)
  }

  if (!includeCacheControl) {
    return aggregated
  }

  // Add cache control to specific messages (max of 4 can be marked for caching!):
  // - The message right before the three tagged messages
  // - Last message
  for (const tag of [
    'LAST_ASSISTANT_MESSAGE',
    'USER_PROMPT',
    'STEP_PROMPT',
    undefined, // Last message
  ] as const) {
    let index =
      tag === 'LAST_ASSISTANT_MESSAGE'
        ? aggregated.findLastIndex((m) => m.role === 'assistant')
        : tag
          ? aggregated.findLastIndex((m) => m.tags?.includes(tag))
          : aggregated.length
    if (index <= 0) {
      continue
    }

    // Iterate to find the last "valid" message that we can cache control
    let prevMessage: (typeof aggregated)[number]
    let contentBlock: (typeof prevMessage)['content']
    addCacheControlLoop: while (true) {
      index--

      // No message found
      if (index < 0) {
        break
      }

      prevMessage = aggregated[index]
      contentBlock = prevMessage.content

      if (typeof contentBlock === 'string') {
        // This must be a system message
        aggregated[index] = withCacheControl(aggregated[index])
        break
      }

      // Iterate to find the last valid content part (not a very short string)
      let lastContentIndex = contentBlock.length
      let lastContentPart: (typeof contentBlock)[number]
      while (true) {
        lastContentIndex--
        lastContentPart = contentBlock[lastContentIndex]

        if (lastContentIndex < 0) {
          // Continue searching in next message
          break
        }

        if (lastContentPart.type !== 'text') {
          contentBlock[lastContentIndex] = withCacheControl(
            contentBlock[lastContentIndex],
          )
          break addCacheControlLoop
        }

        prevMessage.content = [
          ...contentBlock.slice(0, lastContentIndex),
          withCacheControl(lastContentPart),
          ...contentBlock.slice(lastContentIndex + 1),
        ] as typeof contentBlock

        break addCacheControlLoop
      }
      break
    }
  }

  return aggregated
}

// type NoContent<T> = T & { content?: never }
export type SystemContent =
  | string
  | SystemMessage['content'][number]
  | SystemMessage['content']
export function systemContent(
  content: SystemContent,
): SystemMessage['content'] {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }]
  }
  if (Array.isArray(content)) {
    return content
  }
  return [content]
}

export function systemMessage(
  params:
    | SystemContent
    | ({
        content: SystemContent
      } & Omit<SystemMessage, 'role' | 'content'>),
): SystemMessage {
  if (typeof params === 'object' && 'content' in params) {
    return {
      ...params,
      role: 'system',
      content: systemContent(params.content),
    }
  }
  return {
    role: 'system',
    content: systemContent(params),
  }
}

export type UserContent =
  | string
  | UserMessage['content'][number]
  | UserMessage['content']
export function userContent(content: UserContent): UserMessage['content'] {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }]
  }
  if (Array.isArray(content)) {
    return content
  }
  return [content]
}

export function userMessage(
  params:
    | UserContent
    | ({
        content: UserContent
      } & Omit<UserMessage, 'role' | 'content'>),
): UserMessage {
  if (typeof params === 'object' && 'content' in params) {
    return {
      ...params,
      role: 'user',
      content: userContent(params.content),
    }
  }
  return {
    role: 'user',
    content: userContent(params),
  }
}

export type AssistantContent =
  | string
  | AssistantMessage['content'][number]
  | AssistantMessage['content']
export function assistantContent(
  content: AssistantContent,
): AssistantMessage['content'] {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }]
  }
  if (Array.isArray(content)) {
    return content
  }
  return [content]
}

export function assistantMessage(
  params:
    | AssistantContent
    | ({
        content: AssistantContent
      } & Omit<AssistantMessage, 'role' | 'content'>),
): AssistantMessage {
  if (typeof params === 'object' && 'content' in params) {
    return {
      ...params,
      role: 'assistant',
      content: assistantContent(params.content),
    }
  }
  return {
    role: 'assistant',
    content: assistantContent(params),
  }
}
