import { describe, expect, test } from 'bun:test'
import {
  CONVERSION_CLOCK_SKEW_MS,
  CONVERSION_EVIDENCE_WINDOW_MS,
  rejectedConversionEvidence,
  browserConversionReport,
  conversionDefinitionFromProcedure,
  conversionReportSchema,
  effectiveConversion,
  mergeConversionReport,
  pendingConversion,
  type ConversionDefinition,
  type ConversionReport,
} from './sponsored-conversion'

const start = 1_790_000_000_000
const definition: ConversionDefinition = {
  id: 'signup-key',
  version: 1,
  goal: 'Create a new account and key',
  criteria: [
    {
      id: 'account',
      claim: 'new_account',
      origin: 'https://acme.example',
      createdAtSelector: '#account-created',
    },
    {
      id: 'key',
      claim: 'new_api_key',
      origin: 'https://acme.example',
      createdAtSelector: '.key-created',
    },
  ],
}
const pending = () => pendingConversion(definition, start)
const lastObservable =
  start + CONVERSION_EVIDENCE_WINDOW_MS + CONVERSION_CLOCK_SKEW_MS
const report = (
  overrides: Partial<ConversionReport> = {},
): ConversionReport => ({
  userAnswer: 'confirmed',
  lifecycle: 'completed',
  reason: 'not_assessed',
  evidence: [],
  ...overrides,
})
const observed = (account: number | null, key: number | null) => ({
  origin: 'https://acme.example',
  observations: [
    { criterionId: 'account', createdAt: account },
    { criterionId: 'key', createdAt: key },
  ],
})
const assess = (account: number | null, key: number | null) =>
  mergeConversionReport(
    pending(),
    browserConversionReport(pending(), observed(account, key), start + 10_000),
    start + 10_000,
  )

describe('sponsored conversion measurement', () => {
  test('yes alone never verifies', () => {
    const value = mergeConversionReport(pending(), report(), start + 1000)
    expect(value.userAnswer).toBe('confirmed')
    expect(value.assessment).toBe('not_assessed')
  })
  test('new account and key creation metadata satisfies only those exact claims', () => {
    const value = assess(start + 100, start + 200)
    expect(value.assessment).toBe('satisfied')
    expect(value.evidence.map((e) => e.source)).toEqual([
      'browser_metadata',
      'browser_metadata',
    ])
  })
  test.each([
    [start - 1, start + 100],
    [start + 100, start - 1],
    [start - 1, start - 1],
  ])('existing account/key is inconclusive (%s, %s)', (account, key) => {
    expect(assess(account, key).assessment).toBe('inconclusive')
    expect(assess(account, key).reason).toBe('existing_resource')
  })
  test('missing metadata and future timestamps cannot satisfy', () => {
    expect(assess(null, null).assessment).toBe('inconclusive')
    expect(assess(start + 20_000, start + 20_000).assessment).toBe(
      'inconclusive',
    )
  })
  test('decline and timeout stay separate', () => {
    const decline = mergeConversionReport(
      pending(),
      report({ userAnswer: 'declined', reason: 'user_declined' }),
      start + 1,
    )
    expect(decline.userAnswer).toBe('declined')
    expect(decline.assessment).toBe('not_assessed')
    const expired = effectiveConversion(
      pending(),
      start + CONVERSION_EVIDENCE_WINDOW_MS + 1,
    )
    expect(expired.userAnswer).toBe('unknown')
    expect(expired.lifecycle).toBe('timed_out')
  })
  test('retry, late weak evidence and timeout cannot erase stronger observations', () => {
    const first = assess(start + 100, start + 200)
    const twice = mergeConversionReport(
      first,
      report({ evidence: first.evidence }),
      start + 20_000,
    )
    const weak = mergeConversionReport(
      twice,
      report({
        lifecycle: 'interrupted',
        reason: 'browser_unavailable',
        userAnswer: 'unknown',
      }),
      start + 30_000,
    )
    expect(weak.assessment).toBe('satisfied')
    expect(weak.evidence).toHaveLength(2)
    expect(weak.lifecycle).toBe('completed')
  })
  test('wrong origin, unknown criterion, old or delayed evidence is refused', () => {
    const evidence = assess(start + 100, start + 200).evidence
    for (const invalid of [
      evidence.map((e) => ({ ...e, origin: 'https://other.example' })),
      evidence.map((e) => ({ ...e, criterionId: 'unknown' })),
      evidence.map((e) => ({
        ...e,
        observedAt: start - CONVERSION_CLOCK_SKEW_MS - 1,
      })),
      evidence.map((e) => ({ ...e, observedAt: lastObservable + 1 })),
    ]) {
      expect(
        mergeConversionReport(
          pending(),
          report({ evidence: invalid, reason: 'criteria_satisfied' }),
          lastObservable + 2,
        ).assessment,
      ).not.toBe('satisfied')
    }
  })
  test('tolerates bounded client clock skew and a run that starts late', () => {
    const evidence = assess(start + 100, start + 200).evidence
    // The client's clock runs behind the server's Accept, or ahead of `now`.
    for (const [observedAt, now] of [
      [start - CONVERSION_CLOCK_SKEW_MS + 1_000, start + 1_000],
      [start + 60_000, start + 1_000],
      // A grant that started 24h after Accept, reporting near its 1h end.
      [start + 24.9 * 60 * 60_000, start + 24.9 * 60 * 60_000],
    ]) {
      const merged = mergeConversionReport(
        pending(),
        report({
          evidence: evidence.map((e) => ({ ...e, observedAt })),
          reason: 'criteria_satisfied',
        }),
        now!,
      )
      expect(merged.assessment).toBe('satisfied')
    }
    expect(
      mergeConversionReport(
        pending(),
        report({
          evidence: evidence.map((e) => ({
            ...e,
            observedAt: start + 10_000 + CONVERSION_CLOCK_SKEW_MS + 1,
          })),
        }),
        start + 10_000,
      ).evidence,
    ).toHaveLength(0)
  })
  test('a pending assessment times out only after the evidence window', () => {
    const value = pending()
    expect(
      effectiveConversion(value, start + 24.5 * 60 * 60_000).lifecycle,
    ).toBe('pending')
    expect(
      effectiveConversion(value, start + CONVERSION_EVIDENCE_WINDOW_MS + 1)
        .lifecycle,
    ).toBe('timed_out')
  })
  test('names the evidence a merge discarded, but not evidence a stronger item outranks', () => {
    const evidence = assess(start + 100, start + 200).evidence
    const late = evidence.map((e) => ({ ...e, observedAt: lastObservable + 1 }))
    const stale = report({ evidence: late })
    expect(
      rejectedConversionEvidence(
        mergeConversionReport(pending(), stale, lastObservable + 2),
        stale,
      ),
    ).toEqual(['account', 'key'])
    const good = report({ evidence })
    const stored = mergeConversionReport(pending(), good, start + 10_000)
    expect(rejectedConversionEvidence(stored, good)).toEqual([])
    const again = report({
      evidence: evidence.map((e) => ({ ...e, observedAt: start + 20_000 })),
    })
    expect(
      rejectedConversionEvidence(
        mergeConversionReport(stored, again, start + 20_000),
        again,
      ),
    ).toEqual([])
  })
  test('a later report without evidence keeps the evidence-backed reason', () => {
    const inconclusive = mergeConversionReport(
      pending(),
      report({ reason: 'existing_resource', lifecycle: 'completed' }),
      start + 1_000,
    )
    expect(inconclusive.assessment).toBe('inconclusive')
    for (const reason of ['not_assessed', 'interrupted', 'timed_out'] as const) {
      const later = mergeConversionReport(
        inconclusive,
        report({ reason, lifecycle: 'interrupted' }),
        start + 2_000,
      )
      expect(later.assessment).toBe('inconclusive')
      expect(later.reason).toBe('existing_resource')
    }
    expect(
      mergeConversionReport(
        inconclusive,
        report({ reason: 'insufficient_evidence' }),
        start + 2_000,
      ).reason,
    ).toBe('insufficient_evidence')
  })
  test('rejects raw credentials, prose, unknown fields and ambiguous definitions', () => {
    expect(
      conversionReportSchema.safeParse({
        ...report(),
        apiKey: 'must-not-store',
      }).success,
    ).toBe(false)
    const directive = 'conversion-definition: ' + JSON.stringify(definition)
    expect(conversionDefinitionFromProcedure(directive)).toEqual(definition)
    expect(
      conversionDefinitionFromProcedure(directive + '\n' + directive),
    ).toBeNull()
  })
})

test('v2 definitions and evidence reject injected prose, caller identity, raw keys and legacy timestamp evidence', () => {
  const definition: ConversionDefinition = {
    id: 'signup',
    version: 2,
    goal: 'Sign up',
    criteria: [
      {
        id: 'account',
        claim: 'new_account',
        origin: 'https://acme.example',
        instructions: 'Inspect signup completion in the browser.',
      },
    ],
  }
  const current = pendingConversion(definition, start)
  expect(
    conversionDefinitionFromProcedure(
      'conversion-definition: ' + JSON.stringify(definition),
    ),
  ).toEqual(definition)
  const invalid = report({
    reason: 'criteria_satisfied',
    evidence: [
      {
        criterionId: 'account',
        source: 'browser_metadata',
        origin: 'https://acme.example',
        observedAt: start + 100,
        createdAt: start + 50,
      },
    ],
  })
  expect(
    mergeConversionReport(current, invalid, start + 200).assessment,
  ).not.toBe('satisfied')
  expect(
    conversionReportSchema.safeParse({
      ...report(),
      evidence: [
        {
          criterionId: 'account',
          source: 'agent_browser',
          origin: 'https://acme.example',
          observedAt: start + 100,
          verdict: 'satisfied',
          basis: 'signup_completion',
          apiKey: 'never-store',
        },
      ],
    }).success,
  ).toBe(false)
})

describe('restricted onboarding conversions', () => {
  const signIn = {
    id: 'sign-in',
    claim: 'signed_in',
    origin: 'https://acme.example',
  } as const
  const install = {
    id: 'product-download',
    claim: 'product_download',
    origin: 'https://acme.example',
    product: 'sdk',
    package: '@acme/sdk',
  } as const
  const simple = (criteria: unknown[]) =>
    conversionDefinitionFromProcedure(
      `conversion-definition: ${JSON.stringify({ id: 'onboarding', version: 3, goal: 'Verify product onboarding', criteria })}`,
    )
  test('only sign-in and one key or product event; no custom criteria or instructions', () => {
    expect(simple([signIn, install])).not.toBeNull()
    expect(simple([install])).not.toBeNull()
    for (const claim of [
      'feedback_submitted',
      'deployment',
      'new_account',
      'api_used',
    ])
      expect(simple([{ ...signIn, claim }])).toBeNull()
    expect(
      simple([
        { ...signIn, instructions: 'Submit feedback before counting sign-in' },
      ]),
    ).toBeNull()
    expect(simple([signIn, signIn])).toBeNull()
    expect(
      simple([
        install,
        {
          id: 'api-key',
          claim: 'new_api_key',
          origin: signIn.origin,
          credentialEnv: 'ACME_KEY',
        },
      ]),
    ).toBeNull()
  })
  test('authenticated existing accounts count; assertions and wrong bases do not', () => {
    const state = pendingConversion(simple([signIn])!, start)
    expect(
      mergeConversionReport(state, report(), start + 1000).assessment,
    ).toBe('not_assessed')
    const evidence = {
      criterionId: signIn.id,
      source: 'agent_browser',
      origin: signIn.origin,
      observedAt: start + 100,
      verdict: 'satisfied',
      basis: 'authenticated_session',
    } as const
    expect(
      mergeConversionReport(
        state,
        report({ evidence: [evidence] }),
        start + 1000,
      ).assessment,
    ).toBe('satisfied')
    expect(
      mergeConversionReport(
        state,
        report({ evidence: [{ ...evidence, basis: 'existing_resource' }] }),
        start + 1000,
      ).assessment,
    ).not.toBe('satisfied')
    expect(
      mergeConversionReport(
        state,
        report({ userAnswer: 'unknown', evidence: [evidence] }),
        start + 1000,
      ).assessment,
    ).not.toBe('satisfied')
  })
  test('a download requires host installation verification, without inventing an account requirement', () => {
    const state = pendingConversion(simple([install])!, start)
    const evidence = {
      criterionId: install.id,
      source: 'agent_install',
      origin: install.origin,
      observedAt: start + 100,
      verdict: 'satisfied',
      basis: 'installation_verified',
      installationVerified: true,
    } as const
    expect(
      mergeConversionReport(
        state,
        report({ userAnswer: 'unknown', evidence: [evidence] }),
        start + 1000,
      ).assessment,
    ).toBe('satisfied')
    for (const item of [
      { ...evidence, installationVerified: false },
      { ...evidence, source: 'agent_browser' as const },
    ])
      expect(
        mergeConversionReport(state, report({ evidence: [item] }), start + 1000)
          .assessment,
      ).not.toBe('satisfied')
  })
})
