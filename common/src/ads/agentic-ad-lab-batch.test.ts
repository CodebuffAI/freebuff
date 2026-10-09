import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  LAB_ENVIRONMENTS,
  LAB_ENVIRONMENT_KEYS,
  labBatchInputSchema,
  labProbeCollided,
  nextLabBatchSlot,
  summarizeLabBatch,
  type LabBatch,
  type LabBatchRun,
  type LabRunGrade,
} from './agentic-ad-lab-batch'

const grade = (
  tier: LabRunGrade['tier'],
  causeKey = tier === 'perfect' ? 'none' : 'missing_node',
  steps: [number, number] | null = [3, 3],
): LabRunGrade => ({
  tier,
  causeKey,
  cause: '',
  stepsCompleted: steps?.[0] ?? null,
  stepsTotal: steps?.[1] ?? null,
  grader: 'model',
  rubricVersion: 'v',
})
const run = (
  projectId: string,
  slot: number,
  extra: Partial<LabBatchRun> = {},
): LabBatchRun => ({
  workspaceId: `${projectId}-${slot}`,
  projectId,
  slot,
  runId: `run-${projectId}-${slot}`,
  runStatus: 'completed',
  signup: 'idle',
  grade: null,
  probe: null,
  ...extra,
})
const batch = (
  runs: LabBatchRun[],
  extra: Partial<LabBatch> = {},
): LabBatch => ({
  id: 'b',
  name: 'Archil',
  adName: 'Archil',
  procedureSha256: 'x',
  environment: 'default',
  signup: 'decline',
  repetitions: 10,
  repositories: [
    { projectId: 'a', fullName: 'acme/a' },
    { projectId: 'b', fullName: 'acme/b' },
    { projectId: 'c', fullName: 'acme/c' },
  ],
  state: 'running',
  createdAt: '2026-10-09T00:00:00.000Z',
  runs,
  ...extra,
})

describe('summarizeLabBatch', () => {
  test('reports the perfect rate over graded runs with causes and steps reached', () => {
    const summary = summarizeLabBatch(
      batch([
        run('a', 0, { grade: grade('perfect') }),
        run('a', 1, { grade: grade('partial', 'missing_node', [1, 3]) }),
        run('b', 0, { grade: grade('partial', 'missing_node', [1, 3]) }),
        run('b', 1, { grade: grade('handoff', 'needs_api_key', null) }),
        run('c', 0, { runStatus: 'running' }),
      ]),
    )
    expect(summary).toEqual({
      planned: 30,
      started: 5,
      graded: 4,
      perfect: 1,
      perfectRate: 0.25,
      byTier: { perfect: 1, handoff: 1, partial: 2, broken: 0, lost: 0 },
      byCause: [
        { causeKey: 'missing_node', count: 2 },
        { causeKey: 'needs_api_key', count: 1 },
      ],
      byStepReached: [
        { reached: '1/3', count: 2 },
        { reached: '3/3', count: 1 },
        { reached: 'unknown', count: 1 },
      ],
      collisions: null,
    })
  })

  test('has no rate before a run is graded', () => {
    expect(summarizeLabBatch(batch([])).perfectRate).toBeNull()
  })

  test('counts package.json collisions only for runs the writer edited', () => {
    const probe = (lastEdit: number, markerInFile: number | null) => ({
      kind: 'concurrent-package-json' as const,
      editsWritten: lastEdit,
      unreadable: 0,
      lastEdit: lastEdit || null,
      markerInFile,
      packageJsonValid: true,
    })
    const summary = summarizeLabBatch(
      batch(
        [
          run('a', 0, { probe: probe(5, 5) }),
          run('a', 1, { probe: probe(5, 4) }),
          run('a', 2, { probe: probe(0, null) }),
          run('a', 3),
        ],
        { environment: 'concurrent-package-json' },
      ),
    )
    expect(summary.collisions).toEqual({ measured: 2, collided: 1 })
  })
})

test('labProbeCollided flags an invalid or unreadable file and a lost last edit', () => {
  const base = {
    kind: 'concurrent-package-json' as const,
    editsWritten: 3,
    unreadable: 0,
    lastEdit: 3,
    markerInFile: 3,
    packageJsonValid: true,
  }
  expect(labProbeCollided(base)).toBe(false)
  expect(labProbeCollided({ ...base, markerInFile: 2 })).toBe(true)
  expect(labProbeCollided({ ...base, packageJsonValid: false })).toBe(true)
  expect(labProbeCollided({ ...base, unreadable: 1 })).toBe(true)
  expect(labProbeCollided({ kind: 'setup-failed', error: 'x' })).toBeNull()
  expect(labProbeCollided(null)).toBeNull()
})

test('nextLabBatchSlot fills each repetition across repositories before the next', () => {
  const b = batch([run('a', 0), run('b', 0)])
  expect(nextLabBatchSlot(b)).toEqual({ projectId: 'c', slot: 0 })
  expect(nextLabBatchSlot(b, new Set(['c']))).toEqual({
    projectId: 'a',
    slot: 1,
  })
  expect(nextLabBatchSlot({ ...b, repetitions: 1 }, new Set(['c']))).toBeNull()
})

test('a batch input is bounded in runs and repositories', () => {
  const input = {
    name: 'Archil',
    selection: { kind: 'draft', id: crypto.randomUUID() },
    projectIds: ['a', 'b', 'c'],
    repetitions: 10,
    environment: 'node-nvm',
    signup: 'decline',
  }
  expect(labBatchInputSchema.safeParse(input).success).toBe(true)
  expect(
    labBatchInputSchema.safeParse({ ...input, projectIds: ['a', 'a'] }).success,
  ).toBe(false)
  expect(
    labBatchInputSchema.safeParse({
      ...input,
      projectIds: Array.from({ length: 6 }, (_, i) => `p${i}`),
      repetitions: 20,
    }).success,
  ).toBe(false)
  expect(
    labBatchInputSchema.safeParse({ ...input, environment: 'windows' }).success,
  ).toBe(false)
})

describe('environment scripts', () => {
  const bash = (script: string, home: string, cwd = home, path = '') =>
    Bun.spawnSync(['bash', '-c', script], {
      cwd,
      env: {
        HOME: home,
        PATH: `${path}${home}/.local/bin:${process.env.PATH}`,
      },
    })

  test.each(LAB_ENVIRONMENT_KEYS)('%s parses', (key) => {
    const { setup, probe } = LAB_ENVIRONMENTS[key]
    for (const script of [setup, probe])
      if (script)
        expect(Bun.spawnSync(['bash', '-n', '-c', script]).exitCode).toBe(0)
  })

  test('a toolchain case activates from the profile once and hides the system node', () => {
    const home = mkdtempSync(join(tmpdir(), 'lab-home-'))
    // A stand-in installer: curl prints a script that creates the mise binary.
    const bin = join(home, 'fake-bin')
    mkdirSync(bin)
    writeFileSync(
      join(bin, 'curl'),
      `#!/bin/sh\nprintf '%s\\n' 'mkdir -p "$(dirname "$MISE_INSTALL_PATH")"; printf "#!/bin/sh\\nexit 0\\n" > "$MISE_INSTALL_PATH"; chmod 755 "$MISE_INSTALL_PATH"'\n`,
      { mode: 0o755 },
    )
    const setup = LAB_ENVIRONMENTS['node-mise'].setup
    for (let i = 0; i < 2; i++) {
      const result = bash(setup, home, home, `${bin}:`)
      expect(result.stderr.toString()).toBe('')
      expect(result.exitCode).toBe(0)
    }
    const rc = readFileSync(join(home, '.bashrc'), 'utf8')
    expect(rc.match(/# freebuff-lab toolchain/g)).toHaveLength(1)
    expect(rc).toContain('eval "$("$MISE_DATA_DIR/bin/mise" activate bash)"')
    const node = bash('node --version', home)
    expect(node.exitCode).toBe(127)
    expect(node.stderr.toString()).toContain('node: not found')
  })

  test('the collision probe reports the writer’s last edit against package.json', () => {
    const home = mkdtempSync(join(tmpdir(), 'lab-home-'))
    const repo = join(home, 'repo')
    mkdirSync(join(home, '.cache/freebuff-lab'), { recursive: true })
    mkdirSync(repo)
    writeFileSync(join(home, '.cache/freebuff-lab/edits'), '1\n2\n3\n')
    writeFileSync(
      join(repo, 'package.json'),
      JSON.stringify({ name: 'x', freebuffLabConcurrentEdit: 2 }),
    )
    const result = bash(
      LAB_ENVIRONMENTS['concurrent-package-json'].probe,
      home,
      repo,
    )
    const probe = JSON.parse(result.stdout.toString().trim())
    expect(probe).toEqual({
      kind: 'concurrent-package-json',
      editsWritten: 3,
      unreadable: 0,
      lastEdit: 3,
      markerInFile: 2,
      packageJsonValid: true,
    })
    expect(labProbeCollided(probe)).toBe(true)
  })

  test('the collision case refuses a repository without package.json', () => {
    const home = mkdtempSync(join(tmpdir(), 'lab-home-'))
    const result = bash(LAB_ENVIRONMENTS['concurrent-package-json'].setup, home)
    expect(result.exitCode).toBe(3)
  })
})
