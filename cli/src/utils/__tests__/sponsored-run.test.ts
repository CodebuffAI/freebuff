/**
 * COD-339's execution half: the sequence of decisions, not the plumbing.
 *
 * Everything is INJECTED rather than mocked (docs/testing.md): a fake accept, a
 * fake state reporter, a fake git and a fake turn. What is being tested is an
 * order — consent before any write, one accept per proposal, a terminal state
 * for every ending, and no push that git did not first agree to — and an order
 * is exactly the thing a module mock cannot pin.
 *
 * The git runner answers by ARGUMENT rather than by call count, because the
 * order these commands run in is an implementation detail and the assertions
 * here are not about it.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { ensureCliTestEnv } from '../../__tests__/test-utils'

ensureCliTestEnv()

const {
  SponsoredRun,
  diagnosticCause,
  noHooksEnv,
  sponsoredRunTitle,
  sponsoredTaskEvidence,
} = await import('../sponsored-run')

import type { SponsoredRunDeps, SponsoredTurnContext } from '../sponsored-run'
import type { SponsoredProposal } from '../sponsored-proposal-api'

const ROOT = '/repo'
const PROPOSAL: SponsoredProposal = {
  _id: 'proposal-1',
  advertiser_id: 'adv_acme',
  state: 'offered',
  advertiser_name: 'Acme Deploys',
  headline: 'Add one-click deploys',
  body: 'A sponsored agent can wire Acme Deploys into your repo.',
}

const ACCEPT = {
  proposalId: 'proposal-1',
  state: 'accepted' as const,
  procedure: 'Wire up the Acme deploy hook.',
  advertiserName: 'Acme Deploys',
  headline: 'Add one-click deploys',
  runToken: 'token-1',
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  computeGrant: {
    token: 'scg_1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    proposalId: 'proposal-1',
    runId: '00000000-0000-4000-8000-000000000001',
    procedureSha256:
      'e0398edf7222298cb1af685870a496350db33a54d32e766b8d94523f4848e304',
    modelId: 'freebuff/deepseek-v4-flash',
    expiresAtMs: Date.now() + 86_400_000,
    allowanceUsdMicros: 500_000,
  },
}

type Reported = {
  state: string
  failureReason?: string
  prUrl?: string
  reportId?: string
}

function fakes(
  over: Partial<SponsoredRunDeps> = {},
  gitOver: Record<string, { exitCode: number; stdout: string }> = {},
) {
  const reported: Reported[] = []
  const accepts: string[] = []
  const turns: SponsoredTurnContext[] = []
  const delivered: string[][] = []
  let terminalReports = '[]'
  // The branch tip, which is what decides `committed`. Tests move it.
  let head = 'base-sha'

  const git: SponsoredRunDeps['git'] = async (args) => {
    const key = args.join(' ')
    for (const [match, result] of Object.entries(gitOver)) {
      if (key.includes(match)) return { stderr: '', ...result }
    }
    if (key.includes('--is-inside-work-tree')) {
      return { exitCode: 0, stdout: 'true\n', stderr: '' }
    }
    if (key.includes('symbolic-ref')) {
      return { exitCode: 0, stdout: 'main\n', stderr: '' }
    }
    if (key.includes('--git-common-dir')) {
      return { exitCode: 0, stdout: '/repo/.git\n', stderr: '' }
    }
    if (key.includes('--git-dir')) {
      return { exitCode: 0, stdout: '/repo/.git/worktrees/w\n', stderr: '' }
    }
    if (key.includes('rev-parse HEAD')) {
      return { exitCode: 0, stdout: `${head}\n`, stderr: '' }
    }
    return { exitCode: 0, stdout: '', stderr: '' }
  }

  const deps: SponsoredRunDeps = {
    preview: async (proposalId) => ({
      ok: true,
      preview: {
        proposalId,
        procedure: ACCEPT.procedure,
        procedureSha256: ACCEPT.computeGrant.procedureSha256,
      },
    }),
    accept: async (proposalId, _token, binding) => {
      accepts.push(proposalId)
      return {
        ok: true,
        accept: {
          ...ACCEPT,
          computeGrant: {
            ...ACCEPT.computeGrant,
            runId: binding?.runId ?? ACCEPT.computeGrant.runId,
            procedureSha256:
              binding?.procedureSha256 ?? ACCEPT.computeGrant.procedureSha256,
          },
        },
      }
    },
    reportState: async (_id, _token, update) => {
      reported.push(update as Reported)
      return { ok: true, status: 200 }
    },
    getToken: () => 'session-token',
    git,
    // The worktree is never created on disk here; `git worktree add` is faked.
    exists: () => true,
    platform: 'darwin',
    containment: (platform) =>
      platform === 'win32'
        ? { available: false, reason: 'windows-no-containment' }
        : { available: true, mechanism: 'sandbox-exec' },
    target: async () => ({ kind: 'repo', repoFullName: 'acme/app' }),
    runTurn: async (context) => {
      turns.push(context)
      return null
    },
    deliver: async (command, args) => {
      delivered.push([command, ...args])
      return command === 'gh'
        ? { exitCode: 0, stdout: 'https://github.com/x/y/pull/7\n', stderr: '' }
        : { exitCode: 0, stdout: '', stderr: '' }
    },
    now: () => 0,
    terminalReports: {
      read: () => terminalReports,
      write: (value) => {
        terminalReports = value
      },
    },
    ...over,
  }
  return {
    deps,
    reported,
    accepts,
    turns,
    delivered,
    terminalReports: () => terminalReports,
    setTerminalReports: (value: string) => {
      terminalReports = value
    },
    moveHead: (sha: string) => {
      head = sha
    },
    service: new SponsoredRun(ROOT, deps),
  }
}

/** Consent, then accept, which is the order every test below starts with. */
async function acceptThrough(f: ReturnType<typeof fakes>) {
  const consent = await f.service.consentFor(PROPOSAL)
  if (!consent.ok) throw new Error(consent.message)
  return {
    consent,
    outcome: await f.service.accept(PROPOSAL, consent.runId, reviewedTask()),
  }
}

function reviewedTask() {
  const task = sponsoredTaskEvidence([
    { variant: 'user', content: 'Review this sponsored task.' },
  ])
  if (!task) throw new Error('expected task evidence')
  return task
}

describe('availability decides whether anything can be offered at all', () => {
  test('Windows refuses, and it refuses BEFORE the accept', async () => {
    // COD-336 item 3. The refusal has to come before the network write, not
    // after: a row accepted on a machine that cannot run it is a row nothing
    // will ever move off `accepted`.
    const f = fakes({ platform: 'win32' })
    expect(f.service.availability()).toBe('unavailable:windows-no-containment')
    const consent = await f.service.consentFor(PROPOSAL)
    expect(consent.ok).toBe(false)
    expect(await f.service.accept(PROPOSAL, 'run-1')).toMatchObject({
      ok: false,
    })
    expect(f.accepts).toEqual([])
  })

  test('a folder that is not a repository is refused, and nothing is written', async () => {
    // The card should never have offered an Accept for it -- the proposal is
    // keyed to a GitHub remote -- but the command is reachable without a card.
    const f = fakes(
      {},
      { '--is-inside-work-tree': { exitCode: 128, stdout: '' } },
    )
    const consent = await f.service.consentFor(PROPOSAL)
    expect(consent).toMatchObject({ ok: false })
    expect(f.accepts).toEqual([])
  })
})

describe('consent', () => {
  test('names the branch that will actually be cut', async () => {
    // A screen saying "a branch will be created" without saying which one is
    // not describing the decision it is asking about. The run id it mints is
    // carried into the accept, so the two cannot diverge.
    const f = fakes()
    const consent = await f.service.consentFor(PROPOSAL)
    if (!consent.ok) throw new Error('refused')
    expect(consent.consent.branch).toContain('freebuff/')
    expect(consent.consent.branch).toContain(consent.runId)
    expect(consent.consent.folder).toBe(ROOT)
    expect(consent.consent.advertiserName).toBe('Acme Deploys')
    // NOTHING HAS HAPPENED YET. This is the property that makes a refusal free.
    expect(f.accepts).toEqual([])
    expect(f.reported).toEqual([])
    expect(f.turns).toEqual([])
  })

  test('the branch is built from the same title the worktree is', async () => {
    const f = fakes()
    const consent = await f.service.consentFor(PROPOSAL)
    if (!consent.ok) throw new Error('refused')
    await f.service.accept(PROPOSAL, consent.runId, reviewedTask())
    expect(f.turns[0]!.worktree.branch).toBe(consent.consent.branch)
    expect(sponsoredRunTitle('Acme Deploys')).toBe('Sponsored: Acme Deploys')
  })
})

describe('accept', () => {
  test('one accept per proposal, however many times it is asked', async () => {
    const f = fakes()
    const consent = await f.service.consentFor(PROPOSAL)
    if (!consent.ok) throw new Error('refused')
    const [first, second] = await Promise.all([
      f.service.accept(PROPOSAL, consent.runId, reviewedTask()),
      f.service.accept(PROPOSAL, consent.runId, reviewedTask()),
    ])
    expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1)
    expect(f.accepts).toEqual(['proposal-1'])
  })

  test('a request that never reached the server is retried exactly once', async () => {
    // Accept is idempotent within the token TTL, so a dropped connection is
    // worth one retry. A 409 is an ANSWER and retrying it turns one refusal
    // into two, which is why only status 0 gets another go.
    const attempts: number[] = []
    const f = fakes({
      accept: async () => {
        attempts.push(attempts.length)
        return attempts.length === 1
          ? { ok: false, status: 0, message: 'Could not reach Freebuff.' }
          : { ok: true, accept: ACCEPT }
      },
    })
    const { outcome } = await acceptThrough(f)
    expect(outcome.ok).toBe(true)
    expect(attempts).toHaveLength(2)
  })

  test('a refusal that IS an answer is not retried', async () => {
    const attempts: number[] = []
    const f = fakes({
      accept: async () => {
        attempts.push(attempts.length)
        return { ok: false, status: 409, message: 'no longer on offer' }
      },
    })
    const { outcome } = await acceptThrough(f)
    expect(outcome).toMatchObject({ ok: false, message: 'no longer on offer' })
    expect(attempts).toHaveLength(1)
    expect(f.reported).toEqual([])
  })

  test('missing task evidence after consent refuses before funded acceptance', async () => {
    const f = fakes()
    const consent = await f.service.consentFor(PROPOSAL, reviewedTask())
    if (!consent.ok) throw new Error('refused')

    const outcome = await f.service.accept(PROPOSAL, consent.runId, null)

    expect(outcome).toEqual({
      ok: false,
      message:
        'The task context changed after review. Review the sponsored task again.',
    })
    expect(f.accepts).toEqual([])
    expect(f.turns).toEqual([])
  })

  test('a row accepted upstream that cannot start locally is reported failed', async () => {
    // The strand this closes: the card sits on `accepted` with nothing behind
    // it, forever, and no sweep finds it because there is no run to find.
    const f = fakes({}, { 'worktree add': { exitCode: 128, stdout: '' } })
    const { outcome } = await acceptThrough(f)
    expect(outcome.ok).toBe(false)
    expect(f.reported).toHaveLength(1)
    expect(f.reported[0]!.state).toBe('failed')
  })

  test('running is reported when the turn starts, never at the accept', async () => {
    // Between the accept and the first token sits worktree creation, and a card
    // that said "running" through a failed create is a card that lied.
    const order: string[] = []
    const f = fakes({
      reportState: async (_id, _token, update) => {
        order.push(`report:${(update as Reported).state}`)
        return { ok: true, status: 200 }
      },
      runTurn: async () => {
        order.push('turn')
        return null
      },
    })
    await acceptThrough(f)
    await settle()
    expect(order[0]).toBe('report:running')
    expect(order[1]).toBe('turn')
  })
})

describe('the verdict is decided by git, not by the run', () => {
  test('a moved branch tip is committed', async () => {
    const f = fakes()
    f.moveHead('base-sha')
    const before = f.service
    void before
    const consent = await f.service.consentFor(PROPOSAL)
    if (!consent.ok) throw new Error('refused')
    // The worktree is created at `base-sha`; the turn moves the tip.
    const original = f.deps.runTurn
    f.deps.runTurn = async (context) => {
      f.moveHead('new-sha')
      return original(context)
    }
    await f.service.accept(PROPOSAL, consent.runId, reviewedTask())
    await settle()
    expect(f.reported.map((r) => r.state)).toEqual(['running', 'committed'])
  })

  test('a turn that finished without committing is failed, and says so differently', async () => {
    // "the task failed" and "the task did nothing" reach the card as different
    // sentences, because they are entirely different things to have happened.
    const f = fakes()
    await acceptThrough(f)
    await settle()
    expect(f.reported.map((r) => r.state)).toEqual(['running', 'failed'])
    expect(f.reported[1]!.failureReason).toContain('without committing')
  })

  test('a run that announced a commit it did not make is still failed', async () => {
    // The run's own account of itself is not evidence. Nothing here reads a
    // tool call; the only question asked is whether the tip moved.
    const f = fakes({ runTurn: async () => null })
    await acceptThrough(f)
    await settle()
    expect(f.reported[1]!.state).toBe('failed')
  })

  test('an offline terminal verdict survives restart and keeps its report id', async () => {
    let terminalAttempts = 0
    const f = fakes({
      reportState: async (_id, _token, update) => {
        f.reported.push(update as Reported)
        if (update.state === 'running') return { ok: true, status: 200 }
        terminalAttempts += 1
        return terminalAttempts === 1
          ? { ok: false, status: 0, message: 'offline' }
          : { ok: true, status: 200 }
      },
    })
    const original = f.deps.runTurn
    f.deps.runTurn = async (context) => {
      f.moveHead('moved-sha')
      return original(context)
    }
    await acceptThrough(f)
    await settle()

    const pending = JSON.parse(f.terminalReports()) as Array<{
      update: { reportId: string }
      nextDueAt: number
    }>
    expect(pending).toHaveLength(1)
    pending[0]!.nextDueAt = 0
    f.setTerminalReports(JSON.stringify(pending))

    new SponsoredRun(ROOT, f.deps)
    await settle()
    expect(terminalAttempts).toBe(2)
    expect(f.reported.at(-2)?.reportId).toBe(f.reported.at(-1)?.reportId)
    expect(JSON.parse(f.terminalReports())).toEqual([])
  })

  test('a terminal 409 is retained as a permanent refusal and never auto-retried', async () => {
    let terminalAttempts = 0
    const f = fakes({
      reportState: async (_id, _token, update) => {
        f.reported.push(update as Reported)
        if (update.state === 'running') return { ok: true, status: 200 }
        terminalAttempts += 1
        return { ok: false, status: 409, message: 'report_conflict' }
      },
    })
    await acceptThrough(f)
    await settle()
    expect(JSON.parse(f.terminalReports())[0]).toMatchObject({
      attempts: 1,
      lastError: 'report_conflict',
      disposition: 'permanent_refusal',
    })

    new SponsoredRun(ROOT, f.deps)
    await settle()
    expect(terminalAttempts).toBe(1)
    expect(JSON.parse(f.terminalReports())).toHaveLength(1)
  })

  test('a terminal 401 retries with refreshed credentials', async () => {
    let authToken = 'expired-session'
    const terminalTokens: string[] = []
    const f = fakes({
      getToken: () => authToken,
      reportState: async (_id, _token, update, token) => {
        f.reported.push(update as Reported)
        if (update.state === 'running') return { ok: true, status: 200 }
        terminalTokens.push(token)
        return token === 'expired-session'
          ? { ok: false, status: 401, message: 'session expired' }
          : { ok: true, status: 200 }
      },
    })
    const original = f.deps.runTurn
    f.deps.runTurn = async (context) => {
      f.moveHead('moved-sha')
      return original(context)
    }
    await acceptThrough(f)
    await settle()

    expect(JSON.parse(f.terminalReports())[0]).toMatchObject({
      attempts: 1,
      lastError: 'session expired',
      disposition: 'pending',
    })

    authToken = 'refreshed-session'
    const pending = JSON.parse(f.terminalReports())
    pending[0].nextDueAt = 0
    f.setTerminalReports(JSON.stringify(pending))
    new SponsoredRun(ROOT, f.deps)
    await settle()

    expect(terminalTokens).toEqual(['expired-session', 'refreshed-session'])
    expect(JSON.parse(f.terminalReports())).toEqual([])
  })

  test('a delayed flush cannot delete a concurrently enqueued report', async () => {
    let releaseFirst!: () => void
    let releaseBlocked!: () => void
    let firstStarted!: () => void
    const firstStartedPromise = new Promise<void>((resolve) => {
      firstStarted = resolve
    })
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const blockedGate = new Promise<void>((resolve) => {
      releaseBlocked = resolve
    })
    let oldAttempts = 0
    const deliveredProposalIds: string[] = []
    const f = fakes({
      runTurn: () => new Promise(() => {}),
      reportState: async (proposalId, _token, update) => {
        f.reported.push(update as Reported)
        if (update.state === 'running') return { ok: true, status: 200 }
        if (update.reportId === 'old-report') {
          oldAttempts += 1
          if (oldAttempts === 1) {
            firstStarted()
            await firstGate
          } else {
            await blockedGate
          }
        } else {
          await blockedGate
        }
        deliveredProposalIds.push(proposalId)
        return { ok: true, status: 200 }
      },
    })
    await settle()
    f.setTerminalReports(
      JSON.stringify([
        {
          proposalId: 'old-proposal',
          runToken: 'old-token',
          update: {
            state: 'failed',
            reportId: 'old-report',
            runId: 'old-run',
            failureReason: 'old failure',
          },
          attempts: 0,
          nextDueAt: 0,
          lastError: null,
          disposition: 'pending',
        },
      ]),
    )

    const service = new SponsoredRun(ROOT, f.deps)
    await firstStartedPromise
    const consent = await service.consentFor(PROPOSAL)
    if (!consent.ok) throw new Error('refused')
    await service.accept(PROPOSAL, consent.runId, reviewedTask())
    const interrupted = service.interrupt('ctrl-c')

    // Persist-before-HTTP: the second intent survives a crash even while the
    // first request is still unresolved.
    expect(JSON.parse(f.terminalReports())).toMatchObject([
      { proposalId: 'old-proposal', update: { reportId: 'old-report' } },
      { proposalId: 'proposal-1', disposition: 'pending' },
    ])

    releaseFirst()
    await settle()
    expect(JSON.parse(f.terminalReports())).toMatchObject([
      { proposalId: 'proposal-1', disposition: 'pending' },
    ])

    releaseBlocked()
    await interrupted
    await settle()
    expect(oldAttempts).toBe(1)
    expect(deliveredProposalIds).toEqual(['old-proposal', 'proposal-1'])
    expect(JSON.parse(f.terminalReports())).toEqual([])
  })

  test('a refused report does not block a later pending report', async () => {
    let terminalAttempts = 0
    const f = fakes({
      reportState: async (_id, _token, update) => {
        f.reported.push(update as Reported)
        if (update.state === 'running') return { ok: true, status: 200 }
        terminalAttempts += 1
        return terminalAttempts === 1
          ? { ok: false, status: 409, message: 'report_conflict' }
          : { ok: true, status: 200 }
      },
    })
    await acceptThrough(f)
    await settle()
    const reports = JSON.parse(f.terminalReports())
    reports.push({
      ...reports[0],
      update: { ...reports[0].update, reportId: 'later-report' },
      attempts: 0,
      nextDueAt: 0,
      lastError: null,
      disposition: 'pending',
    })
    f.setTerminalReports(JSON.stringify(reports))

    new SponsoredRun(ROOT, f.deps)
    await settle()
    expect(terminalAttempts).toBe(2)
    expect(JSON.parse(f.terminalReports())).toMatchObject([
      { disposition: 'permanent_refusal' },
    ])
  })

  test('a transient report exhausts after eight attempts and remains recoverable', async () => {
    let terminalAttempts = 0
    const f = fakes({
      reportState: async (_id, _token, update) => {
        f.reported.push(update as Reported)
        if (update.state === 'running') return { ok: true, status: 200 }
        terminalAttempts += 1
        return { ok: false, status: 0, message: 'offline' }
      },
    })
    await acceptThrough(f)
    await settle()
    for (let retry = 1; retry < 8; retry += 1) {
      const pending = JSON.parse(f.terminalReports())
      pending[0].nextDueAt = 0
      f.setTerminalReports(JSON.stringify(pending))
      new SponsoredRun(ROOT, f.deps)
      await settle()
    }
    expect(terminalAttempts).toBe(8)
    expect(JSON.parse(f.terminalReports())[0]).toMatchObject({
      attempts: 8,
      lastError: 'offline',
      disposition: 'exhausted',
    })

    new SponsoredRun(ROOT, f.deps)
    await settle()
    expect(terminalAttempts).toBe(8)
    expect(JSON.parse(f.terminalReports())).toHaveLength(1)
  })
})

test('the default terminal outbox uses private user state and exclusive temp creation', () => {
  const source = readFileSync(
    join(import.meta.dir, '..', 'sponsored-run.ts'),
    'utf8',
  )
  const store = source.slice(
    source.indexOf('function terminalReportStore'),
    source.indexOf('export const defaultSponsoredRunDeps'),
  )
  expect(store).toContain(
    "path.join(getConfigDir(), 'sponsored-terminal-reports')",
  )
  expect(store).toContain("createHash('sha256').update(canonicalRoot)")
  expect(store).toContain("flag: 'wx'")
  expect(store).toContain('mode: 0o600')
  expect(store).not.toContain("path.join(projectRoot, '.freebuff')")
})

describe('interrupting', () => {
  test('leaves a TERMINAL state and a notice naming what is on disk', async () => {
    // COD-339 acceptance 6, and the one question with no web equivalent.
    const f = fakes({ runTurn: () => new Promise(() => {}) })
    const { consent } = await acceptThrough(f)
    if (!consent.ok) throw new Error('refused')
    const outcome = await f.service.interrupt('ctrl-c')
    expect(outcome.interrupted).toBe(true)
    expect(f.reported.map((r) => r.state)).toEqual(['running', 'failed'])
    expect(outcome.notice).toContain(consent.consent.branch)
    expect(outcome.notice).toContain('/ads:remove-worktree')
    // The workspace is KEPT. It is the user's checkout on the user's disk.
    expect(outcome.notice).toContain('still on disk')
  })

  test('the turn unwinding afterwards does not report a second ending', async () => {
    // Upstream would refuse the second transition 409 anyway, but only after
    // the card had flickered through a state it was never in.
    let finish: (() => void) | undefined
    const f = fakes({
      runTurn: () =>
        new Promise<null>((resolve) => {
          finish = () => resolve(null)
        }),
    })
    await acceptThrough(f)
    await f.service.interrupt('ctrl-c')
    finish?.()
    await settle()
    expect(f.reported.map((r) => r.state)).toEqual(['running', 'failed'])
  })

  test('interrupting nothing is a no-op with no notice', async () => {
    const f = fakes()
    expect(await f.service.interrupt('signal')).toEqual({
      interrupted: false,
      notice: null,
    })
    expect(f.reported).toEqual([])
  })
})

describe('delivery', () => {
  test('nothing is pushed until the branch tip has actually moved', async () => {
    const f = fakes()
    await acceptThrough(f)
    await settle()
    const outcome = await f.service.createPullRequest()
    expect(outcome).toMatchObject({ ok: false })
    expect(f.delivered).toEqual([])
  })

  test('a moved gitdir pointer refuses the push', async () => {
    // `<worktree>/.git` is a FILE the sandbox lets the run write, so it can
    // point at a repository of its own with its own remote -- and the push
    // would go there, with the user's real credentials.
    const commonDirs = ['/repo/.git\n', '/elsewhere/.git\n']
    let asked = 0
    let heads = 0
    const f = fakes({}, {})
    f.deps.git = async (args) => {
      const key = args.join(' ')
      if (key.includes('--is-inside-work-tree')) {
        return { exitCode: 0, stdout: 'true\n', stderr: '' }
      }
      if (key.includes('symbolic-ref')) {
        return { exitCode: 0, stdout: 'main\n', stderr: '' }
      }
      if (key.includes('--git-dir')) {
        return { exitCode: 0, stdout: '/repo/.git/worktrees/w\n', stderr: '' }
      }
      if (key.includes('--git-common-dir')) {
        // The worktree creation asks once; the delivery check asks twice and
        // must get two DIFFERENT answers to see the move.
        return {
          exitCode: 0,
          stdout: commonDirs[Math.min(asked++, 1)]!,
          stderr: '',
        }
      }
      if (key.includes('rev-parse HEAD')) {
        // The first ask is the worktree's base; every later one is the tip
        // after the turn, so the run reads as committed and the delivery gets
        // as far as the gitdir check this test is about.
        return {
          exitCode: 0,
          // Consent reads HEAD twice; both must agree. Worktree creation then
          // captures the same base before the simulated turn moves it.
          stdout: heads++ < 5 ? 'base-sha\n' : 'moved-sha\n',
          stderr: '',
        }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    const service = new SponsoredRun(ROOT, f.deps)
    const consent = await service.consentFor(PROPOSAL)
    if (!consent.ok) throw new Error('refused')
    await service.accept(PROPOSAL, consent.runId, reviewedTask())
    await settle()
    asked = 0
    const outcome = await service.createPullRequest()
    expect(outcome).toMatchObject({ ok: false })
    expect((outcome as { message: string }).message).toContain(
      'no longer points at your repository',
    )
    expect(f.delivered).toEqual([])
  })

  test('the push and the PR are two explicit commands, with hooks disabled', async () => {
    const f = fakes()
    const consent = await f.service.consentFor(PROPOSAL)
    if (!consent.ok) throw new Error('refused')
    const original = f.deps.runTurn
    f.deps.runTurn = async (context) => {
      f.moveHead('moved-sha')
      return original(context)
    }
    await f.service.accept(PROPOSAL, consent.runId, reviewedTask())
    await settle()
    const outcome = await f.service.createPullRequest()
    expect(outcome).toMatchObject({
      ok: true,
      prUrl: 'https://github.com/x/y/pull/7',
    })
    // `gh pr create` pushes a missing branch on its own, INTERACTIVELY, which
    // in a TUI is a prompt nobody sees. So the push is explicit and first.
    expect(f.delivered[0]![0]).toBe('git')
    expect(f.delivered[0]).toContain('push')
    expect(f.delivered[1]![0]).toBe('gh')
    expect(f.reported.at(-1)).toMatchObject({ state: 'landed' })
  })

  test('a PR URL that fails the shared destination gate is a failure here, not a round trip', async () => {
    // The state route refuses a `landed` whose prUrl does not survive
    // sanitization, and the card refuses to render one -- so reporting it
    // would be a refusal we could do nothing with.
    const f = fakes({
      deliver: async (command) =>
        command === 'gh'
          ? { exitCode: 0, stdout: 'javascript:alert(1)\n', stderr: '' }
          : { exitCode: 0, stdout: '', stderr: '' },
    })
    const consent = await f.service.consentFor(PROPOSAL)
    if (!consent.ok) throw new Error('refused')
    const original = f.deps.runTurn
    f.deps.runTurn = async (context) => {
      f.moveHead('moved-sha')
      return original(context)
    }
    await f.service.accept(PROPOSAL, consent.runId, reviewedTask())
    await settle()
    expect(await f.service.createPullRequest()).toMatchObject({ ok: false })
    expect(f.reported.some((r) => r.state === 'landed')).toBe(false)
  })

  test('the delivery environment carries the user’s credentials and no hooks', () => {
    // The RUN's commands go through the sandbox broker. These do not -- this is
    // the user's own action -- so the one thing removed is a `pre-push` hook the
    // advertiser's run could have written.
    const env = noHooksEnv(ROOT)
    expect(env.GIT_CONFIG_KEY_0).toBe('core.hooksPath')
    expect(env.GIT_CONFIG_VALUE_0).toContain('.freebuff')
    expect(env.GIT_CONFIG_VALUE_0).not.toContain('/tmp')
  })
})

describe('the operator’s half of a failure', () => {
  test('carries only the first line, capped', () => {
    // An error's first line is a summary written to be read; everything after
    // it is a stack trace, a provider payload, or the file content a failing
    // read was holding. `diagnostic_reason` is stored server-side.
    expect(diagnosticCause('boom\nsecret-line')).toBe(': boom')
    expect(diagnosticCause('x'.repeat(400)).length).toBeLessThan(210)
    expect(diagnosticCause(null)).toBe('')
  })
})

/** Let the run's own `.then` chains drain. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 5))
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

void mock
void beforeEach
