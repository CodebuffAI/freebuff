import { describe, expect, test } from 'bun:test'
import { sponsoredFailureExplanation } from './sponsored-run-failure'
import {
  parseSponsoredRunEvidence,
  sponsoredRunEvidence,
} from './sponsored-run-evidence'
import {
  buildSponsoredRunFunnelMetadata,
  sponsoredRunFunnelMetadataReceiverSchema,
} from './sponsored-run-funnel-metadata'
import { sponsoredPartialEditsDiagnostic } from './sponsored-in-place'
import type { SponsoredStepDriveResult } from './sponsored-step-driver'

const steps: SponsoredStepDriveResult = {
  skill: 'test@1',
  delivered: false,
  fixes: 2,
  steps: [
    {
      number: 3,
      id: 'verify',
      title: 'Private title',
      kind: 'check',
      status: 'blocked',
      fixes: 2,
      checks: [
        {
          id: 'changes-in-scope',
          kind: 'changes_within',
          label: 'private label',
          status: 'fail',
          detail: '/private/customer/file.css',
        },
      ],
    },
  ],
}

describe('run failure evidence', () => {
  test('retains step/check/category through the durable payload and funnel without repository text', () => {
    const evidence = sponsoredRunEvidence('completed', steps)
    const metadata = buildSponsoredRunFunnelMetadata({
      eventType: 'run_failed',
      row: {
        diagnostic_reason: sponsoredPartialEditsDiagnostic('turn completed', 4),
        last_run_report_payload: JSON.stringify({ runEvidence: evidence }),
      },
    })
    expect(
      sponsoredRunFunnelMetadataReceiverSchema.parse(metadata).run_evidence,
    ).toEqual({
      version: 1,
      ending: 'completed',
      checksRecorded: true,
      checks: [
        { step: 3, checkId: 'changes-in-scope', category: 'scope_check' },
      ],
    })
    expect(JSON.stringify(metadata)).not.toContain('private')
    const shown = sponsoredFailureExplanation({ metadata })
    expect(shown.label).toBe('Verification failed')
    expect(shown.detail).toContain('Step 3 (changes-in-scope)')
    expect(shown.detail).not.toContain('ended early')
  })

  test('rejects oversized/unbounded telemetry rather than transporting text or secrets', () => {
    const e = sponsoredRunEvidence('completed', steps)
    for (const v of [
      { ...e, secret: 'secret' },
      { ...e, checks: Array(21).fill(e.checks[0]) },
      { ...e, checks: [{ ...e.checks[0], checkId: '/private/file' }] },
      { ...e, checks: [{ ...e.checks[0], step: -1 }] },
      { ...e, checks: [{ ...e.checks[0], category: 'arbitrary text' }] },
    ]) {
      expect(parseSponsoredRunEvidence(v)).toBeUndefined()
    }
  })

  test('caps checks explicitly and records missing credentials as a separate blocker', () => {
    const many = {
      ...steps,
      steps: Array.from({ length: 25 }, (_, i) => ({
        ...steps.steps[0]!,
        number: i + 1,
      })),
    }
    expect(sponsoredRunEvidence('closed', many)).toMatchObject({
      truncated: true,
      checks: expect.any(Array),
    })
    expect(sponsoredRunEvidence('closed', many).checks).toHaveLength(20)
    const credential = {
      ...steps,
      steps: [
        {
          ...steps.steps[0]!,
          number: 4,
          kind: 'user' as const,
          status: 'needs_user' as const,
          checks: [
            {
              id: 'api-key-provided',
              kind: 'credential_provided' as const,
              label: 'key',
              status: 'fail' as const,
              detail: 'not provided',
            },
          ],
        },
      ],
    }
    const shown = sponsoredFailureExplanation({
      metadata: { run_evidence: sponsoredRunEvidence('closed', credential) },
    })
    expect(shown.detail).toContain('The session closed.')
    expect(shown.detail).toContain(
      'Step 4 (api-key-provided): An API key is still required.',
    )
    expect(shown.detail).not.toContain('user cancelled')
  })
})

describe('a spent compute grant', () => {
  test("Desktop's `turn grant-expired` reads as the grant expiring, with or without a code", () => {
    for (const metadata of [
      { diagnostic_reason: 'turn grant-expired: the active window was spent' },
      {
        failure_code: 'other',
        diagnostic_reason:
          'turn grant-expired; the turn recorded no file edits',
      },
    ]) {
      expect(sponsoredFailureExplanation({ metadata }).detail).toContain(
        'The compute grant expired.',
      )
    }
  })
})

describe('existing replay diagnostics', () => {
  test('reads the actual diagnostic_reason field and retains unknown causes safely', () => {
    expect(
      sponsoredFailureExplanation({
        metadata: {
          failure_code: 'turn_error',
          diagnostic_reason: 'turn error: provider rejected the request',
        },
      }).detail,
    ).toContain('provider rejected the request')
    expect(
      sponsoredFailureExplanation({
        metadata: { failure_reason: 'Legacy failure' },
      }).detail,
    ).toBe('Legacy failure')
    expect(sponsoredFailureExplanation({ metadata: null }).detail).toContain(
      'no specific reason was recorded',
    )
  })
  test('recognizes a completed legacy run with failed checks, not an early stop', () => {
    const result = sponsoredFailureExplanation({
      metadata: {
        failure_code: 'partial_edits',
        diagnostic_reason:
          'turn completed; the turn ended early, so its partial changes (N files) were left in the workspace; step N blocked',
      },
      friction: [
        {
          blocking: true,
          category: 'other',
          detail: 'scope check failed on /private/customer/file',
        },
      ],
    })
    expect(result.label).toBe('Verification failed')
    expect(result.detail).toContain('agent turn completed')
    expect(result.detail).toContain('Changes outside the allowed scope')
    expect(result.detail).not.toContain('/private')
  })
  test('separates a restart from a human blocker and ignores nonblocking friction', () => {
    const result = sponsoredFailureExplanation({
      metadata: {
        diagnostic_reason:
          'turn interrupted: the Cloud runner restarted during the run',
      },
      friction: [
        { blocking: true, category: 'needs_api_key' },
        { blocking: false, category: 'command_failed' },
      ],
    })
    expect(result.detail).toBe(
      'The Cloud runner restarted.\nAgent reported: An API key is still required.',
    )
  })
  test('labels model grades as assessments rather than observed blockers', () => {
    expect(
      sponsoredFailureExplanation({
        metadata: { diagnostic_reason: 'turn stopped' },
        assessedCause: 'needs_api_key',
      }).detail,
    ).toContain('Run assessment: An API key')
  })
})

test('new check results supersede stale friction and assessments', () => {
  const metadata = {
    run_evidence: sponsoredRunEvidence('completed', {
      ...steps,
      steps: [
        {
          ...steps.steps[0]!,
          checks: [{ ...steps.steps[0]!.checks[0]!, status: 'pass' }],
        },
      ],
    }),
  }
  const shown = sponsoredFailureExplanation({
    metadata,
    friction: [{ blocking: true, category: 'needs_api_key' }],
    assessedCause: 'needs_api_key',
  })
  expect(shown.detail).not.toContain('API key')
  expect(sponsoredRunEvidence('interrupted').checksRecorded).toBeUndefined()
})

test('an interrupted driver without check results still uses reported blockers', () => {
  const evidence = sponsoredRunEvidence('interrupted', { ...steps, steps: [] })
  expect(evidence.checksRecorded).toBeUndefined()
  expect(
    sponsoredFailureExplanation({
      metadata: { run_evidence: evidence },
      friction: [{ blocking: true, category: 'needs_api_key' }],
    }).detail,
  ).toContain('Agent reported: An API key')
})

const waitingSteps: SponsoredStepDriveResult = {
  skill: 'test@1',
  delivered: true,
  fixes: 0,
  steps: [
    {
      number: 1,
      id: 'implement',
      title: 'Implement',
      kind: 'agent',
      status: 'passed',
      fixes: 0,
      checks: [
        {
          id: 'build',
          kind: 'command_succeeds',
          label: 'Build',
          status: 'pass',
          detail: 'Passed',
        },
      ],
    },
    {
      number: 2,
      id: 'verify',
      title: 'Confirm',
      kind: 'user',
      status: 'needs_user',
      fixes: 0,
      checks: [
        {
          id: 'confirm',
          kind: 'user_confirmed',
          label: 'Confirm',
          status: 'fail',
          detail: 'Not confirmed',
        },
      ],
    },
  ],
}

test('checked completion survives wire parsing and takes precedence over the process ending', () => {
  for (const ending of [
    'completed',
    'closed',
    'stopped',
    'interrupted',
  ] as const) {
    const evidence = sponsoredRunEvidence(ending, waitingSteps)
    expect(parseSponsoredRunEvidence(evidence)?.verificationPending).toBe(true)
    const metadata = buildSponsoredRunFunnelMetadata({
      eventType: 'run_failed',
      row: {
        diagnostic_reason: `turn ${ending}: app-quit`,
        last_run_report_payload: JSON.stringify({ runEvidence: evidence }),
      },
    })
    expect(
      sponsoredRunFunnelMetadataReceiverSchema.parse(metadata).failure_code,
    ).toBe('verification_incomplete')
    expect(sponsoredFailureExplanation({ metadata })).toMatchObject({
      label: 'Verification incomplete',
      detail: expect.stringContaining('Implementation finished'),
    })
  }
})

test('unproven completion, earlier setup, real errors, and malformed pending evidence do not qualify', () => {
  for (const result of [
    { ...waitingSteps, delivered: false },
    { ...waitingSteps, stoppedBecause: 'turn_failed' as const },
    { ...waitingSteps, steps: waitingSteps.steps.slice(1) },
    { ...waitingSteps, steps: [...waitingSteps.steps].reverse() },
    {
      ...waitingSteps,
      steps: [
        { ...waitingSteps.steps[0]!, status: 'blocked' as const },
        waitingSteps.steps[1]!,
      ],
    },
  ])
    expect(
      sponsoredRunEvidence('closed', result).verificationPending,
    ).toBeUndefined()
  expect(
    sponsoredRunEvidence('error', waitingSteps).verificationPending,
  ).toBeUndefined()
  expect(
    parseSponsoredRunEvidence({
      ...sponsoredRunEvidence('closed', waitingSteps),
      verificationPending: 'true',
    }),
  ).toBeUndefined()
  expect(
    parseSponsoredRunEvidence({
      ...sponsoredRunEvidence('closed', waitingSteps),
      ending: 'error',
    }),
  ).toBeUndefined()
})
