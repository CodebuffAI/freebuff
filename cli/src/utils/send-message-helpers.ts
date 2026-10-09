/**
 * Message-level helpers for send-message logic.
 * These functions operate on ChatMessage objects, not raw blocks.
 * For block-level operations, import from message-block-helpers.ts or block-operations.ts.
 */

import { has } from 'lodash'

import { AI_MESSAGE_ID_PREFIX, generateAiMessageId } from './ai-message-id'
import { markRunningAgentsAsCancelled } from './block-operations'
import { formatTimestamp } from './helpers'
import {
  appendInterruptionNotice,
  autoCollapseBlocks,
  stripHiddenAgentBlocks,
} from './message-block-helpers'

import type { AgentMode } from './constants'
import type { ChatMessage } from '../types/chat'

// -----------------------------------------------------------------------------
// Message Creation Helpers
// -----------------------------------------------------------------------------

export const createModeDividerMessage = (
  agentMode: AgentMode,
): ChatMessage => ({
  id: `divider-${Date.now()}`,
  variant: 'ai',
  content: '',
  blocks: [
    {
      type: 'mode-divider',
      mode: agentMode,
    },
  ],
  timestamp: formatTimestamp(),
})

export const createAiMessageShell = (messageId: string): ChatMessage => ({
  id: messageId,
  variant: 'ai',
  content: '',
  blocks: [],
  timestamp: formatTimestamp(),
  metadata: { allowInlineAds: true },
})

export const createErrorMessage = (content: string): ChatMessage => ({
  id: `error-${Date.now()}`,
  variant: 'error',
  content,
  timestamp: formatTimestamp(),
})

// Re-exported (imported above) from a dependency-free leaf module so lightweight
// consumers can import the id prefix without dragging in this helper graph.
// Shared with sanitizeRestoredMessages so the two can't silently drift apart.
export { AI_MESSAGE_ID_PREFIX, generateAiMessageId }

/**
 * A restored chat may contain an AI response that was still streaming when the
 * process died (checkpoint saves persist in-flight turns). Mark it complete
 * with an interruption notice so it doesn't render as still in progress.
 * Only touches streamed response shells (ids from generateAiMessageId) —
 * other 'ai'-variant messages (mode dividers, system notices, bash results)
 * are never marked complete by design.
 *
 * Also drops hidden agent blocks (e.g. context-pruner) that were persisted
 * before live streams filtered them.
 */
export const sanitizeRestoredMessages = (
  messages: ChatMessage[],
): ChatMessage[] =>
  messages.map((message) => {
    let restoredMessage = message
    if (message.metadata?.allowInlineAds) {
      const { allowInlineAds: _, ...metadata } = message.metadata
      restoredMessage = { ...message, metadata }
    }

    if (restoredMessage.blocks) {
      const blocks = stripHiddenAgentBlocks(restoredMessage.blocks)
      if (blocks !== restoredMessage.blocks) {
        restoredMessage = { ...restoredMessage, blocks }
      }
    }

    if (
      restoredMessage.variant !== 'ai' ||
      !restoredMessage.id.startsWith(AI_MESSAGE_ID_PREFIX) ||
      restoredMessage.isComplete
    ) {
      return restoredMessage
    }
    try {
      return {
        ...restoredMessage,
        isComplete: true,
        blocks: appendInterruptionNotice(
          markRunningAgentsAsCancelled(restoredMessage.blocks ?? []),
        ),
      }
    } catch {
      // Corrupted persisted blocks (e.g. null entries) must not prevent the
      // chat from restoring; keep the message as-is.
      return { ...restoredMessage, isComplete: true }
    }
  })

// -----------------------------------------------------------------------------
// Auto-Collapse Logic
// -----------------------------------------------------------------------------

export const autoCollapsePreviousMessages = (
  messages: ChatMessage[],
  currentAiMessageId: string,
): ChatMessage[] =>
  messages.map((message) => {
    if (message.id === currentAiMessageId) {
      return message
    }

    if (message.variant === 'agent') {
      const userOpened = message.metadata?.userOpened ?? false
      return userOpened
        ? message
        : {
            ...message,
            metadata: {
              ...message.metadata,
              isCollapsed: true,
            },
          }
    }

    if (!message.blocks) {
      return message
    }

    return {
      ...message,
      blocks: autoCollapseBlocks(message.blocks),
    }
  })

// -----------------------------------------------------------------------------
// Spawn Agents Helpers
// -----------------------------------------------------------------------------

export const isSpawnAgentsResult = (outputValue: unknown): boolean =>
  Array.isArray(outputValue) &&
  outputValue.some((v: unknown) => {
    if (typeof v !== 'object' || v === null) return false
    return has(v, 'agentName') || has(v, 'agentType')
  })
