import { UnsupportedFunctionalityError } from '@ai-sdk/provider'
import { convertToBase64 } from '@ai-sdk/provider-utils'

import type { OpenAICompatibleChatPrompt } from './openai-compatible-api-types'
import type {
  JSONValue,
  LanguageModelV2Prompt,
  SharedV2ProviderMetadata,
} from '@ai-sdk/provider'

function getOpenAIMetadata(message: {
  providerOptions?: SharedV2ProviderMetadata
}) {
  return message?.providerOptions?.openaiCompatible ?? {}
}

function imageUrlFromData(data: unknown, mediaType: string): string {
  // AI SDK 7 adapts this v2 provider to v4, whose file data is tagged. The
  // compatibility proxy passes that v4 shape through to the v2 implementation.
  if (data && typeof data === 'object' && 'type' in data) {
    if (data.type === 'data' && 'data' in data) {
      data = data.data
    } else if (data.type === 'url' && 'url' in data) {
      // The tagged `url` may be a plain string, not only a URL instance.
      data = data.url
    }
  }

  if (data instanceof URL) return data.toString()
  if (typeof data !== 'string' && !(data instanceof Uint8Array)) {
    throw new UnsupportedFunctionalityError({
      functionality: 'image file data that is not inline bytes or a URL',
    })
  }

  // Never re-prefix something that is already addressable. `convertToBase64`
  // passes a string through unchanged (it assumes the string IS base64), so
  // prefixing a value that already carries its own `data:` scheme yields
  // `data:image/png;base64,data:image/png;base64,…` — which the provider
  // rejects with the same "invalid base64-encoded value" 400 that the tagged
  // -shape handling above exists to prevent, just reached by another route.
  if (typeof data === 'string') {
    const trimmed = data.trim()
    if (trimmed.startsWith('data:') || /^https?:\/\//i.test(trimmed)) {
      return trimmed
    }
  }

  return `data:${mediaType};base64,${convertToBase64(data)}`
}

export function convertToOpenAICompatibleChatMessages(
  prompt: LanguageModelV2Prompt,
  options?: { providerOptionsName?: string; modelId?: string },
): OpenAICompatibleChatPrompt {
  const messages: OpenAICompatibleChatPrompt = []
  for (const { role, content, ...message } of prompt) {
    const metadata = getOpenAIMetadata({ ...message })
    switch (role) {
      case 'system': {
        messages.push({ role: 'system', content, ...metadata })
        break
      }

      case 'user': {
        messages.push({
          role: 'user',
          content: content.map((part) => {
            const partMetadata = getOpenAIMetadata(part)
            switch (part.type) {
              case 'text': {
                return { type: 'text', text: part.text, ...partMetadata }
              }
              case 'file': {
                if (
                  part.mediaType === 'image' ||
                  part.mediaType.startsWith('image/')
                ) {
                  const mediaType =
                    part.mediaType === 'image' || part.mediaType === 'image/*'
                      ? 'image/jpeg'
                      : part.mediaType

                  return {
                    type: 'image_url',
                    image_url: {
                      url: imageUrlFromData(part.data, mediaType),
                    },
                    ...partMetadata,
                  }
                } else {
                  throw new UnsupportedFunctionalityError({
                    functionality: `file part media type ${part.mediaType}`,
                  })
                }
              }
            }
          }),
          ...metadata,
        })

        break
      }

      case 'assistant': {
        let text = ''
        let reasoningContent = ''
        const reasoningDetails: JSONValue[] = []
        const toolCalls: Array<{
          id: string
          type: 'function'
          function: { name: string; arguments: string }
        }> = []

        for (const part of content) {
          const partMetadata = getOpenAIMetadata(part)
          switch (part.type) {
            case 'text': {
              text += part.text
              break
            }
            case 'reasoning': {
              reasoningContent += part.text
              // Replay OpenRouter reasoning blocks (carrying the provider's
              // thinking signatures) captured on the response — see the
              // language model's reasoning_details assembly. Signatures are
              // only valid for the model that produced them, so blocks
              // captured from a different model (fallback, mid-thread model
              // switch) are dropped rather than replayed.
              const namespaces = options?.providerOptionsName
                ? [part.providerOptions?.[options.providerOptionsName]]
                : Object.values(part.providerOptions ?? {})
              for (const namespace of namespaces) {
                const details = namespace?.reasoning_details
                if (!Array.isArray(details)) continue
                const detailsModel = namespace?.model
                if (
                  typeof detailsModel === 'string' &&
                  options?.modelId !== undefined &&
                  detailsModel !== options.modelId
                ) {
                  continue
                }
                reasoningDetails.push(...details)
              }
              break
            }
            case 'tool-call': {
              toolCalls.push({
                id: part.toolCallId,
                type: 'function',
                function: {
                  name: part.toolName,
                  arguments: JSON.stringify(part.input),
                },
                ...partMetadata,
              })
              break
            }
          }
        }

        // Emit one wire message per run of assistant messages. Thinking models
        // that validate tool-call replay (e.g. DeepSeek V4) require the step's
        // reasoning_content to sit ON the message carrying tool_calls — a
        // separate adjacent assistant message fails the request — so merge
        // instead of pushing a second assistant message.
        const previous = messages[messages.length - 1]
        if (previous?.role === 'assistant') {
          if (text.length > 0) {
            previous.content =
              typeof previous.content === 'string'
                ? previous.content + text
                : text
          }
          // reasoning_details already carry the reasoning text (plus the
          // provider's signatures), so emit the plain-text copy only when no
          // details exist for this run.
          if (reasoningDetails.length > 0) {
            previous.reasoning_details = [
              ...(previous.reasoning_details ?? []),
              ...reasoningDetails,
            ]
          } else if (reasoningContent.length > 0) {
            previous.reasoning_content =
              typeof previous.reasoning_content === 'string'
                ? previous.reasoning_content + reasoningContent
                : reasoningContent
          }
          if (toolCalls.length > 0) {
            previous.tool_calls = [...(previous.tool_calls ?? []), ...toolCalls]
          }
          // Metadata unions with later-wins precedence — the same key
          // precedence the push path gets from spreading metadata last.
          Object.assign(previous, metadata)
          break
        }

        messages.push({
          role: 'assistant',
          content: text,
          reasoning_content:
            reasoningDetails.length === 0 && reasoningContent.length > 0
              ? reasoningContent
              : undefined,
          reasoning_details:
            reasoningDetails.length > 0 ? reasoningDetails : undefined,
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
          ...metadata,
        })

        break
      }

      case 'tool': {
        for (const toolResponse of content) {
          const output = toolResponse.output

          let contentValue: string
          switch (output.type) {
            case 'text':
            case 'error-text':
              contentValue = output.value
              break
            case 'content':
            case 'json':
            case 'error-json':
              contentValue = JSON.stringify(output.value)
              break
          }

          const toolResponseMetadata = getOpenAIMetadata(toolResponse)
          messages.push({
            role: 'tool',
            tool_call_id: toolResponse.toolCallId,
            content: contentValue,
            ...toolResponseMetadata,
          })
        }
        break
      }

      default: {
        const _exhaustiveCheck: never = role
        throw new Error(`Unsupported role: ${_exhaustiveCheck}`)
      }
    }
  }

  return messages
}
