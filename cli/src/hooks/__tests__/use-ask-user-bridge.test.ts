import { AskUserBridge } from '@codebuff/common/utils/ask-user-bridge'
import {
  __resetShellApprovalBridge,
  getActiveShellApproval,
  requestShellApproval,
} from '@codebuff/common/utils/shell-approval-bridge'
import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test'


import {
  buildShellApprovalQuestions,
  escapeControlCharactersForDisplay,
  skipForm,
  submitAnswersForForm,
} from '../use-ask-user-bridge'

import type { AskUserFormAnswers } from '../use-ask-user-bridge'
import { useChatStore } from '../../state/chat-store'

describe('useAskUserBridge', () => {
  // Answers routed as a generic ask_user form (no shell-approval kind).
  const submitAnswers = (answers: AskUserFormAnswers) => {
    submitAnswersForForm(answers, { kind: 'ask-user', toolCallId: 'ask-user-1' })
  }

  const skip = () => {
    skipForm({ kind: 'ask-user', toolCallId: 'ask-user-1' })
  }

  let submitSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    // Mock AskUserBridge.submit to track calls
    submitSpy = spyOn(AskUserBridge, 'submit')

    // Reset the chat store to a known state with some input
    useChatStore.setState({
      inputValue: 'user input that should be preserved',
      cursorPosition: 35,
      lastEditDueToNav: false,
      askUserState: null,
    })
  })

  afterEach(() => {
    submitSpy.mockRestore()
  })

  describe('submitAnswers', () => {
    test('calls AskUserBridge.submit with the provided answers', () => {
      const answers = [
        { questionIndex: 0, selectedOption: 'Option A' },
        { questionIndex: 1, selectedOptions: ['Option B', 'Option C'] },
      ]

      submitAnswers(answers)

      expect(submitSpy).toHaveBeenCalledTimes(1)
      expect(submitSpy).toHaveBeenCalledWith({ answers })
    })

    test('does NOT modify the input value in the store', () => {
      const originalInputValue = useChatStore.getState().inputValue
      const originalCursorPosition = useChatStore.getState().cursorPosition

      submitAnswers([{ questionIndex: 0, selectedOption: 'Test' }])

      // Verify input value was NOT changed
      const currentState = useChatStore.getState()
      expect(currentState.inputValue).toBe(originalInputValue)
      expect(currentState.cursorPosition).toBe(originalCursorPosition)
    })

    test('preserves input value with empty answers array', () => {
      const originalInputValue = useChatStore.getState().inputValue

      submitAnswers([])

      expect(useChatStore.getState().inputValue).toBe(originalInputValue)
      expect(submitSpy).toHaveBeenCalledWith({ answers: [] })
    })

    test('preserves input value with multiple question answers', () => {
      const originalInputValue = useChatStore.getState().inputValue

      const answers = [
        { questionIndex: 0, selectedOption: 'First answer' },
        { questionIndex: 1, selectedOptions: ['Multi 1', 'Multi 2'] },
        { questionIndex: 2, otherText: 'Custom text input' },
      ]

      submitAnswers(answers)

      expect(useChatStore.getState().inputValue).toBe(originalInputValue)
    })
  })

  describe('skip', () => {
    test('calls AskUserBridge.submit with skipped: true', () => {
      skip()

      expect(submitSpy).toHaveBeenCalledTimes(1)
      expect(submitSpy).toHaveBeenCalledWith({ skipped: true })
    })

    test('does NOT modify the input value in the store', () => {
      const originalInputValue = useChatStore.getState().inputValue
      const originalCursorPosition = useChatStore.getState().cursorPosition

      skip()

      // Verify input value was NOT changed
      const currentState = useChatStore.getState()
      expect(currentState.inputValue).toBe(originalInputValue)
      expect(currentState.cursorPosition).toBe(originalCursorPosition)
    })
  })

  describe('input preservation regression tests', () => {
    test('input with special characters is preserved after submitAnswers', () => {
      useChatStore.setState({
        inputValue: 'Input with "quotes" and `backticks` and @mentions',
        cursorPosition: 48,
      })

      const originalInputValue = useChatStore.getState().inputValue

      submitAnswers([{ questionIndex: 0, selectedOption: 'Test' }])

      expect(useChatStore.getState().inputValue).toBe(originalInputValue)
    })

    test('input with special characters is preserved after skip', () => {
      useChatStore.setState({
        inputValue: "Don't lose this apostrophe or @file-picker mention",
        cursorPosition: 51,
      })

      const originalInputValue = useChatStore.getState().inputValue

      skip()

      expect(useChatStore.getState().inputValue).toBe(originalInputValue)
    })

    test('multiline input is preserved after submitAnswers', () => {
      useChatStore.setState({
        inputValue: 'Line 1\nLine 2\nLine 3',
        cursorPosition: 20,
      })

      const originalInputValue = useChatStore.getState().inputValue

      submitAnswers([{ questionIndex: 0, selectedOption: 'Test' }])

      expect(useChatStore.getState().inputValue).toBe(originalInputValue)
    })

    test('empty input remains empty after submitAnswers', () => {
      useChatStore.setState({
        inputValue: '',
        cursorPosition: 0,
      })

      submitAnswers([{ questionIndex: 0, selectedOption: 'Test' }])

      expect(useChatStore.getState().inputValue).toBe('')
      expect(useChatStore.getState().cursorPosition).toBe(0)
    })

    test('empty input remains empty after skip', () => {
      useChatStore.setState({
        inputValue: '',
        cursorPosition: 0,
      })

      skip()

      expect(useChatStore.getState().inputValue).toBe('')
      expect(useChatStore.getState().cursorPosition).toBe(0)
    })
  })

  // A shell approval is correlated by id. A late submission from an expired
  // form must never resolve the command that is active now.
  describe('shell approval routing', () => {
    beforeEach(() => {
      __resetShellApprovalBridge()
    })

    afterEach(() => {
      __resetShellApprovalBridge()
    })

    test('a stale answer for a timed-out request cannot approve the next command', async () => {
      // Command A is displayed and times out before the user answers it.
      const aVerdict = await requestShellApproval(
        { id: 'A', command: 'echo first-command', cwd: '/project', processType: 'SYNC' },
        { timeoutMs: 1 },
      )
      expect(aVerdict).toBe('deny')

      // Command B becomes the active request.
      let bVerdict: string | undefined
      const bSettled = requestShellApproval(
        { id: 'B', command: 'echo second-command', cwd: '/project', processType: 'SYNC' },
        { timeoutMs: 1000 },
      ).then((verdict) => {
        bVerdict = verdict
      })
      expect(getActiveShellApproval()?.id).toBe('B')

      // A delayed "Approve" from A's form still carries A's captured id.
      submitAnswersForForm(
        [{ questionIndex: 0, selectedOption: 'Approve' }],
        { kind: 'shell-approval', toolCallId: 'A' },
      )

      // B is untouched and the generic ask_user bridge was never used.
      expect(getActiveShellApproval()?.id).toBe('B')
      expect(bVerdict).toBeUndefined()
      expect(submitSpy).not.toHaveBeenCalled()

      // Answering B's own form resolves B.
      submitAnswersForForm(
        [{ questionIndex: 0, selectedOption: 'Approve' }],
        { kind: 'shell-approval', toolCallId: 'B' },
      )
      await bSettled
      expect(bVerdict).toBe('approve')
    })

    test('skipping a shell approval denies it rather than approving', async () => {
      const verdictPromise = requestShellApproval(
        { id: 'C', command: 'echo third-command', cwd: '/project', processType: 'SYNC' },
        { timeoutMs: 1000 },
      )

      skipForm({ kind: 'shell-approval', toolCallId: 'C' })

      expect(await verdictPromise).toBe('deny')
    })

    test('any answer other than Approve denies the command', async () => {
      const verdictPromise = requestShellApproval(
        { id: 'D', command: 'echo fourth-command', cwd: '/project', processType: 'SYNC' },
        { timeoutMs: 1000 },
      )

      submitAnswersForForm(
        [{ questionIndex: 0, selectedOption: 'Deny' }],
        { kind: 'shell-approval', toolCallId: 'D' },
      )

      expect(await verdictPromise).toBe('deny')
    })
  })

  describe('buildShellApprovalQuestions', () => {
    test('shows the exact command, working directory, and process type', () => {
      const questions = buildShellApprovalQuestions({
        command: 'bun test',
        cwd: '/work/project',
        processType: 'BACKGROUND',
      })

      const text = questions[0]!.question
      expect(text).toContain('background')
      expect(text).toContain('bun test')
      expect(text).toContain('/work/project')
    })

    test('escapes control characters without changing the authorized command', () => {
      const command = 'echo hi\u0007\u001b[31mred'
      const questions = buildShellApprovalQuestions({
        command,
        cwd: '/work',
        processType: 'SYNC',
      })

      const text = questions[0]!.question
      // Control characters are rendered as visible escapes...
      expect(text).toContain('\\u0007')
      expect(text).toContain('\\u001b')
      expect(text).not.toContain('\u0007')
      expect(text).not.toContain('\u001b')
      // ...but the raw command is only transformed for display.
      expect(escapeControlCharactersForDisplay(command)).not.toBe(command)
      expect(command).toContain('\u0007')
      expect(command).toContain('\u001b')
    })
  })
})
