/**
 * The in-place rules are a MIRROR of Desktop's, and this is what stops it
 * drifting.
 *
 * `DESKTOP_IN_PLACE_SPONSORED_GUIDANCE` lives in the Desktop orchestrator
 * (`freebuff-desktop/src/server/services/sponsored-run.ts`), and importing it
 * here would drag the orchestrator's graph into the CLI's typecheck program. So
 * the bullets are copied -- and read back out of the production file as TEXT,
 * so a copy that stops matching fails here rather than in a run the two
 * surfaces told different things.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { ensureCliTestEnv } from '../../__tests__/test-utils'

ensureCliTestEnv()

const {
  SPONSORED_IN_PLACE_BULLETS,
  SPONSORED_CONTEXT_HEADING,
  SPONSORED_TASK_FRAMING,
  buildSponsoredPrompt,
} = await import('../sponsored-agent')

const DESKTOP_RUN = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'freebuff-desktop',
  'src',
  'server',
  'services',
  'sponsored-run.ts',
)

describe('the mirrored in-place guidance', () => {
  test('every bullet is still byte-identical to Desktop’s', () => {
    const source = readFileSync(DESKTOP_RUN, 'utf8')
    for (const bullet of SPONSORED_IN_PLACE_BULLETS) {
      expect(source, bullet).toContain(bullet)
    }
  })

  test('the framing and the context heading are byte-identical to Desktop’s', () => {
    const source = readFileSync(DESKTOP_RUN, 'utf8')
    for (const text of [SPONSORED_TASK_FRAMING, SPONSORED_CONTEXT_HEADING])
      for (const line of text.split('\n')) expect(source, line).toContain(line)
  })

  test('Desktop’s order: the authorisation, the procedure, the context, the rules', () => {
    // The task is stated before the procedure and the rules come after both:
    // a prompt that opens with prohibitions and never says what to do leaves
    // the model to read the task off section labels.
    const prompt = buildSponsoredPrompt('Wire up the Acme deploy hook.', [
      'What database should I use?',
    ])
    const at = (text: string) => prompt.indexOf(text)
    expect(prompt.startsWith('The user was shown the procedure below')).toBe(
      true,
    )
    expect(at('Wire up the Acme deploy hook.')).toBeLessThan(
      at('User message 1:\nWhat database should I use?'),
    )
    expect(at('User message 1:')).toBeLessThan(at('UNCOMMITTED'))
    expect(prompt).toContain('Do NOT install dependencies')
    expect(prompt.endsWith('decide and proceed, or stop.')).toBe(true)
  })

  test('the context is carried whole, in order', () => {
    // The run starts with fresh memory, so without the user's own words the
    // procedure runs against a project it knows nothing about.
    const prompt = buildSponsoredPrompt('Procedure.', [
      'first message',
      'second message',
    ])
    expect(prompt).toContain(
      'User message 1:\nfirst message\n\nUser message 2:\nsecond message',
    )
  })
})
