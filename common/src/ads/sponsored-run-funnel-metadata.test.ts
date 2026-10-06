import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { sponsoredExecutionSurfaceSchema } from './sponsored-capability'
import {
  SPONSORED_EXECUTION_SURFACES,
  isSponsoredExecutionSurface,
  type SponsoredExecutionSurface,
} from './sponsored-execution-surface'
import {
  SPONSORED_PARTIAL_EDITS_COPY,
  sponsoredPartialEditsDiagnostic,
} from './sponsored-in-place'
import {
  SPONSORED_FUNDING_REFUSED_PREFIX,
  SPONSORED_FUNNEL_DIAGNOSTIC_MAX,
  SPONSORED_NEVER_STARTED_FAILURE_CODES,
  SPONSORED_NEVER_STARTED_PREFIX,
  SPONSORED_NEVER_STARTED_REASONS,
  SPONSORED_RUN_FAILURE_CODES,
  buildSponsoredRunFunnelMetadata,
  isSponsoredNeverStartedFailure,
  sponsoredFundingRefusedDiagnostic,
  sponsoredNeverStartedDiagnostic,
  type SponsoredNeverStartedReason,
  isSponsoredRunOutcomeFunnelEvent,
  scrubSponsoredDiagnostic,
  sponsoredRunFailureCode,
  sponsoredRunFunnelMetadataReceiverSchema,
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
    // The model id keeps its shape; its digits go with every other number.
    expect(
      scrubSponsoredDiagnostic(
        "git can't open /dev/null; model deepseek/deepseek-v4-flash",
      ),
    ).toBe("git can't open /dev/null; model deepseek/deepseek-vN-flash")
  })

  test('numbers collapse to N, after hex still collapses to <hex>', () => {
    expect(
      scrubSponsoredDiagnostic(
        'never-started: queue_wait_expired: its turn was still queued after 95 minutes',
      ),
    ).toBe(
      'never-started: queue_wait_expired: its turn was still queued after N minutes',
    )
    expect(
      scrubSponsoredDiagnostic('turn error: sha 0123456789abcdef0123 at 500'),
    ).toBe('turn error: sha <hex> at N')
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

  test('carries a pattern-checked client_version', () => {
    expect(
      sponsoredRunFunnelMetadataSchema.safeParse({
        execution_mode: 'in_place',
        client_version: 'desktop/0.0.152',
      }).success,
    ).toBe(true)
    for (const client_version of ['desktop/', 'phone/1.0', 'cli/1 2', '']) {
      expect(
        sponsoredRunFunnelMetadataSchema.safeParse({
          execution_mode: 'in_place',
          client_version,
        }).success,
      ).toBe(false)
    }
  })

  test('names the never-started, partial-edits and funding codes', () => {
    for (const code of [
      'never_started_dismissed',
      'never_started_queue_expired',
      'never_started_connect_dismissed',
      'never_started_app_quit',
      'never_started_inputs_dropped',
      'never_started_other',
      'partial_edits',
      'funding_refused',
    ]) {
      expect(SPONSORED_RUN_FAILURE_CODES).toContain(code as never)
    }
  })

  test('belongs to exactly the three run outcomes', () => {
    expect(isSponsoredRunOutcomeFunnelEvent('run_failed')).toBe(true)
    expect(isSponsoredRunOutcomeFunnelEvent('run_committed')).toBe(true)
    expect(isSponsoredRunOutcomeFunnelEvent('run_delivered')).toBe(true)
    expect(isSponsoredRunOutcomeFunnelEvent('landed')).toBe(false)
    expect(isSponsoredRunOutcomeFunnelEvent('accepted')).toBe(false)
  })
})

test('telemetry only: the modules import nothing that can bill', () => {
  const importsOf = (file: string) =>
    readFileSync(join(import.meta.dir, file), 'utf8').match(/from '[^']+'/g)
  expect(importsOf('sponsored-run-funnel-metadata.ts')).toEqual([
    "from 'zod'",
    "from './sponsored-capability'",
    "from './sponsored-client-version'",
    "from './sponsored-run-funnel-builder'",
    "from './sponsored-run-funnel-builder'",
  ])
  // The builder reads the metadata TYPE back from the schema module (erased).
  expect(importsOf('sponsored-run-funnel-builder.ts')).toEqual([
    "from './sponsored-execution-surface'",
    "from './sponsored-client-version'",
    "from './sponsored-in-place'",
    "from './sponsored-run-funnel-metadata'",
  ])
  // The surface list, the in-place verdict contract and the client-version
  // string handling import nothing, so admitting them widens nothing this
  // test guards.
  for (const leaf of [
    'sponsored-execution-surface.ts',
    'sponsored-in-place.ts',
    'sponsored-client-version.ts',
  ])
    expect(importsOf(leaf)).toBeNull()
})

describe('the execution surface the builder records', () => {
  // The builder used to read the surface with
  // `sponsoredExecutionSurfaceSchema.safeParse`; it now uses a list check so
  // Convex need not evaluate zod. These pin the two to the same answer.
  const OS: Record<SponsoredExecutionSurface, string> = {
    desktop_macos: 'macos',
    desktop_linux: 'linux',
    desktop_windows: 'windows',
    cli_macos: 'macos',
    cli_linux: 'linux',
    cli_wsl: 'linux',
  }
  const INVALID: unknown[] = [
    'cloud',
    '',
    ' desktop_macos',
    'desktop_macos ',
    'DESKTOP_MACOS',
    'cli_windows',
    'desktop',
    null,
    undefined,
    0,
    true,
    ['desktop_macos'],
    { surface: 'desktop_macos' },
  ]

  test('the list is exactly the schema', () => {
    expect([...SPONSORED_EXECUTION_SURFACES].sort()).toEqual(
      [...sponsoredExecutionSurfaceSchema.options].sort(),
    )
    for (const value of [...SPONSORED_EXECUTION_SURFACES, ...INVALID])
      expect(isSponsoredExecutionSurface(value)).toBe(
        sponsoredExecutionSurfaceSchema.safeParse(value).success,
      )
  })

  for (const surface of SPONSORED_EXECUTION_SURFACES) {
    test(`${surface} is recorded with its OS, on and off Cloud`, () => {
      for (const project_id of [undefined, 'project_1']) {
        const metadata = buildSponsoredRunFunnelMetadata({
          eventType: 'run_failed',
          row: { project_id, execution_surface: surface },
        })
        expect(metadata.execution_surface).toBe(surface)
        expect(metadata.os).toBe(OS[surface] as typeof metadata.os)
        expect(
          sponsoredRunFunnelMetadataSchema.safeParse(metadata).success,
        ).toBe(true)
      }
    })
  }

  test('an invalid surface is dropped off Cloud and reads as cloud on it', () => {
    for (const value of INVALID) {
      const row = { execution_surface: value as string | null | undefined }
      const local = buildSponsoredRunFunnelMetadata({
        eventType: 'run_failed',
        row,
      })
      expect('execution_surface' in local).toBe(false)
      expect('os' in local).toBe(false)
      const cloud = buildSponsoredRunFunnelMetadata({
        eventType: 'run_failed',
        row: { ...row, project_id: 'project_1' },
      })
      expect(cloud.execution_surface).toBe('cloud')
      expect('os' in cloud).toBe(false)
    }
  })
})

describe('the receiver schema', () => {
  test('records an unknown failure code as other and keeps every other fact', () => {
    const parsed = sponsoredRunFunnelMetadataReceiverSchema.safeParse({
      execution_mode: 'in_place',
      os: 'windows',
      failure_code: 'code_from_the_future',
    })
    expect(parsed.success && parsed.data).toEqual({
      execution_mode: 'in_place',
      os: 'windows',
      failure_code: 'other',
    })
  })

  test('passes a known code through unchanged', () => {
    const parsed = sponsoredRunFunnelMetadataReceiverSchema.safeParse({
      execution_mode: 'cloud',
      failure_code: 'timed_out',
    })
    expect(parsed.success && parsed.data.failure_code).toBe('timed_out')
  })

  test('still refuses an unknown key and every other out-of-shape value', () => {
    for (const value of [
      { execution_mode: 'in_place', prompt: 'user text' },
      { execution_mode: 'laptop' },
      { execution_mode: 'in_place', os: 'amiga' },
      { execution_mode: 'in_place', failure_code: 7 },
      null,
      'in_place',
    ]) {
      expect(
        sponsoredRunFunnelMetadataReceiverSchema.safeParse(value).success,
      ).toBe(false)
    }
  })
})

describe('every diagnostic authored on main is classified', () => {
  const cases: Array<[string, string]> = [
    // Desktop's three reason strings.
    [
      'never-started: dismissed_while_queued: the card was closed while its turn was still queued behind the conversation',
      'never_started_dismissed',
    ],
    [
      "never-started: queue_wait_expired: its turn was still queued behind the conversation after 1440 minutes, the grant's start deadline",
      'never_started_queue_expired',
    ],
    [
      'never-started: dismissed_during_connect: the card was closed at the account step, before its turn was queued',
      'never_started_connect_dismissed',
    ],
    // Both shutdown / boot quits of a run still queued.
    [
      'never-started: app-quit: the run never reported a verdict and the thread was not resumed at boot; its turn was still queued behind the conversation and never started',
      'never_started_app_quit',
    ],
    [
      'never-started: app-quit: reported from the shutdown handler while the run was unsettled; its turn was still queued behind the conversation and never started',
      'never_started_app_quit',
    ],
    // The rewind / close / delete paths.
    [
      'never-started: the conversation was rewound before its turn started',
      'never_started_inputs_dropped',
    ],
    [
      'never-started: the conversation was closed from its queue before its turn started',
      'never_started_inputs_dropped',
    ],
    [
      'never-started: the conversation was deleted before its turn started',
      'never_started_inputs_dropped',
    ],
    ['never-started: something new', 'never_started_other'],
    ['never-started', 'never_started_other'],
    // Partial edits, whatever ended the turn.
    [
      'turn stopped; the turn ended early, so its partial changes (2 files) were left in the workspace and not reported as delivered',
      'partial_edits',
    ],
    [
      'turn error: x; the turn ended early, so its partial changes (1 file) were left in the workspace and not reported as delivered',
      'partial_edits',
    ],
    [
      'turn closed: app-quit: reported from the shutdown handler while the run was unsettled; the turn ended early, so its partial changes (3 files) were left in the workspace and not reported as delivered',
      'partial_edits',
    ],
    [
      'turn grant-expired; the turn ended early, so its partial changes (3 files) were left in the workspace and not reported as delivered',
      'partial_edits',
    ],
    ['turn completed; the turn recorded no file edits of its own', 'no_edits'],
    [
      'turn error; the model never ran (no response, tool call or tool edit)',
      'turn_error',
    ],
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
    ['app-quit: resumed at boot without a compute grant', 'app_quit'],
    ['stale-sweep: no report for 1440 minutes', 'timed_out'],
    [
      'app-quit: the CLI exited without reporting a verdict (found at launch)',
      'app_quit',
    ],
    [
      sponsoredFundingRefusedDiagnostic('insufficient_balance'),
      'funding_refused',
    ],
    [sponsoredPartialEditsDiagnostic('turn interrupted', 2), 'partial_edits'],
  ]
  for (const reason of Object.keys(
    SPONSORED_NEVER_STARTED_REASONS,
  ) as SponsoredNeverStartedReason[]) {
    const code =
      reason === 'dismissed'
        ? 'never_started_dismissed'
        : reason === 'queueExpired'
          ? 'never_started_queue_expired'
          : reason === 'connectDismissed'
            ? 'never_started_connect_dismissed'
            : reason === 'appQuit'
              ? 'never_started_app_quit'
              : 'never_started_inputs_dropped'
    cases.push([sponsoredNeverStartedDiagnostic(reason, 'detail'), code])
  }

  for (const [diagnostic, code] of cases) {
    test(`${JSON.stringify(diagnostic.slice(0, 48))} is ${code}`, () => {
      const got = sponsoredRunFailureCode({ diagnosticReason: diagnostic })
      expect(got).toBe(code as never)
      expect(got).not.toBe('unclassified')
      expect(SPONSORED_RUN_FAILURE_CODES).toContain(got)
    })
  }
})

describe('the never-started and funding-refused contracts', () => {
  test('the diagnostic builder leads with the prefix and the reason token', () => {
    expect(sponsoredNeverStartedDiagnostic('appQuit', 'the app quit')).toBe(
      `${SPONSORED_NEVER_STARTED_PREFIX}: app_quit: the app quit`,
    )
    expect(sponsoredFundingRefusedDiagnostic('daily_cap')).toBe(
      `${SPONSORED_FUNDING_REFUSED_PREFIX}: daily_cap`,
    )
  })

  test('the never-started set is exactly the six never_started codes', () => {
    expect([...SPONSORED_NEVER_STARTED_FAILURE_CODES].sort()).toEqual(
      SPONSORED_RUN_FAILURE_CODES.filter((code) =>
        code.startsWith('never_started_'),
      ).sort(),
    )
    for (const code of SPONSORED_NEVER_STARTED_FAILURE_CODES) {
      expect(isSponsoredNeverStartedFailure(code)).toBe(true)
    }
    for (const code of [
      'funding_refused',
      'partial_edits',
      'app_quit',
      'timed_out',
      '',
      null,
      undefined,
    ]) {
      expect(isSponsoredNeverStartedFailure(code)).toBe(false)
    }
  })

  test('never-started and funding-refused called no model; partial edits did', () => {
    const diagnostics = [
      ...(
        Object.keys(
          SPONSORED_NEVER_STARTED_REASONS,
        ) as SponsoredNeverStartedReason[]
      ).map((reason) => sponsoredNeverStartedDiagnostic(reason, 'x')),
      'never-started: whatever',
      sponsoredFundingRefusedDiagnostic('total_cap'),
    ]
    for (const diagnostic of diagnostics) {
      const metadata = buildSponsoredRunFunnelMetadata({
        eventType: 'run_failed',
        row: { in_place_execution: true, diagnostic_reason: diagnostic },
        fromState: 'accepted',
      })
      expect(metadata.llm_called).toBe(false)
    }
    const partial = buildSponsoredRunFunnelMetadata({
      eventType: 'run_failed',
      row: {
        in_place_execution: true,
        diagnostic_reason: sponsoredPartialEditsDiagnostic('turn stopped', 2),
      },
      fromState: 'running',
    })
    expect(partial.failure_code).toBe('partial_edits')
    expect(partial.llm_called).toBe(true)
    expect(SPONSORED_PARTIAL_EDITS_COPY.failed.length).toBeGreaterThan(0)
  })
})

describe('client_version on the built metadata', () => {
  test('is carried from the acceptance when it matches the pattern', () => {
    const metadata = buildSponsoredRunFunnelMetadata({
      eventType: 'run_delivered',
      row: {
        in_place_execution: true,
        acceptance: { surface: 'desktop', client_version: 'desktop/0.0.152' },
      },
      fromState: 'running',
    })
    expect(metadata.client_version).toBe('desktop/0.0.152')
    expect(sponsoredRunFunnelMetadataSchema.safeParse(metadata).success).toBe(
      true,
    )
  })

  test('an invalid client_version is dropped', () => {
    for (const client_version of ['phone/1.0', 'desktop/', 'cli/1 2', null]) {
      const metadata = buildSponsoredRunFunnelMetadata({
        eventType: 'run_failed',
        row: {
          in_place_execution: true,
          acceptance: { surface: 'cli', client_version },
          diagnostic_reason: 'turn completed; HEAD is still the base commit',
        },
      })
      expect('client_version' in metadata).toBe(false)
    }
  })
})
