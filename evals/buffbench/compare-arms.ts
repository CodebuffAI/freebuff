import fs from 'fs'
import path from 'path'

/**
 * Paired read-out of one buffbench logs directory: per task, each arm's
 * overall / completion / quality score, the agent's own wall clock, the whole
 * task's wall clock, cost, and any error — then the means and the paired
 * win/tie/loss count.
 *
 * Reads the per-task `<n>-<task>-<agent>-<sha>.json` files rather than
 * FINAL_RESULTS.json, so it also works on a run that is still in progress or
 * that died before writing the summary.
 *
 *   bun run buffbench/compare-arms.ts <logsDir> [agentA] [agentB]
 */

interface TaskRow {
  task: string
  agentId: string
  overall: number | null
  completion: number | null
  quality: number | null
  agentSeconds: number | null
  taskSeconds: number
  cost: number
  error?: string
  file: string
  shape: TraceShape
}

/** What the agent DID, counted off its event trace: the numbers a harness
 *  change is meant to move, next to the score it is meant not to hurt. */
interface TraceShape {
  /** Tool calls made by the root agent itself (its own serial steps). */
  rootToolCalls: number
  /** spawn_agents calls by the root. */
  spawnRounds: number
  /** Worker subagents spawned (agent type containing "worker"). */
  workers: number
  /** run_terminal_command calls by the root. */
  rootCommands: number
  /** run_terminal_command calls by workers. */
  workerCommands: number
  /** read_url + web_search calls by the root. */
  webReads: number
  /** Error events in the trace. */
  errors: number
}

function traceShape(trace: any[]): TraceShape {
  const shape: TraceShape = {
    rootToolCalls: 0,
    spawnRounds: 0,
    workers: 0,
    rootCommands: 0,
    workerCommands: 0,
    webReads: 0,
    errors: 0,
  }
  const workerIds = new Set<string>()
  for (const e of trace) {
    if (
      e?.type === 'subagent_start' &&
      String(e.agentType).includes('worker')
    ) {
      shape.workers++
      workerIds.add(e.agentId)
    }
  }
  for (const e of trace) {
    if (e?.type === 'error') shape.errors++
    if (e?.type !== 'tool_call') continue
    const isRoot = !('parentAgentId' in e)
    if (isRoot) {
      shape.rootToolCalls++
      if (e.toolName === 'spawn_agents') shape.spawnRounds++
      if (e.toolName === 'run_terminal_command') shape.rootCommands++
      if (e.toolName === 'read_url' || e.toolName === 'web_search')
        shape.webReads++
    } else if (
      workerIds.has(e.agentId) &&
      e.toolName === 'run_terminal_command'
    ) {
      shape.workerCommands++
    }
  }
  return shape
}

function readRows(logsDir: string): TaskRow[] {
  const rows: TaskRow[] = []
  for (const file of fs.readdirSync(logsDir)) {
    if (!file.endsWith('.json') || file.includes('-ANALYSIS-')) continue
    if (file === 'FINAL_RESULTS.json') continue
    let data: any
    try {
      data = JSON.parse(fs.readFileSync(path.join(logsDir, file), 'utf-8'))
    } catch {
      continue
    }
    if (!data?.agentId || !data?.commitSha) continue
    const match = file.match(
      /^\d+-(.+?)-(base[^-]*(?:-[^-]+)*?)-[0-9a-f]{7}\.json$/,
    )
    const task =
      match?.[1] ?? file.replace(/^\d+-/, '').replace(/-[0-9a-f]{7}\.json$/, '')
    const judging = data.judgeResult ?? data.judging ?? {}
    rows.push({
      task: task.replace(`-${data.agentId}`, ''),
      agentId: data.agentId,
      overall:
        typeof judging.overallScore === 'number' ? judging.overallScore : null,
      completion:
        typeof judging.completionScore === 'number'
          ? judging.completionScore
          : null,
      quality:
        typeof judging.codeQualityScore === 'number'
          ? judging.codeQualityScore
          : null,
      agentSeconds:
        typeof data.agentDurationMs === 'number'
          ? data.agentDurationMs / 1000
          : null,
      taskSeconds: (data.durationMs ?? 0) / 1000,
      cost: data.cost ?? 0,
      error: data.error ? String(data.error).split('\n')[0] : undefined,
      file,
      shape: traceShape(Array.isArray(data.trace) ? data.trace : []),
    })
  }
  return rows
}

function mean(values: Array<number | null | undefined>): number | null {
  const nums = values.filter((v): v is number => typeof v === 'number')
  if (nums.length === 0) return null
  return nums.reduce((a, b) => a + b, 0) / nums.length
}

const fmt = (v: number | null | undefined, digits = 2) =>
  typeof v === 'number' ? v.toFixed(digits) : '—'

export function compareArms(logsDir: string, agentA?: string, agentB?: string) {
  const rows = readRows(logsDir)
  const agents = [...new Set(rows.map((r) => r.agentId))]
  const a = agentA ?? agents[0]
  const b = agentB ?? agents.find((id) => id !== a)
  if (!a || !b) {
    throw new Error(
      `Need two arms in ${logsDir}; found ${agents.join(', ') || 'none'}`,
    )
  }
  const tasks = [...new Set(rows.map((r) => r.task))].sort()
  const byKey = new Map(rows.map((r) => [`${r.task}::${r.agentId}`, r]))

  const lines: string[] = []
  lines.push(`Logs: ${logsDir}`)
  lines.push(`A = ${a}`)
  lines.push(`B = ${b}`)
  lines.push('')
  lines.push(
    '| task | A score (compl/qual) | B score (compl/qual) | Δ | A agent s | B agent s | A task s | B task s | A $ | B $ | errors |',
  )
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|')
  let wins = 0
  let ties = 0
  let losses = 0
  const paired: Array<{ ra: TaskRow; rb: TaskRow }> = []
  for (const task of tasks) {
    const ra = byKey.get(`${task}::${a}`)
    const rb = byKey.get(`${task}::${b}`)
    if (!ra && !rb) continue
    const delta =
      ra?.overall != null && rb?.overall != null
        ? rb.overall - ra.overall
        : null
    if (ra && rb && !ra.error && !rb.error && delta != null) {
      paired.push({ ra, rb })
      if (Math.abs(delta) < 0.05) ties++
      else if (delta > 0) wins++
      else losses++
    }
    const errors = [
      ra?.error ? `A: ${ra.error.slice(0, 60)}` : '',
      rb?.error ? `B: ${rb.error.slice(0, 60)}` : '',
    ]
      .filter(Boolean)
      .join('; ')
    lines.push(
      `| ${task} | ${fmt(ra?.overall, 1)} (${fmt(ra?.completion, 0)}/${fmt(ra?.quality, 0)}) | ${fmt(rb?.overall, 1)} (${fmt(rb?.completion, 0)}/${fmt(rb?.quality, 0)}) | ${delta == null ? '—' : (delta >= 0 ? '+' : '') + delta.toFixed(1)} | ${fmt(ra?.agentSeconds, 0)} | ${fmt(rb?.agentSeconds, 0)} | ${fmt(ra?.taskSeconds, 0)} | ${fmt(rb?.taskSeconds, 0)} | ${fmt(ra?.cost, 3)} | ${fmt(rb?.cost, 3)} | ${errors} |`,
    )
  }
  const aRows = paired.map((p) => p.ra)
  const bRows = paired.map((p) => p.rb)
  lines.push('')
  lines.push(
    `Paired tasks with both arms scored and error-free: ${paired.length}`,
  )
  lines.push(
    `| arm | mean score | mean completion | mean quality | mean agent s | median agent s | mean task s | mean $ |`,
  )
  lines.push('|---|---|---|---|---|---|---|---|')
  const median = (values: Array<number | null>) => {
    const nums = values
      .filter((v): v is number => typeof v === 'number')
      .sort((x, y) => x - y)
    if (nums.length === 0) return null
    const mid = Math.floor(nums.length / 2)
    return nums.length % 2 ? nums[mid]! : (nums[mid - 1]! + nums[mid]!) / 2
  }
  for (const [label, set] of [
    ['A', aRows],
    ['B', bRows],
  ] as const) {
    lines.push(
      `| ${label} | ${fmt(mean(set.map((r) => r.overall)))} | ${fmt(mean(set.map((r) => r.completion)))} | ${fmt(mean(set.map((r) => r.quality)))} | ${fmt(mean(set.map((r) => r.agentSeconds)), 0)} | ${fmt(median(set.map((r) => r.agentSeconds)), 0)} | ${fmt(mean(set.map((r) => r.taskSeconds)), 0)} | ${fmt(mean(set.map((r) => r.cost)), 3)} |`,
    )
  }
  lines.push('')
  lines.push(
    `B vs A on overall score: ${wins} wins, ${ties} ties, ${losses} losses`,
  )
  lines.push('')
  lines.push('Trace shape, mean per task (paired tasks):')
  lines.push(
    '| arm | root tool calls | spawn rounds | tasks with workers | workers | root terminal cmds | worker terminal cmds | web reads | error events |',
  )
  lines.push('|---|---|---|---|---|---|---|---|---|')
  for (const [label, set] of [
    ['A', aRows],
    ['B', bRows],
  ] as const) {
    const m = (pick: (s: TraceShape) => number) =>
      fmt(mean(set.map((r) => pick(r.shape))), 1)
    const withWorkers = set.filter((r) => r.shape.workers > 0).length
    lines.push(
      `| ${label} | ${m((s) => s.rootToolCalls)} | ${m((s) => s.spawnRounds)} | ${withWorkers}/${set.length} | ${m((s) => s.workers)} | ${m((s) => s.rootCommands)} | ${m((s) => s.workerCommands)} | ${m((s) => s.webReads)} | ${m((s) => s.errors)} |`,
    )
  }
  return lines.join('\n')
}

if (import.meta.main) {
  const [logsDir, agentA, agentB] = process.argv.slice(2)
  if (!logsDir) {
    console.error(
      'usage: bun run buffbench/compare-arms.ts <logsDir> [agentA] [agentB]',
    )
    process.exit(1)
  }
  console.log(compareArms(path.resolve(logsDir), agentA, agentB))
}
