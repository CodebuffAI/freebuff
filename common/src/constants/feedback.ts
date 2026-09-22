export const FEEDBACK_CATEGORIES = ['good_result', 'bad_result', 'app_bug', 'other'] as const
export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number]

export const FEEDBACK_SOURCES = ['cli', 'desktop', 'sdk', 'web'] as const
export type FeedbackSource = (typeof FEEDBACK_SOURCES)[number]

export const MESSAGE_VARIANTS = ['ai', 'user', 'agent', 'error'] as const
export type MessageVariant = (typeof MESSAGE_VARIANTS)[number]

export const MAX_RECENT_MESSAGES = 10
export const MAX_ERRORS = 50
export const MAX_ERROR_MESSAGE_LENGTH = 2000
export const MAX_ERROR_ID_LENGTH = 200

/**
 * A one-click verdict on a single assistant message.
 *
 * `rating` and `category` are NOT redundant. `category` says what kind of
 * feedback this is and is set in every surface's form; `rating` says the user
 * expressed it by pressing a thumb rather than by filling one in. Keeping them
 * apart is what lets a query separate "34 people chose Bad result in the modal"
 * from "34 people thumbed a message down", which are different signals about
 * different amounts of effort.
 *
 * A rated submission is the one case where `text` may be empty: the whole
 * point of a thumb is that it costs nothing, and demanding prose to record it
 * would collect the opinions of the patient and no one else.
 */
export const FEEDBACK_RATINGS = ['up', 'down'] as const
export type FeedbackRating = (typeof FEEDBACK_RATINGS)[number]

/** The category a thumb stands for, so every surface agrees on the mapping. */
export const FEEDBACK_CATEGORY_FOR_RATING: Record<
  FeedbackRating,
  FeedbackCategory
> = {
  up: 'good_result',
  down: 'bad_result',
}
