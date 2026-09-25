/**
 * The CLI's in-place sponsored run (#3989's flow): the sequence of decisions,
 * not the plumbing.
 *
 * Everything is INJECTED rather than mocked (docs/testing.md): a fake preview,
 * accept and state reporter, in-memory stores, and a real temporary folder for
 * the receipts. What is being tested is an order -- review before any write,
 * one funded accept per review, a turn only once asked for, a verdict read off
 * the run's own edits, an undo that never clobbers -- and an order is exactly
 * the thing a module mock cannot pin.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ensureCliTestEnv } from '../../__tests__/test-utils'

ensureCliTestEnv()

const {
  ACCEPT_RETRY_DELAYS_MS,
  SponsoredRun,
  cliExecutionSurface,
  diagnosticCause,
  replayForeignOutboxes,
  setSponsoredRunInstance,
  sponsoredRunFor,
  sponsoredTaskEvidence,
  sponsoredVerdictNotice,
} = await import('../sponsored-run')

import type {
  SponsoredOverrideTools,
  SponsoredRunDeps,
  SponsoredToolContext,
} from '../sponsored-run'
import type { SponsoredProposal } from '../sponsored-proposal-api'

const PARENT = mkdtempSync(join(tmpdir(), 'sponsored-cli-run-'))
afterAll(() => rmSync(PARENT, { recursive: true, force: true }))

const PROCEDURE = 'Wire up the Acme deploy hook.'
const PROCEDURE_SHA =
  'e0398edf7222298cb1af685870a496350db33a54d32e766b8d94523f4848e304'

const PROPOSAL: SponsoredProposal = {
  _id: 'proposal-1',
  advertiser_id: 'adv_acme',
  state: 'offered',
  advertiser_name: 'Acme Deploys',
  headline: 'Add one-click deploys',
  body: 'A sponsored agent can wire Acme Deploys into your repo.',
}

type Reported = {
  state: string
  failureReason?: string
  diagnosticReason?: string
  reportId?: string
  runId?: string
  outcomes?: string[]
}

let projectCounter = 0
function project(): string {
  projectCounter += 1
  const root = join(PARENT, `project-${projectCounter}`)
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'app.ts'), 'export const app = 1\n')
  return realpathSync(root)
}

function fakes(over: Partial<SponsoredRunDeps> = {}) {
  const root = project()
  const reported: Reported[] = []
  const accepts: Array<Record<string, unknown>> = []
  const previews: Array<{ target: unknown; surface: unknown }> = []
  const sleeps: number[] = []
  const contexts: SponsoredToolContext[] = []
  let terminalReports = '[]'
  const receipts = new Map<string, string>()
  let lastRun: string | null = null
  let now = Date.now()

  const deps: SponsoredRunDeps = {
    preview: async (proposalId, _token, target, surface) => {
      previews.push({ target, surface })
      return {
        ok: true,
        preview: {
          proposalId,
          procedure: PROCEDURE,
          procedureSha256: PROCEDURE_SHA,
        },
      }
    },
    accept: async (proposalId, _token, binding) => {
      accepts.push({ proposalId, ...binding })
      return {
        ok: true,
        accept: {
          proposalId,
          state: 'accepted',
          procedure: PROCEDURE,
          advertiserName: 'Acme Deploys',
          headline: 'Add one-click deploys',
          runToken: 'token-1',
          expiresAt: new Date(now + 86_400_000).toISOString(),
          computeGrant: {
            token: `scg_1_${'a'.repeat(43)}`,
            proposalId,
            runId: binding!.runId,
            procedureSha256: PROCEDURE_SHA,
            modelId: 'freebuff/deepseek-v4-flash',
            expiresAtMs: now + 3_600_000,
            allowanceUsdMicros: 500_000,
          },
        },
      }
    },
    reportState: async (_id, _token, update) => {
      reported.push(update as Reported)
      return { ok: true, status: 200 }
    },
    getToken: () => 'session-token',
    platform: 'darwin',
    // What the real probe answers, per platform, without starting a sandbox.
    containment: (platform) =>
      platform === 'win32'
        ? { available: false, reason: 'windows-no-containment' }
        : { available: true, mechanism: 'sandbox-exec' },
    executionSurface: () => 'cli_macos',
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    terminalReports: {
      read: () => terminalReports,
      write: (value) => {
        terminalReports = value
      },
    },
    receipts: {
      read: (runId) => receipts.get(runId) ?? null,
      write: (runId, value) => void receipts.set(runId, value),
    },
    lastRun: {
      read: () => lastRun,
      write: (runId) => {
        lastRun = runId
      },
    },
    target: async () => ({ kind: 'repo', repoFullName: 'acme/app' }),
    agentId: () => 'base3-free-test',
    // The real overrides would start an OS sandbox; the context they are built
    // from is what these tests are about, and the recorder in it is real.
    overrideTools: (context) => {
      contexts.push(context)
      return {} as SponsoredOverrideTools
    },
    ...over,
  }
  const service = new SponsoredRun(root, deps)
  return {
    root,
    deps,
    service,
    reported,
    accepts,
    previews,
    sleeps,
    contexts,
    receipts,
    advance: (ms: number) => {
      now += ms
    },
    terminalReports: () => terminalReports,
    setTerminalReports: (value: string) => {
      terminalReports = value
    },
  }
}

function reviewedTask() {
  const task = sponsoredTaskEvidence([
    { variant: 'user', content: 'What database should I set up?' },
  ])
  if (!task) throw new Error('expected task evidence')
  return task
}

async function acceptThrough(f: ReturnType<typeof fakes>) {
  const consent = await f.service.consentFor(PROPOSAL, reviewedTask())
  if (!consent.ok) throw new Error(consent.message)
  return {
    consent,
    outcome: await f.service.accept(PROPOSAL, consent.runId, reviewedTask()),
  }
}

/** Accept, start the turn, and let the "run" write through the real recorder. */
async function runThrough(
  f: ReturnType<typeof fakes>,
  edit: (context: SponsoredToolContext) => Promise<void> = async () => {},
) {
  const accepted = await acceptThrough(f)
  const plan = await f.service.startTurn()
  if (!plan) throw new Error('expected a plan')
  await edit(f.contexts.at(-1)!)
  return { ...accepted, plan }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 5))
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

describe('availability decides whether anything can be offered at all', () => {
  test('Windows refuses, and it refuses BEFORE the preview', async () => {
    const f = fakes({ platform: 'win32' })
    const consent = await f.service.consentFor(PROPOSAL, reviewedTask())
    expect(consent.ok).toBe(false)
    expect(f.previews).toHaveLength(0)
    expect(f.accepts).toHaveLength(0)
  })

  test('the execution surface is macOS, Linux or WSL, and nothing on Windows', () => {
    expect(cliExecutionSurface('darwin', '24.0.0')).toBe('cli_macos')
    expect(cliExecutionSurface('linux', '6.8.0-generic')).toBe('cli_linux')
    expect(
      cliExecutionSurface('linux', '5.15.153.1-microsoft-standard-WSL2'),
    ).toBe('cli_wsl')
    expect(cliExecutionSurface('win32', '10.0')).toBeNull()
  })
})

describe('consent is a READ', () => {
  test('the preview names this surface and this project, and nothing is written', async () => {
    const f = fakes()
    const consent = await f.service.consentFor(PROPOSAL, reviewedTask())
    if (!consent.ok) throw new Error('refused')
    expect(f.previews).toEqual([
      {
        target: { kind: 'repo', repoFullName: 'acme/app' },
        surface: 'cli_macos',
      },
    ])
    expect(f.accepts).toHaveLength(0)
    expect(f.reported).toHaveLength(0)
    // The exact reviewed text, and the folder the edits land in. No branch:
    // an in-place run cuts none.
    expect(consent.consent.procedure).toBe(PROCEDURE)
    expect(consent.consent.folder).toBe(f.root)
    expect('branch' in consent.consent).toBe(false)
  })

  test('no git precondition: an uncommitted folder can still be reviewed', async () => {
    // The worktree flow refused a dirty tree because it needed a clean
    // baseline to branch from. The undo replaces the baseline.
    const f = fakes()
    writeFileSync(join(f.root, 'src', 'dirty.ts'), 'uncommitted\n')
    const consent = await f.service.consentFor(PROPOSAL, reviewedTask())
    expect(consent.ok).toBe(true)
  })

  test('a second review of the same offer keeps the same run id', async () => {
    // An Accept that timed out may be durable upstream under the first id; a
    // fresh one would be refused as a different approval.
    const f = fakes()
    const first = await f.service.consentFor(PROPOSAL, reviewedTask())
    const second = await f.service.consentFor(PROPOSAL, reviewedTask())
    if (!first.ok || !second.ok) throw new Error('refused')
    expect(second.runId).toBe(first.runId)
  })
})

describe('the funded accept', () => {
  test('carries this surface, the run id and the reviewed SHA -- and starts nothing', async () => {
    const f = fakes()
    const { consent, outcome } = await acceptThrough(f)
    if (!consent.ok) throw new Error('refused')
    expect(outcome).toEqual({ ok: true })
    expect(f.accepts).toEqual([
      {
        proposalId: 'proposal-1',
        runId: consent.runId,
        procedureSha256: PROCEDURE_SHA,
        target: { kind: 'repo', repoFullName: 'acme/app' },
        clientExecutionSurface: 'cli_macos',
      },
    ])
    // QUEUED, not running: chat starts the turn when the conversation is free.
    expect(f.service.state.phase).toBe('queued')
    expect(f.reported).toHaveLength(0)
    expect(f.contexts).toHaveLength(0)
  })

  test('a lost response is retried on Desktop’s schedule; an answer is not', async () => {
    let attempts = 0
    const f = fakes({
      accept: async (proposalId, token, binding) => {
        attempts += 1
        if (attempts < 3) {
          return { ok: false, status: 0, message: 'Could not reach Freebuff.' }
        }
        return fakes().deps.accept(proposalId, token, binding)
      },
    })
    const { outcome } = await acceptThrough(f)
    expect(outcome.ok).toBe(true)
    expect(attempts).toBe(3)
    expect(f.sleeps).toEqual(ACCEPT_RETRY_DELAYS_MS.slice(0, 2))

    let refusedAttempts = 0
    const g = fakes({
      accept: async () => {
        refusedAttempts += 1
        return {
          ok: false,
          status: 422,
          message: 'This sponsored offer has expired. Nothing was started.',
          code: 'unfunded_impression',
        }
      },
    })
    const refused = await acceptThrough(g)
    expect(refused.outcome.ok).toBe(false)
    expect(refusedAttempts).toBe(1)
    expect(g.service.state.phase).toBe('idle')
  })

  test('a changed procedure asks for a fresh review instead of refusing', async () => {
    const f = fakes({
      accept: async () => ({
        ok: false,
        status: 409,
        message: 'This sponsored task changed after you reviewed it.',
        code: 'procedure_changed',
      }),
    })
    const { outcome } = await acceptThrough(f)
    expect(outcome).toMatchObject({ ok: false, reviewAgain: true })
  })

  test('a task context that changed after review refuses before any write', async () => {
    const f = fakes()
    const consent = await f.service.consentFor(PROPOSAL, reviewedTask())
    if (!consent.ok) throw new Error('refused')
    const changed = sponsoredTaskEvidence([
      { variant: 'user', content: 'Actually, do something else.' },
    ])
    const outcome = await f.service.accept(PROPOSAL, consent.runId, changed)
    expect(outcome.ok).toBe(false)
    expect(f.accepts).toHaveLength(0)
  })

  test('one accept at a time', async () => {
    const f = fakes()
    await acceptThrough(f)
    const again = await f.service.consentFor(PROPOSAL, reviewedTask())
    expect(again.ok).toBe(false)
  })
})

describe('the turn', () => {
  test('its plan is pinned: sponsor metadata, fresh prompt, this folder', async () => {
    const f = fakes()
    const { plan, consent } = await runThrough(f)
    if (!consent.ok) throw new Error('refused')
    expect(plan.cwd).toBe(f.root)
    expect(plan.extraCodebuffMetadata).toEqual({
      freebuff_sponsored_proposal_id: 'proposal-1',
      freebuff_sponsored_run_id: consent.runId,
      freebuff_sponsored_procedure_sha256: PROCEDURE_SHA,
      freebuff_sponsored_compute_token: `scg_1_${'a'.repeat(43)}`,
      freebuff_sponsored_surface: 'cli',
    })
    // No Freebuff session rides beside the grant: the user does not pay.
    expect(plan.extraCodebuffMetadata).not.toHaveProperty(
      'freebuff_instance_id',
    )
    expect(plan.prompt).toContain(PROCEDURE)
    expect(plan.prompt).toContain('What database should I set up?')
    expect(plan.prompt).toContain('UNCOMMITTED')
    expect(plan.agent.id).toBe('base3-free-test')
    expect(f.contexts[0]!.workspaceRoot).toBe(f.root)
  })

  test('running is reported when the turn starts, with the funded identity', async () => {
    const f = fakes()
    const { consent } = await acceptThrough(f)
    if (!consent.ok) throw new Error('refused')
    expect(f.reported).toHaveLength(0)
    await f.service.startTurn()
    expect(f.reported).toEqual([
      {
        state: 'running',
        reportId: `running:${consent.runId}`,
        runId: consent.runId,
      },
    ])
    expect(f.service.state.phase).toBe('running')
  })

  test('an expired grant starts nothing and fails the run', async () => {
    const f = fakes()
    await acceptThrough(f)
    f.advance(3_600_001)
    expect(await f.service.startTurn()).toBeNull()
    await settle()
    expect(f.reported.map((r) => r.state)).toEqual(['failed'])
    expect(f.service.state.phase).toBe('failed')
  })

  test('a grant with a start deadline still starts after a long wait (COD-665)', async () => {
    // What the server issues now: 24h to start, an hour once running. The
    // conversation was busy for three hours; the run still gets its turn.
    const f = fakes({
      accept: async (proposalId, token, binding) => {
        const result = await fakes().deps.accept(proposalId, token, binding)
        if (!result.ok || !result.accept.computeGrant) return result
        const grant = result.accept.computeGrant
        return {
          ...result,
          accept: {
            ...result.accept,
            computeGrant: {
              ...grant,
              expiresAtMs: grant.expiresAtMs + 23 * 3_600_000,
            },
          },
        }
      },
    })
    await acceptThrough(f)
    f.advance(3 * 3_600_000)
    expect(await f.service.startTurn()).not.toBeNull()
    expect(f.service.state.phase).toBe('running')
  })

  test('nothing to start when nothing was accepted', async () => {
    const f = fakes()
    expect(await f.service.startTurn()).toBeNull()
  })

  test('a grant that expires mid-run aborts the turn, and the verdict says why', async () => {
    const f = fakes()
    await acceptThrough(f)
    // Five milliseconds of grant left when the turn starts.
    f.advance(3_600_000 - 5)
    const plan = await f.service.startTurn()
    if (!plan) throw new Error('expected a plan')
    expect(plan.signal.aborted).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(plan.signal.aborted).toBe(true)
    expect(plan.signal.reason).toBe('grant-expired')
    await f.service.settleTurn({ errorText: null, aborted: true })
    await settle()
    const failed = f.reported.at(-1)!
    expect(failed.state).toBe('failed')
    expect(failed.diagnosticReason).toContain('turn grant-expired')
  })

  test('Esc ends the turn as aborted: with no edits it FAILS as interrupted', async () => {
    const f = fakes()
    await runThrough(f)
    await f.service.settleTurn({ errorText: null, aborted: true })
    await settle()
    expect(f.service.state.phase).toBe('failed')
    const failed = f.reported.at(-1)!
    expect(failed.failureReason).toContain(
      'interrupted before it changed anything',
    )
    expect(failed.diagnosticReason).toContain('turn interrupted')
  })
})

describe('the verdict is read off the run’s own edits', () => {
  test('a run that changed files is DELIVERED, and the conversation is briefed', async () => {
    const f = fakes()
    await runThrough(f, async (context) => {
      await context.recorder.around('src/app.ts', async () => {
        writeFileSync(join(f.root, 'src', 'app.ts'), 'export const app = 2\n')
      })
      await context.recorder.around('.env.example', async () => {
        writeFileSync(join(f.root, '.env.example'), 'ACME_KEY=\n')
      })
    })
    const brief = await f.service.settleTurn({
      errorText: null,
      aborted: false,
    })
    await settle()
    expect(f.reported.map((r) => r.state)).toEqual(['running', 'delivered'])
    expect(f.service.state.phase).toBe('delivered')
    expect([...f.service.state.changedFiles].sort()).toEqual([
      '.env.example',
      'src/app.ts',
    ])
    expect(brief).toContain('<sponsored_changes>')
    expect(brief).toContain('src/app.ts')
    expect(sponsoredVerdictNotice(f.service.state)).toContain('/ads:undo')
  })

  test('a run that changed nothing is FAILED, and says nothing changed', async () => {
    const f = fakes()
    await runThrough(f)
    const brief = await f.service.settleTurn({
      errorText: null,
      aborted: false,
    })
    await settle()
    expect(brief).toBeNull()
    const failed = f.reported.at(-1)!
    expect(failed.state).toBe('failed')
    expect(failed.failureReason).toContain('without changing anything')
    expect(failed.diagnosticReason).toContain('no file edits')
  })

  test('an interrupted run that wrote something is still DELIVERED', async () => {
    const f = fakes()
    await runThrough(f, async (context) => {
      await context.recorder.around('src/app.ts', async () => {
        writeFileSync(join(f.root, 'src', 'app.ts'), 'partial\n')
      })
    })
    const outcome = await f.service.interrupt('ctrl-c')
    await settle()
    expect(outcome.interrupted).toBe(true)
    expect(outcome.notice).toContain('/ads:undo')
    const last = f.reported.at(-1)!
    expect(last.state).toBe('delivered')
    expect(last.diagnosticReason).toContain(
      'changes were left in the workspace',
    )
  })

  test('the verdict is reported once, however many times the turn ends', async () => {
    const f = fakes()
    await runThrough(f)
    await f.service.interrupt('signal')
    await f.service.settleTurn({ errorText: null, aborted: true })
    await settle()
    expect(f.reported.filter((r) => r.state !== 'running')).toHaveLength(1)
  })
})

describe('undo', () => {
  test('restores modified files, deletes created ones, and briefs the agent', async () => {
    const f = fakes()
    await runThrough(f, async (context) => {
      await context.recorder.around('src/app.ts', async () => {
        writeFileSync(join(f.root, 'src', 'app.ts'), 'export const app = 2\n')
      })
      await context.recorder.around('src/new.ts', async () => {
        writeFileSync(join(f.root, 'src', 'new.ts'), 'created\n')
      })
    })
    await f.service.settleTurn({ errorText: null, aborted: false })
    const undone = f.service.undo()
    expect(undone.ok).toBe(true)
    expect(readFileSync(join(f.root, 'src', 'app.ts'), 'utf8')).toBe(
      'export const app = 1\n',
    )
    expect(existsSync(join(f.root, 'src', 'new.ts'))).toBe(false)
    expect(undone.message).toContain('2 restored')
    expect(undone.message).toContain('nothing is charged to you')
    expect(undone.brief).toContain('undid')
    expect(f.service.state.undone).toBe(true)
    // A second undo changes nothing.
    const again = f.service.undo()
    expect(again.ok).toBe(false)
    expect(again.message).toContain('already undone')
  })

  test('a file the user changed since is SKIPPED and named, never clobbered', async () => {
    const f = fakes()
    await runThrough(f, async (context) => {
      await context.recorder.around('src/app.ts', async () => {
        writeFileSync(join(f.root, 'src', 'app.ts'), 'sponsor edit\n')
      })
    })
    await f.service.settleTurn({ errorText: null, aborted: false })
    writeFileSync(join(f.root, 'src', 'app.ts'), 'the user kept working\n')
    const undone = f.service.undo()
    expect(undone.message).toContain('skipped')
    expect(undone.message).toContain('src/app.ts')
    expect(readFileSync(join(f.root, 'src', 'app.ts'), 'utf8')).toBe(
      'the user kept working\n',
    )
    expect(undone.message).toContain('/ads:undo again')
    expect(f.service.state.undone).toBe(false)

    // Once the file is back to what the sponsor left, a second undo finishes
    // the job instead of answering "already undone".
    writeFileSync(join(f.root, 'src', 'app.ts'), 'sponsor edit\n')
    const second = f.service.undo()
    expect(second.ok).toBe(true)
    expect(second.message).toContain('1 restored')
    expect(f.service.state.undone).toBe(true)
    expect(f.service.undo().message).toContain('already undone')
  })

  test('a file the user already put back is counted as restored, not owed forever', async () => {
    const f = fakes()
    writeFileSync(join(f.root, 'src', 'app.ts'), 'original\n')
    await runThrough(f, async (context) => {
      await context.recorder.around('src/app.ts', async () => {
        writeFileSync(join(f.root, 'src', 'app.ts'), 'sponsor edit\n')
      })
    })
    await f.service.settleTurn({ errorText: null, aborted: false })
    writeFileSync(join(f.root, 'src', 'app.ts'), 'original\n')
    const undone = f.service.undo()
    expect(undone.message).toContain('1 restored')
    expect(undone.message).not.toContain('skipped')
    expect(f.service.state.undone).toBe(true)
  })

  test('works after a restart, from the receipts on disk', async () => {
    const f = fakes()
    await runThrough(f, async (context) => {
      await context.recorder.around('src/app.ts', async () => {
        writeFileSync(join(f.root, 'src', 'app.ts'), 'sponsor edit\n')
      })
    })
    await f.service.settleTurn({ errorText: null, aborted: false })
    const restarted = new SponsoredRun(f.root, f.deps)
    expect(restarted.undo().ok).toBe(true)
    expect(readFileSync(join(f.root, 'src', 'app.ts'), 'utf8')).toBe(
      'export const app = 1\n',
    )
  })

  test('refuses while the run is still working', async () => {
    const f = fakes()
    await runThrough(f)
    expect(f.service.undo().ok).toBe(false)
  })

  test('says so when the run used the shell, whose writes are not receipted', async () => {
    const f = fakes()
    await runThrough(f, async (context) => {
      context.recorder.noteShellCommand()
      await context.recorder.around('src/app.ts', async () => {
        writeFileSync(join(f.root, 'src', 'app.ts'), 'sponsor edit\n')
      })
    })
    await f.service.settleTurn({ errorText: null, aborted: false })
    expect(f.service.undo().message).toContain('not tracked')
  })
})

describe('the terminal-report outbox', () => {
  test('a terminal report is persisted before it is sent, and removed once delivered', async () => {
    const seen: string[] = []
    const f = fakes({
      reportState: async (_id, _token, update) => {
        seen.push(f.terminalReports())
        return { ok: true, status: 200 }
      },
    })
    await runThrough(f)
    await f.service.settleTurn({ errorText: null, aborted: false })
    await settle()
    // The second report (the terminal one) saw itself already persisted.
    expect(JSON.parse(seen.at(-1)!)).toHaveLength(1)
    expect(JSON.parse(f.terminalReports())).toEqual([])
  })

  test('a transient report is never given up on', async () => {
    let terminalAttempts = 0
    const f = fakes({
      reportState: async (_id, _token, update) => {
        if (update.state === 'running') return { ok: true, status: 200 }
        terminalAttempts += 1
        return { ok: false, status: 0, message: 'offline' }
      },
    })
    await runThrough(f)
    await f.service.settleTurn({ errorText: null, aborted: false })
    await settle()
    for (let retry = 1; retry < 12; retry += 1) {
      const pending = JSON.parse(f.terminalReports())
      pending[0].nextDueAt = 0
      f.setTerminalReports(JSON.stringify(pending))
      f.service.flushPendingReports()
      await settle()
    }
    expect(terminalAttempts).toBe(12)
    expect(JSON.parse(f.terminalReports())[0]).toMatchObject({
      attempts: 12,
      lastError: 'offline',
      disposition: 'pending',
    })
  })

  test('a report an older build marked exhausted is sent again', async () => {
    let delivered = 0
    const f = fakes({
      reportState: async () => {
        delivered += 1
        return { ok: true, status: 200 }
      },
    })
    await settle()
    f.setTerminalReports(
      JSON.stringify([
        {
          proposalId: 'old-proposal',
          runToken: 'old-token',
          update: { state: 'failed', reportId: 'old-report', runId: 'old-run' },
          attempts: 8,
          nextDueAt: 0,
          lastError: 'offline',
          disposition: 'exhausted',
        },
      ]),
    )
    f.service.flushPendingReports()
    await settle()
    expect(delivered).toBe(1)
    expect(JSON.parse(f.terminalReports())).toEqual([])
  })

  test('a refused report does not block a later one', async () => {
    let calls = 0
    const f = fakes({
      reportState: async () => {
        calls += 1
        return calls === 1
          ? { ok: false, status: 409, message: 'report_conflict' }
          : { ok: true, status: 200 }
      },
    })
    await settle()
    const report = (reportId: string) => ({
      proposalId: 'p',
      runToken: 't',
      update: { state: 'failed', reportId, runId: 'r' },
      attempts: 0,
      nextDueAt: 0,
      lastError: null,
      disposition: 'pending',
    })
    f.setTerminalReports(JSON.stringify([report('first'), report('second')]))
    f.service.flushPendingReports()
    await settle()
    expect(calls).toBe(2)
    expect(JSON.parse(f.terminalReports())).toMatchObject([
      { disposition: 'permanent_refusal' },
    ])
  })
})

describe('the process-wide run follows the project root', () => {
  // The root can change mid-process (switch to the git root, the project
  // picker), and chat builds the run at mount to replay its outbox -- so a run
  // pinned to the launch root would review and edit the folder the user left.
  test('an idle run for another root is replaced', () => {
    const f = fakes()
    const other = project()
    try {
      setSponsoredRunInstance(new SponsoredRun(f.root, f.deps))
      expect(sponsoredRunFor(other).root).toBe(other)
    } finally {
      setSponsoredRunInstance(null)
    }
  })

  test('a run that is queued or running is kept for its own folder', async () => {
    const f = fakes()
    await acceptThrough(f)
    setSponsoredRunInstance(f.service)
    try {
      expect(f.service.idle).toBe(false)
      expect(sponsoredRunFor(project())).toBe(f.service)
    } finally {
      setSponsoredRunInstance(null)
    }
  })
})

describe('one failing report does not hold the others back', () => {
  test('a later report is sent while an earlier one keeps failing', async () => {
    // With no attempt cap, stopping at the first failure would strand every
    // later report -- a newer run's included -- behind one that never lands.
    const sent: string[] = []
    const f = fakes({
      reportState: async (proposalId) => {
        sent.push(proposalId)
        return proposalId === 'stuck'
          ? { ok: false, status: 503, message: 'unavailable' }
          : { ok: true, status: 200 }
      },
    })
    await settle()
    const entry = (proposalId: string) => ({
      proposalId,
      runToken: 't',
      update: { state: 'failed', reportId: `r-${proposalId}`, runId: 'r' },
      attempts: 4,
      nextDueAt: 0,
      lastError: null,
      disposition: 'pending',
    })
    f.setTerminalReports(JSON.stringify([entry('stuck'), entry('later')]))
    f.service.flushPendingReports()
    await settle()
    expect(sent).toEqual(['stuck', 'later'])
    expect(JSON.parse(f.terminalReports())).toMatchObject([
      { proposalId: 'stuck', disposition: 'pending', attempts: 5 },
    ])
  })
})

describe('other folders’ outboxes', () => {
  test('are drained too, and this folder’s is left to its own run', async () => {
    // A report stranded by a crash in folder A must not wait for the CLI to
    // be opened in A again: the row sits on `running`, its grant live.
    const directory = mkdtempSync(join(tmpdir(), 'sponsored-cli-outboxes-'))
    const own = 'a'.repeat(64)
    const foreign = 'b'.repeat(64)
    const entry = (reportId: string) =>
      JSON.stringify([
        {
          proposalId: `p-${reportId}`,
          runToken: 't',
          update: { state: 'failed', reportId, runId: 'r' },
          attempts: 3,
          nextDueAt: 0,
          lastError: 'offline',
          disposition: 'pending',
        },
      ])
    writeFileSync(join(directory, `${own}.json`), entry('own'))
    writeFileSync(join(directory, `${foreign}.json`), entry('foreign'))
    writeFileSync(join(directory, 'not-an-outbox.txt'), 'ignored')
    const sent: string[] = []
    try {
      const f = fakes()
      replayForeignOutboxes(directory, own, (terminalReports) => ({
        ...f.deps,
        terminalReports,
        reportState: async (proposalId) => {
          sent.push(proposalId)
          return { ok: true, status: 200 }
        },
      }))
      await settle()
      expect(sent).toEqual(['p-foreign'])
      expect(
        JSON.parse(readFileSync(join(directory, `${foreign}.json`), 'utf8')),
      ).toEqual([])
      expect(
        JSON.parse(readFileSync(join(directory, `${own}.json`), 'utf8')),
      ).toHaveLength(1)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('diagnosticCause', () => {
  test('first line only, and capped', () => {
    expect(diagnosticCause('boom\nstack trace\nsource')).toBe(': boom')
    expect(diagnosticCause(null)).toBe('')
    expect(diagnosticCause('x'.repeat(500)).length).toBeLessThan(210)
  })
})
