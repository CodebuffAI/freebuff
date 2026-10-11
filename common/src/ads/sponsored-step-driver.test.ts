import { describe, expect, test } from 'bun:test'

import {
  driveSponsoredSkillSteps,
  sponsoredStepCardStates,
  sponsoredStepDiagnostic,
  sponsoredStepReportPrompt,
} from './sponsored-step-driver'

import type { SponsoredSkill, SponsoredSkillStep } from './sponsored-skill'
import type { SponsoredSkillCheckContext } from './sponsored-skill-checks'

function step(
  id: string,
  kind: SponsoredSkillStep['kind'],
  path: string,
  maxAttempts?: number,
): SponsoredSkillStep {
  return {
    id,
    kind,
    title: kind === 'user' ? `Ask the user to ${id}` : `Do ${id}`,
    instructions: kind === 'check' ? '' : `Make ${path}.`,
    checks: [{ id: `${id}-file`, label: `${path} exists`, kind: 'file_exists', path }],
    ...(maxAttempts ? { maxAttempts } : {}),
  }
}

function skill(steps: SponsoredSkillStep[]): SponsoredSkill {
  return {
    format: 1,
    id: 'acme-test',
    version: '1.0.0',
    advertiser: 'Acme',
    goal: 'g',
    fits: 'f',
    consent: { title: 't', summary: 's' },
    requirements: { os: [], runtimes: [], packageManagers: [], frameworks: [] },
    packages: [],
    tools: [],
    preflight: [],
    knowledge: [],
    changelog: 'First version.',
    steps,
    outcomes: [],
  }
}

const STEPS = [
  step('client', 'agent', 'src/client.ts'),
  step('page', 'agent', 'src/page.ts'),
  step('verify', 'check', 'dist/ok'),
  step('login', 'user', '.acme-login'),
]

/** A fake worktree, and an agent that creates a file after N prompts about it. */
function world(initial: string[], fixable: Record<string, number> = {}) {
  const files = new Set(initial)
  const prompts: string[] = []
  const ctx: SponsoredSkillCheckContext = {
    files: () => [...files],
    changedFiles: () => [...files],
    readFile: (path) => (files.has(path) ? '' : null),
    runScript: async () => 'missing',
    runCommand: async () => ({ exitCode: 0, output: '' }),
    credentialProvided: () => false,
    userConfirmed: () => false,
  }
  const prompt = async (text: string) => {
    prompts.push(text)
    for (const [path, after] of Object.entries(fixable)) {
      if (text.includes(`no file matches ${path}`)) {
        fixable[path] = after - 1
        if (after - 1 <= 0) files.add(path)
      }
    }
    return true
  }
  return { files, prompts, ctx, prompt }
}

describe('driveSponsoredSkillSteps', () => {
  test('everything already passes: no prompts, delivered', async () => {
    const w = world(['src/client.ts', 'src/page.ts', 'dist/ok'])
    const result = await driveSponsoredSkillSteps({
      skill: skill(STEPS),
      ctx: w.ctx,
      prompt: w.prompt,
      canContinue: () => true,
    })
    expect(w.prompts).toEqual([])
    expect(result.delivered).toBe(true)
    expect(result.skill).toBe('acme-test@1.0.0')
    expect(result.steps.map((s) => s.status)).toEqual([
      'passed',
      'passed',
      'passed',
      'needs_user',
    ])
    expect(sponsoredStepCardStates(result).map((s) => s.state)).toEqual([
      'done',
      'done',
      'done',
      'needs_you',
    ])
  })

  test('a failed check goes back to the agent with the evaluator feedback, then passes', async () => {
    const w = world(['src/client.ts', 'dist/ok'], { 'src/page.ts': 1 })
    const result = await driveSponsoredSkillSteps({
      skill: skill(STEPS),
      ctx: w.ctx,
      prompt: w.prompt,
      canContinue: () => true,
    })
    expect(w.prompts).toHaveLength(1)
    expect(w.prompts[0]).toContain('step 2 of 4')
    expect(w.prompts[0]).toContain('These checks failed.')
    expect(w.prompts[0]).toContain('- src/page.ts exists: no file matches src/page.ts')
    expect(w.prompts[0]).toContain('Make src/page.ts.')
    expect(result.delivered).toBe(true)
    expect(result.steps[1]).toMatchObject({ status: 'passed', fixes: 1 })
  })

  test('a check step is fixed like an agent step', async () => {
    const w = world(['src/client.ts', 'src/page.ts'], { 'dist/ok': 1 })
    const result = await driveSponsoredSkillSteps({
      skill: skill(STEPS),
      ctx: w.ctx,
      prompt: w.prompt,
      canContinue: () => true,
    })
    expect(result.steps[2]).toMatchObject({ kind: 'check', status: 'passed', fixes: 1 })
  })

  test('maxAttempts counts the first try: blocked after the fixes, and the walk stops', async () => {
    const w = world(['dist/ok'])
    const result = await driveSponsoredSkillSteps({
      skill: skill(STEPS),
      ctx: w.ctx,
      prompt: w.prompt,
      canContinue: () => true,
    })
    // Default 3 attempts: the turn's own try plus 2 fixes. Step 2 is never prompted.
    expect(w.prompts).toHaveLength(2)
    expect(result.delivered).toBe(false)
    expect(result.steps.map((s) => s.status)).toEqual([
      'blocked',
      'not_reached',
      'passed',
      'needs_user',
    ])
    expect(sponsoredStepDiagnostic(result)).toBe(
      'step checks (acme-test@1.0.0): 1/4 ok after 2 fixes; step 1 blocked; step 2 not_reached',
    )
    expect(sponsoredStepReportPrompt(result)).toContain(
      'Step 1: NOT done: a check still fails',
    )
  })

  test('maxAttempts 1 means no fixes at all', async () => {
    const w = world([])
    const result = await driveSponsoredSkillSteps({
      skill: skill([step('client', 'agent', 'src/client.ts', 1)]),
      ctx: w.ctx,
      prompt: w.prompt,
      canContinue: () => true,
    })
    expect(w.prompts).toEqual([])
    expect(result.steps[0]!.status).toBe('blocked')
  })

  test('the per-run budget caps fixes across steps', async () => {
    const w = world(['dist/ok'], { 'src/client.ts': 1, 'src/page.ts': 5 })
    const result = await driveSponsoredSkillSteps({
      skill: skill([
        step('client', 'agent', 'src/client.ts', 5),
        step('page', 'agent', 'src/page.ts', 5),
      ]),
      ctx: w.ctx,
      prompt: w.prompt,
      canContinue: () => true,
      maxFixesPerRun: 3,
    })
    expect(result.fixes).toBe(3)
    expect(result.steps.map((s) => s.status)).toEqual(['passed', 'blocked'])
  })

  test('out of time before the first fix: not reached, and said why', async () => {
    const w = world(['src/client.ts'])
    const result = await driveSponsoredSkillSteps({
      skill: skill(STEPS),
      ctx: w.ctx,
      prompt: w.prompt,
      canContinue: () => false,
    })
    expect(w.prompts).toEqual([])
    expect(result.stoppedBecause).toBe('out_of_time')
    expect(result.steps[1]!.status).toBe('not_reached')
  })

  test('a turn that fails mid-fix stops the walk', async () => {
    const w = world(['src/client.ts'])
    const result = await driveSponsoredSkillSteps({
      skill: skill(STEPS),
      ctx: w.ctx,
      prompt: async () => false,
      canContinue: () => true,
    })
    expect(result.stoppedBecause).toBe('turn_failed')
    expect(result.steps[1]).toMatchObject({ status: 'blocked', fixes: 1 })
    expect(result.steps[2]!.status).toBe('not_reached')
  })

  test('a user step passes once its checks do, and is never prompted', async () => {
    const w = world(['src/client.ts', 'src/page.ts', 'dist/ok', '.acme-login'])
    const result = await driveSponsoredSkillSteps({
      skill: skill(STEPS),
      ctx: w.ctx,
      prompt: w.prompt,
      canContinue: () => true,
    })
    expect(result.steps[3]!.status).toBe('passed')
  })

  test('a fix that breaks an earlier step is caught on the final pass', async () => {
    const w = world(['src/client.ts'])
    const result = await driveSponsoredSkillSteps({
      skill: skill(STEPS.slice(0, 2)),
      ctx: w.ctx,
      prompt: async () => {
        w.files.add('src/page.ts')
        w.files.delete('src/client.ts')
        return true
      },
      canContinue: () => true,
    })
    expect(result.steps.map((s) => s.status)).toEqual(['blocked', 'passed'])
    expect(result.delivered).toBe(false)
  })

  test('a context that throws is a failure, not a crash or a pass', async () => {
    const w = world([])
    const result = await driveSponsoredSkillSteps({
      skill: skill([step('client', 'agent', 'src/client.ts', 1)]),
      ctx: {
        ...w.ctx,
        files: () => {
          throw new Error('disk gone')
        },
      },
      prompt: w.prompt,
      canContinue: () => true,
    })
    expect(result.steps[0]!.status).toBe('blocked')
    expect(result.steps[0]!.checks[0]!.detail).toContain('disk gone')
  })
})
