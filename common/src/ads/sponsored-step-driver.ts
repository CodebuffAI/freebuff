import { SPONSORED_RUN_SUMMARY_INSTRUCTION } from './sponsored-run-summary'
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
  SPONSORED_SKILL_OS,
  sponsoredSkillDirective,
  sponsoredSkillMatchesProcedure,
  sponsoredSkillPreflightChecks,
  sponsoredSkillSha256,
  type SponsoredSkill,
  type SponsoredSkillCheck,
  type SponsoredSkillOs,
  type SponsoredSkillStep,
} from './sponsored-skill'
import {
  deliveredSponsoredSkillForProcedure,
  deliveredSponsoredSkillForRef,
} from './sponsored-skill-delivery'
import {
  sponsoredRepoFactsFiles,
  sponsoredSkillFactChecksOnly,
  sponsoredStaticCheckContext,
  type SponsoredRepoFacts,
} from './sponsored-skill-fit'
import { resolveSponsoredSkill } from './sponsored-skills/registry'
import {
  evaluateSponsoredSkillChecks,
  sponsoredSkillCheckFeedback,
  type SponsoredSkillCheckContext,
  type SponsoredSkillCheckResult,
} from './sponsored-skill-checks'

import {
  SPONSORED_FRICTION_DETAIL_MAX,
  type SponsoredFrictionInput,
} from './sponsored-run-friction'

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
  stoppedBecause?: 'turn_failed' | 'out_of_time' | 'preflight_failed'
  /**
   * The skill's preflight (and its `requirements.os`), when it failed and so
   * no step ran ({@link runSponsoredSkillPreflight}).
   */
  preflight?: SponsoredSkillCheckResult[]
}

export const SPONSORED_STEP_MAX_FIXES_PER_RUN = 6

/**
 * Where the skill a run drives came from: this build's registry, the server
 * (verified against the consented text or the hash recorded at accept), or
 * nowhere, and then the procedure runs as free text with no step checks.
 */
export type SponsoredSkillSource = 'bundled' | 'server' | 'none'

export type SponsoredSkillSelection =
  | { skill: SponsoredSkill; source: Exclude<SponsoredSkillSource, 'none'> }
  | { skill: null; source: 'none' }

const NO_SKILL: SponsoredSkillSelection = { skill: null, source: 'none' }

/**
 * The skill an accepted procedure names, and where it came from. Only when
 * the text is exactly that skill's rendering: this build's registry first,
 * then the skill the Accept response offered (`offered`, untrusted JSON, held
 * to the procedure by `deliveredSponsoredSkillForProcedure`),
 * else none, and a legacy or unmatched procedure runs as free text.
 */
export function selectSponsoredProcedureSkill(
  procedure: string | null | undefined,
  offered?: unknown,
): SponsoredSkillSelection {
  const directive = sponsoredSkillDirective(procedure)
  if (!directive || !procedure) return NO_SKILL
  const bundled = resolveSponsoredSkill(`${directive.id}@${directive.version}`)
  if (bundled && sponsoredSkillMatchesProcedure(bundled, procedure))
    return { skill: bundled, source: 'bundled' }
  const server = deliveredSponsoredSkillForProcedure(offered, procedure)
  return server ? { skill: server, source: 'server' } : NO_SKILL
}

/**
 * The skill an accepted procedure names, or null (see
 * {@link selectSponsoredProcedureSkill}). Without `offered`, only this
 * build's registry: a skill it does not ship is not driven.
 */
export function sponsoredProcedureSkill(
  procedure: string | null | undefined,
  offered?: unknown,
): SponsoredSkill | null {
  return selectSponsoredProcedureSkill(procedure, offered).skill
}

export type SponsoredRunSkillRef = {
  id: string
  version: string
  sha256: string
}

/**
 * The skill a run record names, held to the hash recorded at accept: the
 * copy stored with the run (`stored`, the verified skill as accepted) first,
 * so a resume never depends on this build's registry; then the registry.
 * Null when neither matches, and then the caller may ask the server
 * (`deliveredSponsoredSkillForRef` on its answer) or run the text undriven.
 */
export function sponsoredRunSkill(
  ref: SponsoredRunSkillRef,
  stored?: unknown,
): SponsoredSkill | null {
  const kept = deliveredSponsoredSkillForRef(stored, ref)
  if (kept) return kept
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
  /** Progress only: the step about to be checked (a UI's "Step 2/4"). */
  onStep?: (step: SponsoredStepProgress) => void
}

/** Which step the driver is on, for a progress line. Never affects the walk. */
export type SponsoredStepProgress = {
  number: number
  total: number
  title: string
}

/** `<id>@<version>`, as the registry keys it. */
function skillKey(skill: SponsoredSkill): string {
  return `${skill.id}@${skill.version}`
}

async function check(
  deps: Pick<SponsoredStepDriverDeps, 'ctx' | 'skill'>,
  step: Pick<SponsoredSkillStep, 'checks'>,
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
    try {
      deps.onStep?.({ number, total, title: step.title })
    } catch {
      // Progress is display only; it never stops the walk.
    }
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
  /** Ask for an agent closing summary after checks even when no fixes were needed. */
  alwaysReport?: boolean
  /** Persist checked completion before the optional final report segment. */
  onChecksComplete?: (result: SponsoredStepDriveResult) => void
  /** Progress only (see {@link SponsoredStepDriverDeps.onStep}). */
  onStep?: (step: SponsoredStepProgress) => void
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
  const redact = deps.redact ?? identity
  let state = initial

  const result = await driveSponsoredSkillSteps({
    skill: deps.skill,
    ctx: redactedCheckContext(deps.ctx, redact),
    canContinue: deps.canContinue,
    ...(deps.onStep ? { onStep: deps.onStep } : {}),
    prompt: async (text) => {
      const next = await deps.resume(text, state)
      if (next === null) return false
      state = next
      return true
    },
  })

  deps.onChecksComplete?.(result)

  // The report the user reads must match the checks, not the model's memory
  // of what it tried. Summary-capable clients always request this closing
  // segment; older clients need it only after a fix.
  if ((result.fixes > 0 || deps.alwaysReport) && deps.canContinue()) {
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

const identity = (text: string) => text

/** Command output reaches the agent and the report (COD-665): redacted first. */
function redactedCheckContext(
  ctx: SponsoredSkillCheckContext,
  redact: (text: string) => string,
): SponsoredSkillCheckContext {
  return {
    ...ctx,
    runScript: async (script, timeout) => {
      const out = await ctx.runScript(script, timeout)
      return out === 'missing' ? out : { ...out, output: redact(out.output) }
    },
    runCommand: async (argv, timeout) => {
      const out = await ctx.runCommand(argv, timeout)
      return { ...out, output: redact(out.output) }
    },
  }
}

/** The synthetic check a skill's `requirements.os` becomes in its preflight. */
export const SPONSORED_PREFLIGHT_OS_CHECK_ID = 'requirements-os'

/**
 * `process.platform` as a skill's `requirements.os` names it, or null for a
 * platform it has no name for (the os check is then skipped).
 */
export function sponsoredSkillOs(
  platform: string | null | undefined,
): SponsoredSkillOs | null {
  return (SPONSORED_SKILL_OS as readonly string[]).includes(platform ?? '')
    ? (platform as SponsoredSkillOs)
    : null
}

export type SponsoredSkillPreflightDeps = {
  skill: SponsoredSkill
  /** The same check context the steps are checked over. */
  ctx: SponsoredSkillCheckContext
  /**
   * The `process.platform` of where the checks (and the run's commands) run:
   * the user's machine on Desktop and the CLI, the VM in Cloud. Unknown, or
   * one the skill format has no name for, skips the `requirements.os` check.
   */
  platform: string | null | undefined
  /** Takes the run's credentials out of command output (see {@link SponsoredStepLoopDeps.redact}). */
  redact?: (text: string) => string
  /** The `report_friction` blocker a failed preflight sends, as a blocked step does. */
  onFriction?: (input: SponsoredFrictionInput) => void
}

export type SponsoredSkillPreflightOutcome =
  | { passed: true; checks: SponsoredSkillCheckResult[] }
  | {
      passed: false
      checks: SponsoredSkillCheckResult[]
      /** Names each failed preflight (and a missing path tool's install hint): the run's error. */
      reason: string
      /** The run's step result: no step reached, stopped by the preflight. */
      result: SponsoredStepDriveResult
    }

const PREFLIGHT_DETAIL_CHARS = 200

/** A failed preflight check, as the run's error and friction name it. */
function preflightFailureLine(
  skill: SponsoredSkill,
  failed: SponsoredSkillCheckResult,
): string {
  // One line: the runs' diagnostics keep only an error's first line.
  const oneLine = failed.detail.replace(/\s+/g, ' ').trim()
  const detail =
    oneLine.length > PREFLIGHT_DETAIL_CHARS
      ? `${oneLine.slice(0, PREFLIGHT_DETAIL_CHARS - 1)}…`
      : oneLine
  const declared = sponsoredSkillPreflightChecks(skill).find(
    (
      check,
    ): check is Extract<SponsoredSkillCheck, { kind: 'command_succeeds' }> =>
      check.id === failed.id && check.kind === 'command_succeeds',
  )
  const tool = declared
    ? (skill.tools ?? []).find((candidate) => candidate.name === declared.argv[0])
    : undefined
  const hint =
    tool?.source === 'path'
      ? ` Install \`${tool.name}\`: ${tool.installHint}`
      : ''
  return `"${failed.label}" (${detail}).${hint}`
}

/**
 * THE PREFLIGHT, run before the agent's first turn: the skill's
 * `requirements.os` against the platform the checks run on, then its
 * `preflight` checks through the same evaluator as the steps. On a failure no
 * agent turn runs and nothing is edited: the caller ends the run with
 * `reason`, and it is reported the way a blocked step is (the
 * `report_friction` blocker is sent here; `result` is the step report, every
 * step not reached). An unsupported OS runs no command: the skill's tool
 * check says nothing more on a platform the skill does not support.
 */
export async function runSponsoredSkillPreflight(
  deps: SponsoredSkillPreflightDeps,
): Promise<SponsoredSkillPreflightOutcome> {
  const { skill } = deps
  const checks: SponsoredSkillCheckResult[] = []
  const os = sponsoredSkillOs(deps.platform)
  const supported = skill.requirements?.os ?? []
  if (os && supported.length > 0) {
    const ok = supported.includes(os)
    checks.push({
      id: SPONSORED_PREFLIGHT_OS_CHECK_ID,
      label: `Runs on ${supported.join(' or ')}`,
      status: ok ? 'pass' : 'fail',
      detail: ok
        ? `this run is on ${os}`
        : `this skill supports ${supported.join(', ')}; this run is on ${os}`,
    })
  }
  if (checks.every((result) => result.status !== 'fail')) {
    const outcome = await check(
      { skill, ctx: redactedCheckContext(deps.ctx, deps.redact ?? identity) },
      { checks: sponsoredSkillPreflightChecks(skill) },
    )
    checks.push(...outcome.results)
  }
  const failed = checks.filter((result) => result.status === 'fail')
  if (failed.length === 0) return { passed: true, checks }

  const reason = `Preflight failed before any edit: ${failed
    .map((result) => preflightFailureLine(skill, result))
    .join(' ')}`
  // A wrong OS or a file/package check is the project not fitting the skill;
  // only a command or script check is a missing toolchain.
  const declaredChecks = sponsoredSkillPreflightChecks(skill)
  const toolchainOnly = failed.every((result) => {
    const declared = declaredChecks.find((c) => c.id === result.id)
    return (
      declared?.kind === 'command_succeeds' ||
      declared?.kind === 'script_passes'
    )
  })
  deps.onFriction?.({
    blocking: true,
    category: toolchainOnly ? 'missing_toolchain' : 'project_mismatch',
    // The server keeps the first SPONSORED_FRICTION_DETAIL_MAX characters.
    detail: reason.slice(0, SPONSORED_FRICTION_DETAIL_MAX),
  })
  return {
    passed: false,
    checks,
    reason,
    result: {
      skill: skillKey(skill),
      steps: skill.steps.map((step, index) => ({
        number: index + 1,
        id: step.id,
        title: step.title,
        kind: step.kind,
        status: 'not_reached',
        fixes: 0,
        checks: [],
      })),
      delivered: false,
      fixes: 0,
      stoppedBecause: 'preflight_failed',
      preflight: checks,
    },
  }
}

/**
 * THE PREFLIGHT over repository facts instead of a worktree: the same
 * {@link runSponsoredSkillPreflight} the run calls, on the checks facts can
 * decide (`sponsoredSkillFactChecksOnly`), over the project exactly as the
 * facts show it (`sponsoredRepoFactsFiles`: their files and manifests, and
 * nothing else). No command runs. So where a run would find no manifest or
 * no dependency its preflight needs, this fails the same check, with the
 * same evaluator and label.
 *
 * The offer route holds a Desktop V1 snapshot (`localCapability.framework`,
 * which says only whether a root package.json exists and declares next) to
 * it: docs/freebuff-agentic-ads.md, "Skill fit on the offer route".
 */
export function runSponsoredSkillPreflightOverFacts(input: {
  skill: SponsoredSkill
  facts: SponsoredRepoFacts
  /** The device OS, as `requirements.os` names it; unknown skips that check. */
  platform: string | null | undefined
}): Promise<SponsoredSkillPreflightOutcome> {
  return runSponsoredSkillPreflight({
    skill: sponsoredSkillFactChecksOnly(input.skill),
    ctx: sponsoredStaticCheckContext(sponsoredRepoFactsFiles(input.facts)),
    platform: input.platform,
  })
}

/** The run error's opening, as {@link runSponsoredSkillPreflight} writes it. */
export const SPONSORED_PREFLIGHT_FAILED_PREFIX = 'Preflight failed before any edit:'

/**
 * What a preflight refusal was, read back from its run error (also its
 * SCRUBBED funnel copy, `scrubSponsoredDiagnostic`, which keeps these
 * phrases): `os` when the skill does not support the OS, `fit` when a
 * file or package check refused the project (the skill does not fit it),
 * `command` when only a command or script check failed (a missing
 * toolchain). Null for anything that is not a preflight refusal. The phrases
 * are the evaluator's own details (`sponsored-skill-checks.ts`).
 */
export function sponsoredPreflightRefusalKind(
  text: string | null | undefined,
): 'os' | 'fit' | 'command' | null {
  if (!text) return null
  const lower = text.toLowerCase()
  const at = lower.indexOf(SPONSORED_PREFLIGHT_FAILED_PREFIX.toLowerCase())
  if (at < 0) return null
  const body = lower.slice(at)
  if (/this skill supports [^;]*; this run is on/.test(body)) return 'os'
  if (
    /no file matches |no (?:changed )?file matching .*? contains |no (?:changed )?file matches |, which must not appear|package\.json is missing|package\.json does not declare|declares [a-z0-9_]+=/.test(
      body,
    )
  )
    return 'fit'
  if (/could not run |exited -?(?:\d+|n)\b|has no [a-z]+ script/.test(body))
    return 'command'
  // A preflight refusal whose detail was cut: the project did not pass a
  // check before any edit, which is a fit question first.
  return 'fit'
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
    SPONSORED_RUN_SUMMARY_INSTRUCTION,
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
    ...(result.preflight ?? [])
      .filter((check) => check.status === 'fail')
      .map((check) => `preflight ${check.id} failed`),
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
