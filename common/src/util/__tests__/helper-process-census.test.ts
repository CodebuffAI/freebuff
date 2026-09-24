import { EventEmitter } from 'events'

import { describe, expect, test } from 'bun:test'

import {
  HelperProcessCensus,
  parseTasklistCsv,
  startMachineProcessCensus,
  summarizeMachineProcesses,
  type HelperProcessFloodReport,
} from '../helper-process-census'

function censusWithClock(options: { cooldownMs?: number } = {}) {
  let now = 0
  const reports: HelperProcessFloodReport[] = []
  const census = new HelperProcessCensus({
    report: (report) => reports.push(report),
    cooldownMs: options.cooldownMs ?? 1_000,
    now: () => now,
  })
  return {
    census,
    reports,
    advance: (ms: number) => {
      now += ms
    },
  }
}

describe('HelperProcessCensus (owned)', () => {
  test('reports once when a kind crosses its threshold, then rate-limits', () => {
    const { census, reports, advance } = censusWithClock()
    const releases = Array.from({ length: 3 }, () =>
      census.acquire('terminal_watchdog'),
    )
    expect(reports).toEqual([])
    releases.push(census.acquire('terminal_watchdog'))
    expect(reports).toEqual([
      { kind: 'terminal_watchdog', scope: 'owned', live: 4, threshold: 3 },
    ])
    releases.push(census.acquire('terminal_watchdog'))
    expect(reports).toHaveLength(1)
    advance(1_000)
    releases.push(census.acquire('terminal_watchdog'))
    expect(reports).toHaveLength(2)
    expect(reports[1]!.live).toBe(6)
  })

  test('release is idempotent and never drives a count negative', () => {
    const { census } = censusWithClock()
    const release = census.acquire('clipboard')
    release()
    release()
    expect(census.count('clipboard')).toBe(0)
    expect(census.snapshot()).toEqual({})
  })

  test('tracks a ChildProcess-like handle until exit or error', () => {
    const { census } = censusWithClock()
    const exits = new EventEmitter()
    const fails = new EventEmitter()
    census.track('terminal_command', exits as never)
    census.track('terminal_command', fails as never)
    expect(census.count('terminal_command')).toBe(2)
    exits.emit('exit', 0)
    fails.emit('error', new Error('spawn ENOENT'))
    // A process that errors and then exits is released exactly once.
    fails.emit('exit', 1)
    expect(census.count('terminal_command')).toBe(0)
  })

  test('tracks a Bun Subprocess-like handle until `exited` settles', async () => {
    const { census } = censusWithClock()
    let resolve!: () => void
    census.track('shell', { exited: new Promise<void>((r) => (resolve = r)) })
    expect(census.count('shell')).toBe(1)
    resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(census.count('shell')).toBe(0)
  })

  test('a gauge reading reports like a tracked count, on the same cooldown', () => {
    const { census, reports } = censusWithClock()
    expect(census.observeOwned('shell', 16)).toBe(false)
    expect(census.observeOwned('shell', 17)).toBe(true)
    expect(census.observeOwned('shell', 30)).toBe(false)
    for (let i = 0; i < 17; i++) census.acquire('shell')
    expect(reports).toEqual([
      { kind: 'shell', scope: 'owned', live: 17, threshold: 16 },
    ])
  })

  test('a report callback that throws cannot break process handling', () => {
    const census = new HelperProcessCensus({
      report: () => {
        throw new Error('analytics down')
      },
      ownedThresholds: { clipboard: 0 },
    })
    expect(() => census.acquire('clipboard')).not.toThrow()
  })
})

// Real `tasklist /FO CSV /NH` shapes: English thousands separators, a German
// locale's dots, a French locale's narrow no-break spaces and "Ko".
const TASKLIST = [
  '"System Idle Process","0","Services","0","8 K"',
  '"powershell.exe","4120","Console","1","912,344 K"',
  '"powershell.exe","5532","Console","1","85.432 K"',
  '"pwsh.exe","6100","Console","1","70 000 Ko"',
  '"conhost.exe","4124","Console","1","1,712 K"',
  '"conhost.exe","5536","Console","1","1,700 K"',
  '"bash.exe","7000","Console","1","9,000 K"',
  '"freebuff.exe","8000","Console","1","300,000 K"',
  '"Image Name","PID","Session Name","Session#","Mem Usage"',
  '',
].join('\r\n')

describe('machine census', () => {
  test('parses localized tasklist output and ignores a stray header', () => {
    const rows = parseTasklistCsv(TASKLIST)
    expect(rows).toHaveLength(8)
    expect(rows[1]).toEqual({ image: 'powershell.exe', memoryKb: 912_344 })
    expect(rows[2]).toEqual({ image: 'powershell.exe', memoryKb: 85_432 })
    expect(rows[3]).toEqual({ image: 'pwsh.exe', memoryKb: 70_000 })
  })

  test('summarizes only allowlisted images, pwsh counted as powershell', () => {
    const summary = summarizeMachineProcesses(parseTasklistCsv(TASKLIST))
    expect(summary.total).toBe(8)
    expect(summary.kinds.powershell).toEqual({
      count: 3,
      totalMemoryMb: Math.round((912_344 + 85_432 + 70_000) / 1024),
      maxMemoryMb: Math.round(912_344 / 1024),
    })
    expect(summary.kinds.conhost?.count).toBe(2)
    expect(summary.kinds.bash?.count).toBe(1)
    expect(Object.keys(summary.kinds).sort()).toEqual([
      'bash',
      'conhost',
      'powershell',
    ])
  })

  test('reports a machine kind above its threshold with memory, rate-limited', () => {
    const { census, reports, advance } = censusWithClock()
    const summary = summarizeMachineProcesses(parseTasklistCsv(TASKLIST))
    const thresholds = { powershell: 2, conhost: 60, bash: 40, cmd: 40 }
    census.observeMachine(summary, thresholds)
    census.observeMachine(summary, thresholds)
    expect(reports).toEqual([
      {
        kind: 'powershell',
        scope: 'machine',
        live: 3,
        threshold: 2,
        totalMemoryMb: Math.round((912_344 + 85_432 + 70_000) / 1024),
        maxMemoryMb: Math.round(912_344 / 1024),
        machineProcesses: 8,
      },
    ])
    advance(1_000)
    census.observeMachine(summary, thresholds)
    expect(reports).toHaveLength(2)
  })

  test('a machine report does not consume the owned cooldown for the same word', () => {
    const { census, reports } = censusWithClock()
    census.observeMachine({
      total: 1,
      kinds: { bash: { count: 50, totalMemoryMb: 1, maxMemoryMb: 1 } },
    })
    for (let i = 0; i < 17; i++) census.acquire('shell')
    expect(reports.map((r) => `${r.scope}:${r.kind}`)).toEqual([
      'machine:bash',
      'owned:shell',
    ])
  })

  test('never overlaps listings and reschedules only after one settles', async () => {
    const { census } = censusWithClock()
    const timers: Array<() => void> = []
    let listings = 0
    let finish!: (stdout: string) => void
    const poller = startMachineProcessCensus({
      census,
      listProcesses: () => {
        listings++
        return new Promise<string>((resolve) => (finish = resolve))
      },
      setTimeoutFn: (fn) => {
        timers.push(fn)
        return timers.length
      },
      clearTimeoutFn: () => {},
    })
    expect(timers).toHaveLength(1)
    timers.shift()!()
    // A second trigger while the first listing hangs joins it instead.
    const joined = poller.runOnce()
    expect(listings).toBe(1)
    expect(timers).toHaveLength(0)
    finish(TASKLIST)
    await joined
    await Promise.resolve()
    await Promise.resolve()
    expect(timers).toHaveLength(1)
    poller.stop()
  })

  test('a failing listing reports nothing and keeps polling', async () => {
    const { census, reports } = censusWithClock()
    const timers: Array<() => void> = []
    const poller = startMachineProcessCensus({
      census,
      listProcesses: () => Promise.reject(new Error('tasklist missing')),
      setTimeoutFn: (fn) => {
        timers.push(fn)
        return timers.length
      },
      clearTimeoutFn: () => {},
    })
    expect(await poller.runOnce()).toEqual([])
    expect(reports).toEqual([])
    poller.stop()
  })
})
