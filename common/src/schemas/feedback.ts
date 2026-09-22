import { z } from 'zod/v4'

import {
  FEEDBACK_CATEGORIES,
  FEEDBACK_RATINGS,
  FEEDBACK_SOURCES,
  MAX_ERRORS,
  MAX_ERROR_ID_LENGTH,
  MAX_ERROR_MESSAGE_LENGTH,
  MAX_RECENT_MESSAGES,
  MESSAGE_VARIANTS,
} from '../constants/feedback'

export const feedbackRequestSchema = z.object({
  /**
   * Deliberately NOT `.min(1)` and deliberately NOT capped.
   *
   * Not `.min(1)`, because a thumbs-up carries no prose and refusing it would
   * throw away the cheapest signal we have; the `rating` refinement below is
   * what keeps an empty body from being a legal ordinary submission.
   *
   * Not capped, because the only consumer that cares about length — the
   * feedback-hub envelope — TRUNCATES (`BODY_MAX_CODEPOINTS`). A ceiling here
   * would turn a pasted 30k-character log into a 400, which loses the report
   * instead of the tail of it.
   */
  text: z.string().trim(),
  category: z.enum(FEEDBACK_CATEGORIES),
  type: z.enum(['message', 'general']),
  clientFeedbackId: z.string().uuid().optional(),
  source: z.enum(FEEDBACK_SOURCES).optional(),
  /** Set when the submission came from a thumb rather than a form. */
  rating: z.enum(FEEDBACK_RATINGS).optional(),
  appVersion: z.string().max(100).optional(),
  platform: z.string().max(100).optional(),
  messageId: z.string().min(1).max(200).optional(),
  messageVariant: z.enum(MESSAGE_VARIANTS).optional(),
  completionTime: z.string().max(50).optional(),
  credits: z.number().nonnegative().finite().optional(),
  agentMode: z.string().max(100).optional(),
  sessionCreditsUsed: z.number().nonnegative().finite().optional(),
  recentMessages: z
    .array(
      z.object({
        type: z.enum(MESSAGE_VARIANTS),
        id: z.string().max(200),
        completionTime: z.string().max(50).optional(),
        credits: z.number().nonnegative().finite().optional(),
      }),
    )
    .max(MAX_RECENT_MESSAGES)
    .optional(),
  errors: z
    .array(
      z.object({
        id: z.string().max(MAX_ERROR_ID_LENGTH),
        message: z.string().max(MAX_ERROR_MESSAGE_LENGTH),
      }),
    )
    .max(MAX_ERRORS)
    .optional(),
}).refine(
  (data) => data.type !== 'message' || (data.messageId != null && data.messageId !== ''),
  { message: 'messageId is required when type is "message"', path: ['messageId'] },
).refine(
  (data) => data.rating != null || data.text.length > 0,
  { message: 'text is required unless a rating is given', path: ['text'] },
)

export type FeedbackRequest = z.infer<typeof feedbackRequestSchema>
