import fs from 'fs'
import path from 'path'

import type { ContextLogEntry } from './runners/runner'
import type { AgentTraceData } from './trace-analyzer'

/**
 * Every arm of a buffbench run against one base arm: judge score, the agent's
 * own wall clock, an estimated DeepSeek V4.1 Flash bill, and what the agent
 * did (root steps, async subagents), overall and by the size of the
 * ground-truth change. The cost is priced from the per-request usage receipts
 * (`contextLog`), which include the async subagents' own requests; the SDK
 * credit counter reads $0 on some lanes. Prices are DeepSeek direct's peak
 * card for Flash (web/src/llm-api/deepseek.ts); off-peak halves each, so
 * ratios between arms hold either way.
 *
 *   bun run buffbench/async-arms-report.ts <logsDir>[,<logsDir>] [baseAgentId]
 *     [--replicates]
 *
 * Several directories may be given: by default a later one wins for a task it
 * also has (a resumed run); with --replicates each is an independent run, a
 * task pairs only with its own run's base arm, and the means pool every run.
 * Each arm pairs with the base arm on the tasks both finished without an error.
 */
const PER_M = { uncached: 0.3, cached: 0.006, output: 1.2 }

type Usage = Extract<ContextLogEntry, { type: 'usage' }>

const requestCost = (u: Usage) =>
  ((u.inputTokens - u.cachedInputTokens) * PER_M.uncached +
    u.cachedInputTokens * PER_M.cached +
    u.outputTokens * PER_M.output) /
  1e6

type Row = {
  task: string
  agent: string
  score: number | undefined
  error: boolean
  agentSec: number
  cost: number
  cacheHit: number
  rootSteps: number
  subagents: number
}

const replicates = process.argv.includes('--replicates')
const [dirsArg = '', baseArg] = process.argv
  .slice(2)
  .filter((arg) => !arg.startsWith('--'))
const dirs = dirsArg.split(',').filter(Boolean)
const baseAgent = baseArg ?? 'base3-free-deepseek-flash-evals'

const byKey = new Map<string, Row>()
for (const [dirIndex, dir] of dirs.entries()) {
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.json') || file.includes('ANALYSIS')) continue
    const data = JSON.parse(
      fs.readFileSync(path.join(dir, file), 'utf8'),
    ) as AgentTraceData & { contextLog?: ContextLogEntry[] }
    if (!data.agentId || !data.judgeResult) continue
    const usage = (data.contextLog ?? []).filter(
      (e): e is Usage => e.type === 'usage',
    )
    const bareTask = file.slice(
      file.indexOf('-') + 1,
      file.indexOf(`-${data.agentId.replace(/[^a-zA-Z0-9-]/g, '_')}-`),
    )
    const task = replicates ? `${bareTask}@r${dirIndex + 1}` : bareTask
    const trace = (data.trace ?? []) as {
      type?: string
      toolName?: string
      parentAgentId?: string
    }[]
    const input = usage.reduce((s, u) => s + u.inputTokens, 0)
    byKey.set(`${task}\u0000${data.agentId}`, {
      task,
      agent: data.agentId,
      score: data.judgeResult.overallScore,
      error: Boolean(data.error),
      agentSec: Math.round((data.agentDurationMs ?? data.durationMs) / 1000),
      cost: usage.reduce((s, u) => s + requestCost(u), 0),
      cacheHit: input
        ? usage.reduce((s, u) => s + u.cachedInputTokens, 0) / input
        : 0,
      rootSteps: usage.filter((u) => u.isRoot !== false).length,
      subagents: trace.filter(
        (e) =>
          e.type === 'tool_call' &&
          e.toolName === 'spawn_agent_async' &&
          !e.parentAgentId,
      ).length,
    })
  }
}

const rows = [...byKey.values()].sort(
  (a, b) => a.task.localeCompare(b.task) || a.agent.localeCompare(b.agent),
)
const short = (agent: string) => agent.replace('-free-deepseek-flash-evals', '')
const agents = [...new Set(rows.map((r) => r.agent))].sort((a, b) =>
  a === baseAgent ? -1 : b === baseAgent ? 1 : a.localeCompare(b),
)

console.log(
  ['task', ...agents.map((a) => `${short(a)} score/sec/$/subs`)].join('\t'),
)
const tasks = [...new Set(rows.map((r) => r.task))]
for (const task of tasks) {
  const cells = agents.map((agent) => {
    const r = byKey.get(`${task}\u0000${agent}`)
    if (!r) return '-'
    return `${r.score?.toFixed(1) ?? '?'}${r.error ? 'E' : ''} ${r.agentSec}s $${r.cost.toFixed(3)} ${r.subagents}`
  })
  console.log([task, ...cells].join('\t'))
}

const mean = (xs: number[]) =>
  xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length)
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  if (s.length === 0) return 0
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const finished = (task: string, agent: string) => {
  const r = byKey.get(`${task}\u0000${agent}`)
  return Boolean(r && !r.error && r.score !== undefined)
}
/** The tasks this arm and the base arm both finished without an error. */
const pairedWith = (agent: string) =>
  tasks.filter((task) => finished(task, agent) && finished(task, baseAgent))
const cell = (task: string, agent: string) =>
  byKey.get(`${task}\u0000${agent}`)!

console.log(
  '\nEach arm on the tasks it and the base arm finished without an error:',
)
console.log(
  [
    'agent',
    'n',
    'score',
    'Δ vs base (se)',
    'W/T/L',
    'median s',
    'mean s',
    'median time ratio',
    'mean $',
    'cost ratio',
    'cache hit',
    'root steps',
    'subagents',
  ].join('\t'),
)
for (const agent of agents) {
  const paired = pairedWith(agent)
  const own = paired.map((task) => cell(task, agent))
  const base = paired.map((task) => cell(task, baseAgent))
  const deltas = paired.map(
    (task) => cell(task, agent).score! - cell(task, baseAgent).score!,
  )
  const sd = Math.sqrt(
    mean(deltas.map((d) => (d - mean(deltas)) ** 2)) *
      (deltas.length / Math.max(1, deltas.length - 1)),
  )
  const se = sd / Math.sqrt(Math.max(1, deltas.length))
  const wins = deltas.filter((d) => d > 0.25).length
  const losses = deltas.filter((d) => d < -0.25).length
  const cost = mean(own.map((r) => r.cost))
  const baseCost = mean(base.map((r) => r.cost))
  console.log(
    [
      short(agent),
      paired.length,
      mean(own.map((r) => r.score!)).toFixed(2),
      agent === baseAgent
        ? '-'
        : `${mean(deltas) >= 0 ? '+' : ''}${mean(deltas).toFixed(2)} (${se.toFixed(2)})`,
      agent === baseAgent
        ? '-'
        : `${wins}/${deltas.length - wins - losses}/${losses}`,
      median(own.map((r) => r.agentSec)),
      Math.round(mean(own.map((r) => r.agentSec))),
      agent === baseAgent
        ? '-'
        : median(
            paired.map(
              (task) =>
                cell(task, agent).agentSec /
                Math.max(1, cell(task, baseAgent).agentSec),
            ),
          ).toFixed(2),
      `$${cost.toFixed(4)}`,
      agent === baseAgent ? '-' : `${(cost / baseCost).toFixed(2)}x`,
      `${Math.round(100 * mean(own.map((r) => r.cacheHit)))}%`,
      mean(own.map((r) => r.rootSteps)).toFixed(1),
      mean(own.map((r) => r.subagents)).toFixed(1),
    ].join('\t'),
  )
}
// The same comparison by the size of the ground-truth change.
const evalCommits: { id: string; fileDiffs: unknown[] }[] = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'eval-codebuff.json'), 'utf8'),
).evalCommits
const fileCount = new Map(evalCommits.map((c) => [c.id, c.fileDiffs.length]))
const sizeOf = (task: string) => {
  const n = fileCount.get(task.replace(/@r\d+$/, '')) ?? 0
  return n <= 3 ? '1-3 files' : n <= 7 ? '4-7 files' : '8+ files'
}
console.log('\nBy ground-truth size (paired tasks):')
console.log(['size', 'agent', 'n', 'Δ score', 'median time ratio'].join('\t'))
for (const size of ['1-3 files', '4-7 files', '8+ files']) {
  for (const agent of agents.filter((a) => a !== baseAgent)) {
    const tasksOfSize = pairedWith(agent).filter(
      (task) => sizeOf(task) === size,
    )
    const ratios = tasksOfSize.map(
      (task) =>
        cell(task, agent).agentSec /
        Math.max(1, cell(task, baseAgent).agentSec),
    )
    const delta = mean(
      tasksOfSize.map(
        (task) => cell(task, agent).score! - cell(task, baseAgent).score!,
      ),
    )
    console.log(
      [
        size,
        short(agent),
        tasksOfSize.length,
        `${delta >= 0 ? '+' : ''}${delta.toFixed(2)}`,
        median(ratios).toFixed(2),
      ].join('\t'),
    )
  }
}

const errors = rows.filter((r) => r.error)
if (errors.length) {
  console.log(
    `\nErrored: ${errors.map((r) => `${r.task}:${short(r.agent)}`).join(', ')}`,
  )
}
