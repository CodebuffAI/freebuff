import { describe, expect, test } from 'bun:test'

import {
  formatSponsoredStepCount,
  parseSponsoredProcedureSteps,
  sponsoredDoneStepCount,
  sponsoredStepNeedsUser,
} from './sponsored-procedure-steps'

describe('parseSponsoredProcedureSteps', () => {
  test('numbered steps, with the human-only ones marked', () => {
    const steps = parseSponsoredProcedureSteps(
      [
        'Set up Acmeauth sign-in in this project.',
        '1. Detect the framework and package manager.',
        '2. Install the @acmeauth/sdk package.',
        '3) Add a /login route that renders the SignIn component.',
        '4. Run `npx acmeauth link` so the user can log in to Acmeauth in the browser.',
      ].join('\n'),
    )
    expect(steps.map((s) => [s.number, s.needsUser])).toEqual([
      [1, false],
      [2, false],
      [3, false],
      [4, true],
    ])
    expect(steps[2]!.text).toBe(
      'Add a /login route that renders the SignIn component.',
    )
  })

  test('nested and wrapped lines belong to their step; a restarted list ends it', () => {
    const steps = parseSponsoredProcedureSteps(
      [
        '1. Install the CLI.',
        '   1. on macOS use brew',
        '   2. elsewhere use npm',
        '2. Write the config',
        '   with the project URL.',
        '',
        'Troubleshooting:',
        '1. If it fails, retry.',
      ].join('\n'),
    )
    expect(steps).toHaveLength(2)
    expect(steps[0]!.text).toBe(
      'Install the CLI. on macOS use brew elsewhere use npm',
    )
    expect(steps[1]!.text).toBe('Write the config with the project URL.')
  })

  test('prose has no parsed steps', () => {
    expect(
      parseSponsoredProcedureSteps('Install the SDK and wire it up.'),
    ).toEqual([])
    expect(parseSponsoredProcedureSteps(null)).toEqual([])
  })
})

describe('sponsoredStepNeedsUser', () => {
  test.each([
    ['Run `quarry login` (opens a browser to sign in).', true],
    ['Ask the user to paste their BRIGHTMAIL_API_KEY into .env.', true],
    ['Sign up for an Acme account.', true],
    ['Add a /login route and a sign-in page.', false],
    ['Read BRIGHTMAIL_API_KEY from the environment in lib/email.ts.', false],
    ['Add a billing page.', false],
  ])('%s → %p', (text, expected) => {
    expect(sponsoredStepNeedsUser(text)).toBe(expected)
  })
})

describe('step counts', () => {
  test('done count and the one N/M format', () => {
    expect(
      sponsoredDoneStepCount([
        { state: 'done' },
        { state: 'active' },
        { state: 'done' },
      ]),
    ).toBe(2)
    expect(formatSponsoredStepCount(1, 8)).toBe('1/8')
    expect(formatSponsoredStepCount(null, 8)).toBe('0/8')
    expect(formatSponsoredStepCount(9, 8)).toBe('8/8')
    expect(formatSponsoredStepCount(3, null)).toBeNull()
    expect(formatSponsoredStepCount(0, 0)).toBeNull()
  })
})
