/**
 * The in-flight record and the launch sweep (COD-665 R5): a sponsored run
 * whose process died before it wrote a terminal report is reported `failed`
 * by the next CLI, once, from the receipts it left -- and a run that is still
 * alive, or that already has its verdict in the outbox, is left alone.
 *
 * Injected, not mocked (docs/testing.md): an in-memory outbox and record
 * list, a pid table, and a real temporary folder for the receipts and the
 * file-backed store.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ensureCliTestEnv, getDefaultCliEnv } from '../../__tests__/test-utils'

ensureCliTestEnv()

const { SponsoredRun } = await import('../sponsored-run')
const {
  SPONSORED_ORPHANED_RUN_DIAGNOSTIC,
  orphanedSponsoredRunReport,
  parseSponsoredInflightRecord,
  sponsoredInflightKeys,
  sponsoredInflightStore,
  sponsoredPidIsAlive,
  sweepSponsoredInflightRuns,
} = await import('../sponsored-run-inflight')
const { SponsoredEditRecorder } = await import('../sponsored-receipts')
const { sponsoredRunFailureCode } =
  await import('@codebuff/common/ads/sponsored-run-funnel-metadata')
const { SPONSORED_PARTIAL_EDITS_COPY } =
  await import('@codebuff/common/ads/sponsored-in-place')

import type { SponsoredRunDeps } from '../sponsored-run'
import type { SponsoredInflightRecord } from '../sponsored-run-inflight'

const PARENT = mkdtempSync(join(tmpdir(), 'sponsored-cli-inflight-'))
afterAll(() => rmSync(PARENT, { recursive: true, force: true }))

const OWN_PID = 4242
const LIVE_PID = 5151
const DEAD_PID = 6161
const RUN_ID = '00000000-0000-4000-8000-00000000000a'
/** A minute before this suite started: well inside the run token's life. */
const STARTED_AT_MS = Date.now() - 60_000

let projectCounter = 0
function project(): string {
  projectCounter += 1
  const root = join(PARENT, `project-${projectCounter}`)
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'app.ts'), 'export const app = 1\n')
  return realpathSync(root)
}

function record(
  over: Partial<SponsoredInflightRecord> = {},
): SponsoredInflightRecord {
  return {
    version: 1,
    proposalId: 'proposal-1',
    runId: RUN_ID,
    runToken: 'token-1',
    pid: DEAD_PID,
    startedAtMs: STARTED_AT_MS,
    ...over,
  }
}

type Sent = {
  proposalId: string
  runToken: string
  update: {
    state: string
    failureReason?: string
    diagnosticReason?: string
    runId?: string
    reportId?: string
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 5))
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

/** A launch in a folder whose in-flight file holds `records`. */
function launch(
  records: SponsoredInflightRecord[],
  over: {
    token?: () => string | null
    outbox?: unknown[]
    receipts?: Map<string, string>
  } = {},
) {
  const root = project()
  let inflight = [...records]
  let outbox = JSON.stringify(over.outbox ?? [])
  const receipts = over.receipts ?? new Map<string, string>()
  const sent: Sent[] = []
  const deps: SponsoredRunDeps = {
    preview: async () => ({ ok: false, status: 500, message: 'unused' }),
    accept: async () => ({
      ok: false,
      status: 500,
      message: 'unused',
      code: null,
    }),
    reportState: async (proposalId, runToken, update) => {
      sent.push({ proposalId, runToken, update: update as Sent['update'] })
      return { ok: true, status: 200 }
    },
    getToken: over.token ?? (() => 'session-token'),
    platform: 'darwin',
    containment: () => ({ available: true, mechanism: 'sandbox-exec' }),
    executionSurface: () => 'cli_macos',
    now: Date.now,
    sleep: async () => {},
    terminalReports: {
      read: () => outbox,
      write: (value) => {
        outbox = value
      },
    },
    receipts: {
      read: (runId) => receipts.get(runId) ?? null,
      write: (runId, value) => void receipts.set(runId, value),
    },
    inflight: {
      list: () => [...inflight],
      put: (next) => {
        inflight = [...inflight.filter((r) => r.runId !== next.runId), next]
      },
      remove: (runId) => {
        inflight = inflight.filter((r) => r.runId !== runId)
      },
      pid: OWN_PID,
      isAlive: (pid) => pid === OWN_PID || pid === LIVE_PID,
    },
    lastRun: { read: () => null, write: () => {} },
    target: async () => ({ kind: 'repo', repoFullName: 'acme/app' }),
  }
  // The constructor's flush is the launch sweep.
  const run = new SponsoredRun(root, deps)
  return {
    root,
    run,
    sent,
    receipts,
    inflight: () => inflight,
    outbox: () => JSON.parse(outbox) as unknown[],
  }
}

describe('the launch sweep', () => {
  test('a dead run with no verdict is reported failed, ONCE', async () => {
    const f = launch([record()])
    await settle()
    expect(f.sent).toHaveLength(1)
    const [report] = f.sent
    expect(report!.proposalId).toBe('proposal-1')
    expect(report!.runToken).toBe('token-1')
    expect(report!.update).toMatchObject({
      state: 'failed',
      runId: RUN_ID,
      diagnosticReason: SPONSORED_ORPHANED_RUN_DIAGNOSTIC,
    })
    expect(report!.update.reportId).toMatch(/^[0-9a-f-]{36}$/)
    expect(sponsoredRunFailureCode(report!.update)).toBe('app_quit')
    expect(f.inflight()).toEqual([])
    expect(f.outbox()).toEqual([])
    // A later mount sweeps again, and finds nothing left to say.
    f.run.flushPendingReports()
    await settle()
    expect(f.sent).toHaveLength(1)
  })

  test('a dead run that left edits is reported as partial edits', async () => {
    const receipts = new Map<string, string>()
    const root = project()
    const recorder = new SponsoredEditRecorder(
      {
        runId: RUN_ID,
        proposalId: 'proposal-1',
        advertiserName: 'Acme Deploys',
        projectRoot: root,
      },
      {
        read: (runId) => receipts.get(runId) ?? null,
        write: (runId, value) => void receipts.set(runId, value),
      },
    )
    await recorder.around('src/app.ts', async () => {
      writeFileSync(join(root, 'src', 'app.ts'), 'half-written\n')
    })
    const f = launch([record()], { receipts })
    await settle()
    expect(f.sent).toHaveLength(1)
    const update = f.sent[0]!.update
    expect(update.state).toBe('failed')
    expect(sponsoredRunFailureCode(update)).toBe('partial_edits')
    expect(update.diagnosticReason).toContain('partial changes (1 file)')
    expect(update.failureReason).toBe(
      `${SPONSORED_PARTIAL_EDITS_COPY.interrupted} Run /ads:undo to revert them.`,
    )
  })

  test('a run whose process is still alive is left alone', async () => {
    const f = launch([record({ pid: LIVE_PID })])
    await settle()
    expect(f.sent).toEqual([])
    expect(f.inflight()).toHaveLength(1)
  })

  test('a record with this process’s own pid is left alone', async () => {
    const f = launch([record({ pid: OWN_PID })])
    await settle()
    expect(f.sent).toEqual([])
    expect(f.inflight()).toHaveLength(1)
  })

  test('signed out: the record is KEPT, and reported once there is a session', async () => {
    let token: string | null = null
    const f = launch([record()], { token: () => token })
    await settle()
    expect(f.sent).toEqual([])
    expect(f.inflight()).toHaveLength(1)
    token = 'session-token'
    f.run.flushPendingReports()
    await settle()
    expect(f.sent.map((s) => s.update.state)).toEqual(['failed'])
    expect(f.inflight()).toEqual([])
  })

  test('a run whose verdict is already in the outbox is not reported twice', async () => {
    const f = launch([record()], {
      outbox: [
        {
          proposalId: 'proposal-1',
          runToken: 'token-1',
          update: {
            state: 'delivered',
            reportId: 'earlier',
            runId: RUN_ID,
          },
          attempts: 2,
          nextDueAt: 0,
          lastError: 'offline',
          disposition: 'pending',
        },
      ],
    })
    await settle()
    // The outbox's own report is the verdict; the sweep adds nothing.
    expect(f.sent.map((s) => s.update.reportId)).toEqual(['earlier'])
    expect(f.inflight()).toEqual([])
  })

  test('a record older than the run token is dropped unreported', async () => {
    const f = launch([record({ startedAtMs: Date.now() - 25 * 3_600_000 })])
    await settle()
    expect(f.sent).toEqual([])
    expect(f.inflight()).toEqual([])
  })
})

describe('sweepSponsoredInflightRuns', () => {
  test('enqueues before it removes the record', () => {
    const events: string[] = []
    const reported = sweepSponsoredInflightRuns({
      inflight: {
        list: () => [record()],
        put: () => {},
        remove: () => void events.push('remove'),
        pid: OWN_PID,
        isAlive: () => false,
      },
      receipts: { read: () => null, write: () => {} },
      hasOutboxReport: () => false,
      tokenAvailable: true,
      now: Date.now(),
      enqueue: () => void events.push('enqueue'),
    })
    expect(reported).toEqual([RUN_ID])
    expect(events).toEqual(['enqueue', 'remove'])
  })

  test('an unreadable ledger is a run with no edits', () => {
    expect(
      orphanedSponsoredRunReport(RUN_ID, {
        read: () => '{not json',
        write: () => {},
      }).diagnosticReason,
    ).toBe(SPONSORED_ORPHANED_RUN_DIAGNOSTIC)
  })
})

describe('sponsoredPidIsAlive', () => {
  const failing = (code: string) => () => {
    throw Object.assign(new Error(code), { code })
  }
  test('ESRCH is dead; EPERM is a process we may not signal, so alive', () => {
    expect(sponsoredPidIsAlive(123, failing('ESRCH'))).toBe(false)
    expect(sponsoredPidIsAlive(123, failing('EPERM'))).toBe(true)
    expect(sponsoredPidIsAlive(123, () => true)).toBe(true)
  })
  test('this process is alive, and a nonsense pid is not', () => {
    expect(sponsoredPidIsAlive(process.pid)).toBe(true)
    expect(sponsoredPidIsAlive(0)).toBe(false)
    expect(sponsoredPidIsAlive(-1)).toBe(false)
  })
})

describe('the file-backed store', () => {
  test('keeps ONE FILE PER RUN, privately, under the folder’s key', () => {
    const base = join(PARENT, 'inflight-store')
    const root = project()
    const store = sponsoredInflightStore(root, base)
    expect(store.list()).toEqual([])
    store.put(record())
    store.put(record({ runId: 'other-run', pid: LIVE_PID, startedAtMs: 1 }))
    // A second put for the same run replaces it rather than adding one.
    store.put(record({ pid: 7777 }))
    expect(store.list()).toEqual([
      record({ runId: 'other-run', pid: LIVE_PID, startedAtMs: 1 }),
      record({ pid: 7777 }),
    ])
    const [key] = readdirSync(base)
    expect(key).toMatch(/^[0-9a-f]{64}$/)
    expect(sponsoredInflightKeys(base)).toEqual([key!])
    const files = readdirSync(join(base, key!)).sort()
    // The UUID run id names its file; anything else is hashed, never trusted.
    expect(files).toHaveLength(2)
    expect(files).toContain(`${RUN_ID}.json`)
    expect(files.find((name) => name !== `${RUN_ID}.json`)).toMatch(
      /^[0-9a-f]{64}\.json$/,
    )
    const target = join(base, key!, `${RUN_ID}.json`)
    expect(statSync(target).mode & 0o777).toBe(0o600)
    expect(statSync(join(base, key!)).mode & 0o777).toBe(0o700)
    // No file names anything about the folder.
    expect(readFileSync(target, 'utf8')).not.toContain(root)
    store.remove('other-run')
    store.remove(RUN_ID)
    store.remove('never-there')
    expect(store.list()).toEqual([])
    expect(existsSync(target)).toBe(false)
  })

  test('two CLIs in the same folder put and remove without erasing each other', () => {
    // The old shape was one LIST per folder, rewritten by every put and
    // remove: two processes interleaving those writes each wrote back a list
    // without the other's record, and that run's crash went unreported.
    const base = join(PARENT, 'inflight-two-stores')
    const root = project()
    const first = sponsoredInflightStore(root, base)
    const second = sponsoredInflightStore(root, base)
    const a = record({ runId: '00000000-0000-4000-8000-0000000000a1' })
    const b = record({ runId: '00000000-0000-4000-8000-0000000000b2' })
    // Each read the folder before the other wrote -- the interleaving that
    // lost a record -- and neither write touches the other's file.
    expect(first.list()).toEqual([])
    expect(second.list()).toEqual([])
    first.put(a)
    second.put(b)
    expect(first.list()).toEqual([a, b])
    expect(second.list()).toEqual([a, b])
    first.remove(a.runId)
    expect(second.list()).toEqual([b])
    second.put({ ...b, pid: 9999 })
    first.remove('00000000-0000-4000-8000-0000000000ff')
    expect(first.list()).toEqual([{ ...b, pid: 9999 }])
    second.remove(b.runId)
    expect(first.list()).toEqual([])
  })

  test('two PROCESSES writing one folder at once lose nothing', async () => {
    // The same, for real: two processes interleaving puts and removes on one
    // folder. Every record each one kept must still be there.
    const base = join(PARENT, 'inflight-two-processes')
    const root = project()
    const script = join(PARENT, 'inflight-writer.ts')
    writeFileSync(
      script,
      `const { sponsoredInflightStore } = await import(${JSON.stringify(
        join(import.meta.dir, '..', 'sponsored-run-inflight.ts'),
      )})
const [root, base, prefix] = process.argv.slice(2)
const store = sponsoredInflightStore(root, base)
for (let i = 0; i < 100; i++) {
  store.put({ version: 1, proposalId: 'p', runId: prefix + '-' + i, runToken: 't', pid: process.pid, startedAtMs: i })
  if (i % 2 === 1) store.remove(prefix + '-' + (i - 1))
}
`,
    )
    const writers = ['left', 'right'].map((prefix) =>
      Bun.spawn([process.execPath, script, root, base, prefix], {
        env: { ...process.env, ...getDefaultCliEnv() },
        stdout: 'ignore',
        stderr: 'pipe',
      }),
    )
    const codes = await Promise.all(writers.map((writer) => writer.exited))
    expect(codes).toEqual([0, 0])
    const kept = sponsoredInflightStore(root, base)
      .list()
      .map((r) => r.runId)
      .sort()
    const expected = ['left', 'right']
      .flatMap((prefix) =>
        Array.from({ length: 50 }, (_, i) => `${prefix}-${i * 2 + 1}`),
      )
      .sort()
    expect(kept).toEqual(expected)
  })

  test('another folder’s records are its own', () => {
    const base = join(PARENT, 'inflight-two-folders')
    const here = sponsoredInflightStore(project(), base)
    const there = sponsoredInflightStore(project(), base)
    here.put(record())
    expect(there.list()).toEqual([])
    expect(sponsoredInflightKeys(base)).toHaveLength(1)
  })

  test('an unreadable or foreign record is dropped, never thrown', () => {
    expect(parseSponsoredInflightRecord(null)).toBeNull()
    expect(parseSponsoredInflightRecord('{not json')).toBeNull()
    expect(parseSponsoredInflightRecord('{"runId":"x"}')).toBeNull()
    expect(
      parseSponsoredInflightRecord(JSON.stringify({ ...record(), version: 2 })),
    ).toBeNull()
    expect(parseSponsoredInflightRecord(JSON.stringify(record()))).toEqual(
      record(),
    )
    // In the directory: junk and someone's in-flight temporary are skipped.
    const base = join(PARENT, 'inflight-junk')
    const store = sponsoredInflightStore(project(), base)
    store.put(record())
    const [key] = readdirSync(base)
    writeFileSync(join(base, key!, 'junk.json'), '{not json')
    writeFileSync(join(base, key!, `.${RUN_ID}.tmp`), JSON.stringify(record()))
    expect(store.list()).toEqual([record()])
    expect(sponsoredInflightKeys(join(PARENT, 'no-such-base'))).toEqual([])
  })
})
