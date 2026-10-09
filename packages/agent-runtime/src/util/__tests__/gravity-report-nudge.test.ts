import { assistantMessage, userMessage } from '@codebuff/common/util/messages'
import { describe, expect, it } from 'bun:test'

import {
  decideGravityReportNudge,
  GRAVITY_REPORT_NUDGE_TAG,
} from '../gravity-report-nudge'

import type { Message } from '@codebuff/common/types/messages/codebuff-message'

let ids = 0
function call(
  toolName: string,
  input: Record<string, unknown>,
  output: unknown = {},
): Message[] {
  const toolCallId = `call-${++ids}`
  return [
    assistantMessage({ type: 'tool-call', toolCallId, toolName, input }),
    {
      role: 'tool',
      toolCallId,
      toolName,
      content: [{ type: 'json', value: output as never }],
    },
  ]
}

const prompt = (text = 'Add email sending') =>
  userMessage({ content: text, tags: ['USER_PROMPT'] })
const search = (searchId = 's-1', slug = 'resend') =>
  call(
    'gravity_index',
    { action: 'search', query: 'email' },
    { search_id: searchId, recommendation: { slug, name: slug } },
  )
const edit = () => call('write_file', { path: 'src/email.ts', content: 'x' })
const report = (searchId = 's-1', slug = 'resend') =>
  call('gravity_index', {
    action: 'report_integration',
    search_id: searchId,
    integrated_slug: slug,
  })

describe('decideGravityReportNudge', () => {
  it('nudges with the exact search_id and slug after an unreported integration', () => {
    const nudge = decideGravityReportNudge([prompt(), ...search(), ...edit()])
    expect(nudge?.candidates).toEqual([{ searchId: 's-1', slug: 'resend' }])
    expect(nudge?.message).toContain('"s-1"')
    expect(nudge?.message).toContain('"resend"')
  })

  it('stays quiet once the search was reported', () => {
    expect(
      decideGravityReportNudge([prompt(), ...search(), ...edit(), ...report()]),
    ).toBeUndefined()
  })

  it('stays quiet when nothing was edited after the recommendation', () => {
    expect(
      decideGravityReportNudge([prompt(), ...edit(), ...search()]),
    ).toBeUndefined()
  })

  it('covers a recommendation from an earlier prompt integrated in this one', () => {
    const nudge = decideGravityReportNudge([
      prompt('Which email service?'),
      ...search(),
      prompt('Here are my keys, wire it up'),
      ...edit(),
    ])
    expect(nudge?.candidates).toEqual([{ searchId: 's-1', slug: 'resend' }])
  })

  it('needs an edit in the current prompt, not an earlier one', () => {
    expect(
      decideGravityReportNudge([
        prompt(),
        ...search(),
        ...edit(),
        prompt('Change the button colour'),
      ]),
    ).toBeUndefined()
  })

  it('nudges at most once per user prompt', () => {
    expect(
      decideGravityReportNudge([
        prompt(),
        ...search(),
        ...edit(),
        userMessage({ content: 'r', tags: [GRAVITY_REPORT_NUDGE_TAG] }),
      ]),
    ).toBeUndefined()
  })

  it('uses the newest search for a slug', () => {
    const nudge = decideGravityReportNudge([
      prompt(),
      ...search('s-1'),
      ...search('s-2'),
      ...edit(),
    ])
    expect(nudge?.candidates).toEqual([{ searchId: 's-2', slug: 'resend' }])
  })
})
