/**
 * The step driver: the harness, not the model, decides when a sponsored
 * skill's steps are done (piece 3 of COD-822; the format is
 * `docs/ads/agentic/sponsored-skills.md`).
 *
 * After the run's turn has done its work, the driver walks the skill's steps
 * in order and runs each step's checks through THE skill evaluator
 * (`evaluateSponsoredSkillChecks`), the same one the sponsored eval scores
 * with. A step with no failing check is done, whatever the model said. A
 * failing `agent` or `check` step goes back to the agent with the failed
 * checks (`sponsoredSkillCheckFeedback`), to fix and stop; the checks run
 * again after each fix. The step's `maxAttempts` counts the first try (the
 * turn's own work) plus fixes, and the run as a whole gets at most
 * {@link SPONSORED_STEP_MAX_FIXES_PER_RUN}. Then the step is BLOCKED, and the
 * walk ends there: later steps usually build on it, and prompting them would
 * spend the run's compute on work that cannot pass. They are still checked
 * once, so the result says what is true on disk.
 *
 * - A `user` step is never prompted or retried. It is done only once its
 *   checks pass (the user handed over the credential), else it needs the user.
 * - A step that passed before a later fix is checked again at the end: a fix
 *   for step 4 can break step 2.
 *
 * DELIVERED means every `agent` and `check` step passed. That is the run's
 * completion, not the model writing "Done:".
 *
 * Pure: the caller hands in the check context (its worktree, its sandbox) and
 * how to prompt the agent, so the whole loop runs in tests without a model,
 * a sandbox or a disk.
 */

import {
  DEFAULT_SKILL_MAX_ATTEMPTS,
  sponsoredSkillDirective,
  sponsoredSkillMatchesProcedure,
  sponsoredSkillSha256,
  type SponsoredSkill,
  type SponsoredSkillStep,
} from './sponsored-skill'
import { resolveSponsoredSkill } from './sponsored-skills/registry'
import {
  evaluateSponsoredSkillChecks,
  sponsoredSkillCheckFeedback,
  type SponsoredSkillCheckContext,
  type SponsoredSkillCheckResult,
} from './sponsored-skill-checks'

import type { SponsoredFrictionInput } from './sponsored-run-friction'

export type SponsoredStepStatus =
  /** No check failed. */
  | 'passed'
  /** A check still failed after the last fix the driver could ask for. */
  | 'blocked'
  /** Not reached: the walk stopped before this step, and its checks fail. */
  | 'not_reached'
  /** A user step whose checks do not pass yet. */
  | 'needs_user'

export type SponsoredStepResult = {
  /** 1-based, as the rendered procedure numbers it. */
  number: number
  id: string
  title: string
  kind: SponsoredSkillStep['kind']
  status: SponsoredStepStatus
  /** How many fix prompts this step was given. */
  fixes: number
  /** The last time its checks ran. */
  checks: SponsoredSkillCheckResult[]
}

export type SponsoredStepDriveResult = {
  skill: string
  steps: SponsoredStepResult[]
  /** Every agent and check step passed. */
  delivered: boolean
  /** Fix prompts sent in all. */
  fixes: number
  /** Why the walk stopped early, when it did. */
  stoppedBecause?: 'turn_failed' | 'out_of_time'
}

export const SPONSORED_STEP_MAX_FIXES_PER_RUN = 6

/**
 * The registered skill an accepted procedure names, or null. Only when the
 * text is exactly that skill's rendering (`sponsoredSkillMatchesProcedure`):
 * a legacy procedure, a skill this build does not ship, or text that differs
 * from the registered bytes is not driven.
 */
export function sponsoredProcedureSkill(
  procedure: string | null | undefined,
): SponsoredSkill | null {
  const directive = sponsoredSkillDirective(procedure)
  if (!directive || !procedure) return null
  const skill = resolveSponsoredSkill(`${directive.id}@${directive.version}`)
  return skill && sponsoredSkillMatchesProcedure(skill, procedure)
    ? skill
    : null
}

/**
 * The skill a run record names, looked up again in this build's registry and
 * held to the hash recorded at accept. Null when this build does not ship it
 * or the bytes differ, and then the run is not driven.
 */
export function sponsoredRunSkill(ref: {
  id: string
  version: string
  sha256: string
}): SponsoredSkill | null {
  const skill = resolveSponsoredSkill(`${ref.id}@${ref.version}`)
  return skill && sponsoredSkillSha256(skill) === ref.sha256 ? skill : null
}

export type SponsoredStepDriverDeps = {
  skill: SponsoredSkill
  ctx: SponsoredSkillCheckContext
  /**
   * Run one more segment of the agent's turn with this prompt. Resolves false
   * when it did not complete (an error, an abort): the walk stops there.
   */
  prompt: (text: string) => Promise<boolean>
  /** False once the run is aborted or its compute grant is about to lapse. */
  canContinue: () => boolean
  maxFixesPerRun?: number
}

/** `<id>@<version>`, as the registry keys it. */
function skillKey(skill: SponsoredSkill): string {
  return `${skill.id}@${skill.version}`
}

async function check(
  deps: SponsoredStepDriverDeps,
  step: SponsoredSkillStep,
): Promise<{ passed: boolean; results: SponsoredSkillCheckResult[] }> {
  try {
    return await evaluateSponsoredSkillChecks(step.checks, deps.ctx, deps.skill)
  } catch (error) {
    // The evaluator never throws for a check's own failure; this is the
    // context failing (a disk error). A failure, not a pass.
    return {
      passed: false,
      results: [
        {
          id: 'check-error',
          label: 'Run the checks',
          status: 'fail',
          detail: error instanceof Error ? error.message : String(error),
        },
      ],
    }
  }
}

/** Walk the steps, check each, and have the agent fix what fails. */
export async function driveSponsoredSkillSteps(
  deps: SponsoredStepDriverDeps,
): Promise<SponsoredStepDriveResult> {
  const maxPerRun = deps.maxFixesPerRun ?? SPONSORED_STEP_MAX_FIXES_PER_RUN
  const total = deps.skill.steps.length
  const results: SponsoredStepResult[] = []
  // The fix count at which each step last passed: a later fix may undo it.
  const passedAt = new Map<number, number>()
  let fixes = 0
  let walking = true
  let stoppedBecause: SponsoredStepDriveResult['stoppedBecause']

  for (const [index, step] of deps.skill.steps.entries()) {
    const number = index + 1
    const base = { number, id: step.id, title: step.title, kind: step.kind }
    let outcome = await check(deps, step)

    if (step.kind === 'user') {
      results.push({
        ...base,
        status: outcome.passed ? 'passed' : 'needs_user',
        fixes: 0,
        checks: outcome.results,
      })
      continue
    }

    const walkingAtEntry = walking
    // The turn's own work was the first attempt.
    const maxFixes = (step.maxAttempts ?? DEFAULT_SKILL_MAX_ATTEMPTS) - 1
    let stepFixes = 0
    while (walking && !outcome.passed) {
      if (stepFixes >= maxFixes || fixes >= maxPerRun) break
      if (!deps.canContinue()) {
        walking = false
        stoppedBecause = 'out_of_time'
        break
      }
      stepFixes += 1
      fixes += 1
      const completed = await deps.prompt(
        sponsoredStepFixPrompt(
          step,
          number,
          total,
          outcome.results,
          stepFixes,
          maxFixes,
        ),
      )
      if (!completed) {
        walking = false
        stoppedBecause = 'turn_failed'
      }
      outcome = await check(deps, step)
    }

    if (outcome.passed) passedAt.set(number, fixes)
    // Blocked: the driver tried, or would have but the fix budget is spent.
    // Not reached: the walk had already stopped (or ran out of time) first.
    const blocked = stepFixes > 0 || (walkingAtEntry && walking)
    results.push({
      ...base,
      status: outcome.passed ? 'passed' : blocked ? 'blocked' : 'not_reached',
      fixes: stepFixes,
      checks: outcome.results,
    })
    if (!outcome.passed) walking = false
  }

  for (const result of results) {
    const at = passedAt.get(result.number)
    if (at === undefined || at === fixes) continue
    const again = await check(deps, deps.skill.steps[result.number - 1]!)
    result.checks = again.results
    if (!again.passed) result.status = 'blocked'
  }

  return {
    skill: skillKey(deps.skill),
    steps: results,
    delivered: results.every(
      (result) => result.kind === 'user' || result.status === 'passed',
    ),
    fixes,
    ...(stoppedBecause ? { stoppedBecause } : {}),
  }
}

export type SponsoredStepLoopDeps<State> = {
  skill: SponsoredSkill
  ctx: SponsoredSkillCheckContext
  /** One more segment of the run's turn; resolves null when it did not complete. */
  resume: (prompt: string, previous: State) => Promise<State | null>
  /** False once the run is aborted or out of time. */
  canContinue: () => boolean
  /** Takes the run's credentials out of command output before the agent reads it. */
  redact?: (text: string) => string
  /** A `report_friction` blocker, sent for each step left blocked. */
  onFriction?: (input: SponsoredFrictionInput) => void
}

/**
 * The driver run inside a turn, for any runtime (Desktop's harness, the Cloud
 * runner): fixes are more segments of the SAME run (same transcript), and the
 * state it resolves is the last segment that COMPLETED, so a fix that errored
 * leaves the turn where it was rather than failing work already on disk.
 */
export async function runSponsoredStepLoop<State>(
  initial: State,
  deps: SponsoredStepLoopDeps<State>,
): Promise<{ state: State; result: SponsoredStepDriveResult }> {
  const redact = deps.redact ?? ((text: string) => text)
  let state = initial

  const result = await driveSponsoredSkillSteps({
    skill: deps.skill,
    // Command output reaches the agent and the report (COD-665).
    ctx: {
      ...deps.ctx,
      runScript: async (script, timeout) => {
        const out = await deps.ctx.runScript(script, timeout)
        return out === 'missing' ? out : { ...out, output: redact(out.output) }
      },
      runCommand: async (argv, timeout) => {
        const out = await deps.ctx.runCommand(argv, timeout)
        return { ...out, output: redact(out.output) }
      },
    },
    canContinue: deps.canContinue,
    prompt: async (text) => {
      const next = await deps.resume(text, state)
      if (next === null) return false
      state = next
      return true
    },
  })

  // The report the user reads must match the checks, not the model's memory
  // of what it tried. Only after a fix: otherwise the first segment's report
  // already described the work the checks then confirmed.
  if (result.fixes > 0 && deps.canContinue()) {
    const next = await deps.resume(sponsoredStepReportPrompt(result), state)
    if (next !== null) state = next
  }

  for (const step of result.steps) {
    if (step.kind === 'user' || step.status !== 'blocked') continue
    deps.onFriction?.({
      blocking: true,
      category: step.checks.some(
        (check) =>
          check.status === 'fail' &&
          /\bexited\b|could not run/.test(check.detail),
      )
        ? 'command_failed'
        : 'other',
      detail: `Step check: step ${step.number} still failed its checks after ${step.fixes} fix${
        step.fixes === 1 ? '' : 'es'
      } by the agent, so Freebuff marked it blocked.`,
      step: step.number,
    })
  }
  return { state, result }
}

/** What the agent reads when a step's checks failed. */
export function sponsoredStepFixPrompt(
  step: SponsoredSkillStep,
  number: number,
  total: number,
  results: readonly SponsoredSkillCheckResult[],
  attempt: number,
  maxAttempts: number,
): string {
  return [
    `Freebuff checked step ${number} of ${total} with code, and it is not done yet.`,
    '',
    `Step ${number}: ${step.title}`,
    ...(step.instructions.trim() ? [step.instructions.trim()] : []),
    '',
    sponsoredSkillCheckFeedback(results),
    '',
    `Work only on step ${number}: do not redo other steps and do not write the final report yet. This is fix ${attempt} of ${maxAttempts} for this step.`,
    'If it cannot pass without something only the user can provide (an account, a key, a login), call report_friction with blocking true and stop instead of working around it.',
  ].join('\n')
}

const STATUS_LINE: Record<SponsoredStepStatus, string> = {
  passed: 'done (its checks passed)',
  blocked: 'NOT done: a check still fails',
  not_reached: 'NOT done: not reached, an earlier step is blocked',
  needs_user: 'needs the user',
}

/**
 * The run's last prompt after any fixes: the report it writes has to match
 * what the checks found, not what the model remembers trying.
 */
export function sponsoredStepReportPrompt(
  result: SponsoredStepDriveResult,
): string {
  return [
    'Freebuff has now checked every step of the procedure with code:',
    ...result.steps.map(
      (step) => `- Step ${step.number}: ${STATUS_LINE[step.status]}`,
    ),
    '',
    'Make no more changes. Write your final report in the format the task asked for. Report a step as done only if it is done above; for each step that is not, say plainly what is still needed.',
  ].join('\n')
}

/** One operator line: the tally, then each step that is not done. */
export function sponsoredStepDiagnostic(
  result: SponsoredStepDriveResult,
): string {
  const open = result.steps.filter(
    (step) => step.kind !== 'user' && step.status !== 'passed',
  )
  const done = result.steps.filter((step) => step.status === 'passed').length
  const head = `step checks (${result.skill}): ${done}/${result.steps.length} ok after ${result.fixes} fix${result.fixes === 1 ? '' : 'es'}${
    result.stoppedBecause ? ` (stopped: ${result.stoppedBecause})` : ''
  }`
  return [
    head,
    ...open.map((step) => `step ${step.number} ${step.status}`),
  ].join('; ')
}

/**
 * The run card's step states, from the checks: passed is `done`, a user step
 * is `needs_you`, and anything else is still `pending`, because the card may
 * only say done when it is.
 */
export function sponsoredStepCardStates(
  result: SponsoredStepDriveResult,
): Array<{ text: string; state: 'done' | 'needs_you' | 'pending' }> {
  return result.steps.map((step) => ({
    text: step.title,
    state:
      step.status === 'passed'
        ? 'done'
        : step.status === 'needs_user'
          ? 'needs_you'
          : 'pending',
  }))
}
