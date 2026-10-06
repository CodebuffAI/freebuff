import { enableMapSet } from 'immer'
import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'

import type { FeedbackCategory } from '@codebuff/common/constants/feedback'

// Drafts a Set and a Map through immer; see message-block-store for why each
// store enables the plugin itself.
enableMapSet()

interface FeedbackState {
  feedbackMessageId: string | null
  feedbackMode: boolean
  feedbackText: string
  feedbackCursor: number
  feedbackCategory: FeedbackCategory
  isSubmitting: boolean
  clientFeedbackId: string | null
  savedInputValue: string
  savedCursorPosition: number
  messagesWithFeedback: Set<string>
  messageFeedbackCategories: Map<string, FeedbackCategory>
  feedbackFooterMessage: string | null
  errors: Array<{ id: string; message: string }> | null
}

interface FeedbackActions {
  openFeedbackForMessage: (
    messageId: string | null,
    options?: {
      category?: FeedbackCategory
      footerMessage?: string
      errors?: Array<{ id: string; message: string }>
    },
  ) => void
  closeFeedback: () => void
  setFeedbackText: (text: string) => void
  setFeedbackCursor: (cursor: number) => void
  setFeedbackCategory: (category: FeedbackCategory) => void
  setIsSubmitting: (isSubmitting: boolean) => void
  saveCurrentInput: (value: string, cursor: number) => void
  restoreSavedInput: () => { value: string; cursor: number }
  markMessageFeedbackSubmitted: (messageId: string, category: FeedbackCategory) => void
  resetFeedbackForm: () => void
  reset: () => void
}

type FeedbackStore = FeedbackState & FeedbackActions

const initialState: FeedbackState = {
  feedbackMessageId: null,
  feedbackMode: false,
  feedbackText: '',
  feedbackCursor: 0,
  feedbackCategory: 'other',
  isSubmitting: false,
  clientFeedbackId: null,
  savedInputValue: '',
  savedCursorPosition: 0,
  messagesWithFeedback: new Set(),
  messageFeedbackCategories: new Map(),
  feedbackFooterMessage: null,
  errors: null,
}

export const useFeedbackStore = create<FeedbackStore>()(
  immer((set, get) => ({
    ...initialState,

    openFeedbackForMessage: (messageId, options) =>
      set((state) => {
        state.feedbackMessageId = messageId
        state.feedbackMode = true
        state.feedbackText = ''
        state.feedbackCursor = 0
        state.feedbackCategory = options?.category || 'other'
        state.isSubmitting = false
        state.clientFeedbackId = crypto.randomUUID()
        state.feedbackFooterMessage = options?.footerMessage || null
        state.errors = options?.errors || null
      }),

    closeFeedback: () =>
      set((state) => {
        state.feedbackMode = false
        state.feedbackMessageId = null
        state.clientFeedbackId = null
        state.feedbackText = ''
        state.feedbackCursor = 0
        state.feedbackCategory = 'other'
      }),

    setFeedbackText: (text) =>
      set((state) => {
        state.feedbackText = text
      }),

    setFeedbackCursor: (cursor) =>
      set((state) => {
        state.feedbackCursor = cursor
      }),

    setFeedbackCategory: (category) =>
      set((state) => {
        state.feedbackCategory = category
      }),

    setIsSubmitting: (isSubmitting) =>
      set((state) => {
        state.isSubmitting = isSubmitting
      }),

    saveCurrentInput: (value, cursor) =>
      set((state) => {
        state.savedInputValue = value
        state.savedCursorPosition = cursor
      }),

    restoreSavedInput: () => {
      const state = get()
      return {
        value: state.savedInputValue,
        cursor: state.savedCursorPosition,
      }
    },

    markMessageFeedbackSubmitted: (messageId, category) =>
      set((state) => {
        state.messagesWithFeedback.add(messageId)
        state.messageFeedbackCategories.set(messageId, category)
      }),

    resetFeedbackForm: () =>
      set((state) => {
        state.feedbackText = ''
        state.feedbackCursor = 0
        state.feedbackCategory = 'other'
        state.feedbackMessageId = null
        state.clientFeedbackId = null
        state.feedbackFooterMessage = null
        state.errors = null
      }),

    reset: () =>
      set(() => ({
        ...initialState,
        messagesWithFeedback: new Set(),
        messageFeedbackCategories: new Map(),
      })),
  }))
)

export const selectIsFeedbackOpenForMessage = (messageId: string) => (state: FeedbackStore) =>
  state.feedbackMode && state.feedbackMessageId === messageId
export const selectHasSubmittedFeedback = (messageId: string) => (state: FeedbackStore) =>
  state.messagesWithFeedback.has(messageId)
export const selectMessageFeedbackCategory = (messageId: string) => (state: FeedbackStore) =>
  state.messageFeedbackCategories.get(messageId)
