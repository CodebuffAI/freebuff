import { AskUserBridge } from '@codebuff/common/utils/ask-user-bridge'
import {
  subscribeShellApprovals,
  submitShellApproval,
  getActiveShellApproval,
} from '@codebuff/common/utils/shell-approval-bridge'
import { useEffect } from 'react'

import { useChatStore } from '../state/chat-store'

import type { AskUserQuestion } from '../types/store'

/**
 * Patterns that indicate a "custom" or "other" catch-all option.
 * These are redundant since the UI automatically provides a Custom text input.
 */
const REDUNDANT_OPTION_PATTERNS = [
  /^custom$/i,
  /^other$/i,
  /^none\s*(of\s*the\s*above)?$/i,
  /^something\s*else$/i,
  /^enter\s*(my\s*)?own$/i,
  /^type\s*(my\s*)?own$/i,
  /^write\s*(my\s*)?own$/i,
]

/**
 * Gets the label from an option, handling both string and object formats.
 */
function getOptionLabel(option: string | { label: string; description?: string }): string {
  return typeof option === 'string' ? option : option.label
}

/**
 * Checks if an option label matches any of the redundant "custom/other" patterns.
 */
function isRedundantOption(option: string | { label: string; description?: string }): boolean {
  const label = getOptionLabel(option).trim()
  return REDUNDANT_OPTION_PATTERNS.some((pattern) => pattern.test(label))
}

/**
 * Filters out redundant "Custom"/"Other" options from questions.
 * The UI already provides a Custom text input, so these are unnecessary and confusing.
 */
function filterRedundantOptions(questions: AskUserQuestion[]): AskUserQuestion[] {
  return questions.map((question) => {
    const filteredOptions = question.options.filter((option) => !isRedundantOption(option))
    return {
      ...question,
      // Preserve the original array type (string[] or object[])
      options: filteredOptions as typeof question.options,
    }
  })
}

/** A submitted answer plus the identity of the form it was rendered for. */
export type AskUserFormAnswers = Array<{
  questionIndex: number
  selectedOption?: string
  selectedOptions?: string[]
  otherText?: string
}>

/** The identity of the form an answer was rendered for. */
export type AskUserFormIdentity = {
  kind?: 'ask-user' | 'shell-approval'
  toolCallId: string
}

/**
 * Render arbitrary command text on one line without letting terminal control
 * characters (newlines, escapes, bell, ...) rewrite the prompt. This is display
 * only: the command that is actually authorized is passed through untouched.
 */
export function escapeControlCharactersForDisplay(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]/g, (char) => {
    switch (char) {
      case '\n':
        return '\\n'
      case '\r':
        return '\\r'
      case '\t':
        return '\\t'
      default:
        return `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
    }
  })
}

/**
 * Build the approval question for one command. It shows the exact command, the
 * working directory, and whether the command runs synchronously or in the
 * background, so the user approves precisely what will run.
 */
export function buildShellApprovalQuestions(request: {
  command: string
  cwd: string
  processType: 'SYNC' | 'BACKGROUND'
}): AskUserQuestion[] {
  const mode =
    request.processType === 'BACKGROUND' ? 'in the background' : 'synchronously'
  return [
    {
      question: [
        `Run this command ${mode}?`,
        '',
        `  ${escapeControlCharactersForDisplay(request.command)}`,
        '',
        `Working directory: ${escapeControlCharactersForDisplay(request.cwd)}`,
      ].join('\n'),
      header: 'Shell access',
      options: [
        { label: 'Approve', description: 'Run the command once' },
        { label: 'Deny', description: 'Do not run the command' },
      ],
      multiSelect: false,
    },
  ]
}

/**
 * Route a submitted answer to the request it was rendered for. The caller
 * passes the form identity captured when the form was shown, so a late
 * submission for an expired request can never resolve a newer one.
 */
export function submitAnswersForForm(
  answers: AskUserFormAnswers,
  form: AskUserFormIdentity | null,
): void {
  if (form?.kind === 'shell-approval') {
    const verdict =
      answers[0]?.selectedOption === 'Approve' ? 'approve' : 'deny'
    submitShellApproval(form.toolCallId, verdict)
    return
  }
  // Don't clear input value - preserve user's input from before the questionnaire
  AskUserBridge.submit({ answers })
}

/** Route a skip to the request it was rendered for. Skipping denies. */
export function skipForm(form: AskUserFormIdentity | null): void {
  if (form?.kind === 'shell-approval') {
    // Skipping an approval is a denial, never an implicit approval.
    submitShellApproval(form.toolCallId, 'deny')
    return
  }
  // Don't clear input value - preserve user's input from before the questionnaire
  AskUserBridge.submit({ skipped: true })
}

export function useAskUserBridge() {
  const setAskUserState = useChatStore((state) => state.setAskUserState)

  useEffect(() => {
    const unsubAsk = AskUserBridge.subscribe((request) => {
      // A shell approval owns the form while it is active; don't clobber it.
      if (getActiveShellApproval()) return
      if (request) {
        // Filter out redundant "Custom"/"Other" options since UI provides its own
        const filteredQuestions = filterRedundantOptions(request.questions)
        setAskUserState({
          kind: 'ask-user',
          toolCallId: request.toolCallId,
          questions: filteredQuestions,
          // Initialize based on question type: multi-select → [], single-select → -1
          selectedAnswers: filteredQuestions.map((q) => (q.multiSelect ? [] : -1)),
          otherTexts: new Array(filteredQuestions.length).fill(''),
        })
      } else {
        setAskUserState(null)
      }
    })

    // Surface shell-approval requests through the same form. The correlated
    // bridge serializes them, so exactly one is active at a time.
    const unsubShell = subscribeShellApprovals((active) => {
      if (active) {
        const questions = buildShellApprovalQuestions(active)
        setAskUserState({
          kind: 'shell-approval',
          toolCallId: active.id,
          questions,
          selectedAnswers: questions.map((q) => (q.multiSelect ? [] : -1)),
          otherTexts: new Array(questions.length).fill(''),
        })
      } else if (!AskUserBridge.getPendingRequest()) {
        setAskUserState(null)
      }
    })

    return () => {
      unsubAsk()
      unsubShell()
    }
  }, [setAskUserState])

  return {
    submitAnswers: (answers: AskUserFormAnswers, form: AskUserFormIdentity | null) =>
      submitAnswersForForm(answers, form),
    skip: (form: AskUserFormIdentity | null) => skipForm(form),
  }
}
