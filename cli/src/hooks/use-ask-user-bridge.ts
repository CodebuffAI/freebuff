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

/** The single question the shell-approval prompt renders. */
const SHELL_APPROVAL_QUESTIONS: AskUserQuestion[] = [
  {
    question: 'Allow this shell command to run?',
    header: 'Shell access',
    options: [
      { label: 'Approve', description: 'Run the command once' },
      { label: 'Deny', description: 'Do not run the command' },
    ],
    multiSelect: false,
  },
]

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
        setAskUserState({
          toolCallId: active.id,
          questions: SHELL_APPROVAL_QUESTIONS,
          selectedAnswers: [-1],
          otherTexts: [''],
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

  const submitAnswers = (
    answers: Array<{
      questionIndex: number
      selectedOption?: string
      selectedOptions?: string[]
      otherText?: string
    }>
  ) => {
    // Route to the correlated shell-approval bridge when an approval is active.
    const active = getActiveShellApproval()
    if (active) {
      const verdict = answers[0]?.selectedOption === 'Approve' ? 'approve' : 'deny'
      submitShellApproval(active.id, verdict)
      return
    }
    // Don't clear input value - preserve user's input from before the questionnaire
    AskUserBridge.submit({ answers })
  }

  const skip = () => {
    const active = getActiveShellApproval()
    if (active) {
      // Skipping an approval is a denial, never an implicit approval.
      submitShellApproval(active.id, 'deny')
      return
    }
    // Don't clear input value - preserve user's input from before the questionnaire
    AskUserBridge.submit({ skipped: true })
  }

  return { submitAnswers, skip }
}
