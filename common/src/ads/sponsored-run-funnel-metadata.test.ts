import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import {
  SPONSORED_FUNNEL_DIAGNOSTIC_MAX,
  SPONSORED_RUN_FAILURE_CODES,
  buildSponsoredRunFunnelMetadata,
  isSponsoredRunOutcomeFunnelEvent,
  scrubSponsoredDiagnostic,
  sponsoredRunFailureCode,
  sponsoredRunFunnelMetadataSchema,
} from './sponsored-run-funnel-metadata'

describe('buildSponsoredRunFunnelMetadata', () => {
  test('an in-place Windows Desktop failure names mode, surface, OS, client, containment and code', () => {
    const metadata = buildSponsoredRunFunnelMetadata({
      eventType: 'run_failed',
      row: {
        in_place_execution: true,
        execution_surface: 'desktop_windows',
        surface: 'desktop',
        acceptance: { surface: 'desktop', containment: 'floor' },
        diagnostic_reason:
          'turn completed; the turn recorded no file edits of its own',
      },
      fromState: 'running',
    })
    expect(metadata).toEqual({
      execution_mode: 'in_place',
      execution_surface: 'desktop_windows',
      client: 'desktop',
      os: 'windows',
      containment: 'floor',
      from_state: 'running',
      failure_code: 'no_edits',
      diagnostic_reason:
        'turn completed; the turn recorded no file edits of its own',
      llm_called: true,
    })
    expect(sponsoredRunFunnelMetadataSchema.safeParse(metadata).success).toBe(
      true,
    )
  })

  test('a repo-keyed row without the in-place flag is the worktree flow', () => {
    expect(
      buildSponsoredRunFunnelMetadata({
        eventType: 'run_committed',
        row: { execution_surface: 'desktop_macos' },
        fromState: 'running',
      }),
    ).toEqual({
      execution_mode: 'worktree',
      execution_surface: 'desktop_macos',
      os: 'macos',
      from_state: 'running',
      llm_called: true,
    })
  })

  test('a Cloud row is `cloud` whatever else it carries, and keeps the refusal as its code', () => {
    const metadata = buildSponsoredRunFunnelMetadata({
      eventType: 'run_failed',
      row: {
        project_id: 'project_1',
        surface: 'cloud',
        diagnostic_reason:
          'workspace_prepare_failed: Installation 123 not found',
      },
      fromState: 'accepted',
      refusal: 'workspace_prepare_failed',
    })
    expect(metadata).toMatchObject({
      execution_mode: 'cloud',
      execution_surface: 'cloud',
      client: 'cloud',
      failure_code: 'workspace_prepare_failed',
      llm_called: false,
    })
  })

  test('a Cloud row swept out of `accepted` was never queued; a local one stays unknown', () => {
    const cloud = buildSponsoredRunFunnelMetadata({
      eventType: 'run_failed',
      row: { project_id: 'p', diagnostic_reason: 'stale-sweep: …' },
      fromState: 'accepted',
      refusal: 'timed_out',
    })
    expect(cloud.llm_called).toBe(false)
    const local = buildSponsoredRunFunnelMetadata({
      eventType: 'run_failed',
      row: { in_place_execution: true, diagnostic_reason: 'stale-sweep: …' },
      fromState: 'accepted',
      refusal: 'timed_out',
    })
    expect(local.failure_code).toBe('timed_out')
    expect('llm_called' in local).toBe(false)
  })

  test('an unrecognised surface, client or from-state is omitted, never passed through', () => {
    const metadata = buildSponsoredRunFunnelMetadata({
      eventType: 'run_failed',
      row: {
        execution_surface: 'desktop_amiga',
        surface: 'toaster',
        acceptance: { surface: 'toaster', containment: 'none' },
      },
      fromState: 'offered',
    })
    expect(metadata).toEqual({
      execution_mode: 'worktree',
      failure_code: 'unclassified',
    })
  })

  test('an unknown Cloud refusal is `other`, never the raw string', () => {
    expect(
      buildSponsoredRunFunnelMetadata({
        eventType: 'run_failed',
        row: { project_id: 'p' },
        refusal: 'run_exploded; DROP TABLE',
      }).failure_code,
    ).toBe('other')
  })

  test('every output parses against the closed schema the bridge enforces', () => {
    const rows = [
      {},
      { project_id: 'p' },
      { in_place_execution: true as const, execution_surface: 'cli_wsl' },
      { diagnostic_reason: 'x'.repeat(5_000) },
    ]
    for (const row of rows) {
      for (const eventType of [
        'run_failed',
        'run_committed',
        'run_delivered',
      ] as const) {
        const metadata = buildSponsoredRunFunnelMetadata({ eventType, row })
        expect(
          sponsoredRunFunnelMetadataSchema.safeParse(metadata).success,
        ).toBe(true)
      }
    }
  })
})

test('a session that never started is not claimed to have called a model', () => {
  const metadata = buildSponsoredRunFunnelMetadata({
    eventType: 'run_failed',
    row: {
      in_place_execution: true,
      diagnostic_reason:
        'turn error: Could not start a Freebuff session for deepseek/deepseek-v4-flash; the turn recorded no file edits of its own',
    },
    fromState: 'running',
  })
  expect(metadata.failure_code).toBe('turn_error')
  expect('llm_called' in metadata).toBe(false)
})

describe('sponsoredRunFailureCode', () => {
  const cases: Array<[string, string]> = [
    ['accept-failed: Freebuff returned 500', 'accept_failed'],
    [
      'accept-identity-changed: the accepted advertiser differs',
      'accept_identity_changed',
    ],
    [
      'containment-mismatch: this machine is on the floor',
      'containment_mismatch',
    ],
    ['resume-declined: approved before Freebuff closed', 'resume_declined'],
    ['stale-sweep: no report for 1440 minutes', 'timed_out'],
    ['app-quit: resumed at boot without a compute grant; x', 'app_quit'],
    ['interrupted: turn outcome `stopped`; HEAD', 'interrupted'],
    [
      'turn interrupted; the turn recorded no file edits of its own',
      'interrupted',
    ],
    ['turn grant-expired; the turn recorded no file edits', 'grant_expired'],
    ['turn error; the verdict could not be decided: boom', 'verdict_undecided'],
    [
      'turn completed; the worktree has uncommitted changes; commit follow-up was queued but never started within 30s',
      'commit_follow_up_failed',
    ],
    ['turn completed; the turn recorded no file edits of its own', 'no_edits'],
    ['turn completed; HEAD is still the base commit', 'no_commit'],
    [
      'turn error: Could not start a Freebuff session; the turn recorded no file edits of its own',
      'turn_error',
    ],
    [
      'turn error: Could not start a Freebuff session; HEAD moved',
      'turn_error',
    ],
    ['something we never wrote', 'unclassified'],
    ['', 'unclassified'],
  ]
  for (const [diagnostic, code] of cases) {
    test(`${JSON.stringify(diagnostic.slice(0, 40))} is ${code}`, () => {
      expect(sponsoredRunFailureCode({ diagnosticReason: diagnostic })).toBe(
        code as never,
      )
    })
  }

  test('every code it can return is in the closed list', () => {
    for (const [diagnostic] of cases) {
      expect(SPONSORED_RUN_FAILURE_CODES).toContain(
        sponsoredRunFailureCode({ diagnosticReason: diagnostic }),
      )
    }
  })
})

describe('scrubSponsoredDiagnostic', () => {
  test('keeps our own shape and drops what could be the user’s', () => {
    expect(
      scrubSponsoredDiagnostic(
        "turn error: EACCES: permission denied, open '/Users/jane/acme/.env'; HEAD is still the base commit",
      ),
    ).toBe(
      'turn error: EACCES: permission denied, open <quoted>; HEAD is still the base commit',
    )
  })

  test('first line only, so a stack or payload never follows it in', () => {
    expect(
      scrubSponsoredDiagnostic(
        'turn error: boom\n    at secret (/home/u/x.js:1)',
      ),
    ).toBe('turn error: boom')
  })

  test('paths, urls, emails, quotes and tokens are replaced by what they were', () => {
    const scrubbed = scrubSponsoredDiagnostic(
      [
        'open /home/jane/work/app failed',
        'C:\\Users\\jane\\proj\\a.ts',
        'see https://github.com/acme/private/pull/7?token=abc',
        'mail jane@example.com',
        'wrote src/components/Thing.tsx',
        'said "rm -rf the database"',
        '`running`',
        'sha 0123456789abcdef0123',
        // A prefix no secret scanner knows, on purpose: this file is exported,
        // and the public mirror's push protection refused the whole sync while
        // this read `sk_live_…` (2026-09-25). The scrubber keys on length only.
        'key opaque_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456',
      ].join(' | '),
    )
    expect(scrubbed).not.toContain('jane')
    expect(scrubbed).not.toContain('acme')
    expect(scrubbed).not.toContain('Thing')
    expect(scrubbed).not.toContain('database')
    expect(scrubbed).not.toContain('0123456789abcdef')
    expect(scrubbed).not.toContain('ABCDEFGHIJ')
    for (const placeholder of [
      '<path>',
      '<url>',
      '<email>',
      '<quoted>',
      '<hex>',
      '<token>',
    ]) {
      expect(scrubbed).toContain(placeholder)
    }
  })

  test('keeps `/dev/null`, a model id, and an apostrophe that is not a quote', () => {
    expect(
      scrubSponsoredDiagnostic(
        "git can't open /dev/null; model deepseek/deepseek-v4-flash",
      ),
    ).toBe("git can't open /dev/null; model deepseek/deepseek-v4-flash")
  })

  test('is capped, and absent input stays absent', () => {
    const long = scrubSponsoredDiagnostic('turn error '.repeat(200))!
    expect(long.length).toBeLessThanOrEqual(SPONSORED_FUNNEL_DIAGNOSTIC_MAX)
    expect(scrubSponsoredDiagnostic(null)).toBeNull()
    expect(scrubSponsoredDiagnostic('   \n  second line')).toBeNull()
  })

  test('drops control characters', () => {
    expect(scrubSponsoredDiagnostic('a\u0007b\u001bc')).toBe('a b c')
  })
})

describe('the schema', () => {
  test('refuses a field the builder never writes', () => {
    expect(
      sponsoredRunFunnelMetadataSchema.safeParse({
        execution_mode: 'in_place',
        prompt: 'anything',
      }).success,
    ).toBe(false)
  })

  test('refuses a code outside the closed list and an over-long diagnostic', () => {
    expect(
      sponsoredRunFunnelMetadataSchema.safeParse({
        execution_mode: 'cloud',
        failure_code: 'made_up',
      }).success,
    ).toBe(false)
    expect(
      sponsoredRunFunnelMetadataSchema.safeParse({
        execution_mode: 'cloud',
        diagnostic_reason: 'x'.repeat(SPONSORED_FUNNEL_DIAGNOSTIC_MAX + 1),
      }).success,
    ).toBe(false)
  })

  test('belongs to exactly the three run outcomes', () => {
    expect(isSponsoredRunOutcomeFunnelEvent('run_failed')).toBe(true)
    expect(isSponsoredRunOutcomeFunnelEvent('run_committed')).toBe(true)
    expect(isSponsoredRunOutcomeFunnelEvent('run_delivered')).toBe(true)
    expect(isSponsoredRunOutcomeFunnelEvent('landed')).toBe(false)
    expect(isSponsoredRunOutcomeFunnelEvent('accepted')).toBe(false)
  })
})

test('telemetry only: the module imports nothing that can bill', () => {
  const source = readFileSync(
    join(import.meta.dir, 'sponsored-run-funnel-metadata.ts'),
    'utf8',
  )
  const imports = source.match(/from '[^']+'/g) ?? []
  expect(imports).toEqual(["from 'zod'", "from './sponsored-capability'"])
})
