import { describe, expect, test } from 'bun:test'

import {
  BASE3_BATCHING_STEP_PROMPT,
  BASE3_BATCHING_STEP_PROMPT_PREVIOUS,
} from '../../constants/base3-step-prompt'
import {
  isRootStepReminderMessage,
  withSystemReminderTags,
} from '../system-reminder'

describe('root step reminders', () => {
  const reminder = withSystemReminderTags(BASE3_BATCHING_STEP_PROMPT)

  test('a root step reminder is recognised as it arrives', () => {
    expect(isRootStepReminderMessage({ role: 'user', content: reminder })).toBe(true)
    expect(
      isRootStepReminderMessage({
        role: 'user',
        content: [{ type: 'text', text: reminder }],
      }),
    ).toBe(true)
  })

  test("released clients' earlier reminder texts are recognised too", () => {
    expect(BASE3_BATCHING_STEP_PROMPT_PREVIOUS.length).toBeGreaterThan(0)
    for (const text of BASE3_BATCHING_STEP_PROMPT_PREVIOUS) {
      expect(
        isRootStepReminderMessage({
          role: 'user',
          content: withSystemReminderTags(text),
        }),
      ).toBe(true)
    }
  })

  test('nothing else passes for one, not even a prompt wrapped in its tags', () => {
    expect(
      isRootStepReminderMessage({
        role: 'user',
        content: withSystemReminderTags('a script shared by many accounts'),
      }),
    ).toBe(false)
    expect(isRootStepReminderMessage({ role: 'user', content: 'fix the bug' })).toBe(false)
    expect(
      isRootStepReminderMessage({
        role: 'user',
        content: [
          { type: 'text', text: reminder },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,' } },
        ],
      }),
    ).toBe(false)
    expect(isRootStepReminderMessage({ role: 'assistant', content: reminder })).toBe(false)
    expect(isRootStepReminderMessage(null)).toBe(false)
  })
})
