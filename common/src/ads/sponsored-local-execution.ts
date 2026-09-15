/**
 * The trust boundary for a sponsored run executing on the USER'S OWN MACHINE.
 *
 * COD-336's decision, as code. `docs/freebuff-sponsored-local-execution.md`
 * "Decision (2026-09-02)" is the prose; this file is the part that is enforced,
 * and the two are meant to be read together.
 *
 * ## Why this is a SEPARATE constant from the Cloud grant
 *
 * `freebuff/web/convex/ads/sponsoredCapabilityPolicy.ts` holds
 * `SPONSORED_V1_GRANT`, which is Cloud's. It stays exactly as it is. This file
 * holds the local grant, and COD-336 acceptance 2 asks for precisely that
 * separation — "one constant per environment, not one shared constant with a
 * comment" — because the two environments differ in a way a comment cannot
 * express: Cloud's blast radius is a disposable Daytona sandbox holding one
 * clone, local's is a developer's laptop, and the local grant is not even
 * constant across operating systems. A shared constant makes the Windows
 * refusal below either reach Cloud (where it is wrong) or fail to reach local
 * (where it is the whole point).
 *
 * ## What actually bounds a local run
 *
 * A capability map bounds the TOOLS. It does not bound a shell. So the grant
 * here is the smaller half of the boundary; the larger half is the process
 * broker in
 * `sdk/src/tools/sponsored-sandbox.ts`, which is what makes `run_commands`
 * grantable at all:
 *
 *   - the floor, every OS: the environment scrubbed to
 *     {@link SPONSORED_LOCAL_ENV_ALLOWLIST}, `HOME`/`USERPROFILE` and `TMPDIR`
 *     redirected into the run's own private directory, `GIT_ASKPASS=echo`,
 *     `GIT_TERMINAL_PROMPT=0`, and cwd plus every write path bound to the
 *     worktree with symlink resolution;
 *   - macOS and Linux: an OS sandbox under that (`sandbox-exec`, bubblewrap);
 *   - Windows: nothing comparable exists, so `run_commands` is DENIED and the
 *     card says so.
 *
 * {@link sponsoredLocalGrant} is therefore a function of the containment that
 * is actually available, never a bare constant read off the module.
 */

import {
  SPONSORED_CAPABILITIES,
  evaluateSponsoredToolCallWithGrant,
  sponsoredToolNamesWithGrant,
  type SponsoredCapability,
  type SponsoredToolDecision,
} from './sponsored-capabilities'

// --------------------------------------------------------------- containment

/**
 * Why a local sponsored run cannot happen on this machine.
 *
 * Three of these are about CONTAINMENT and one is not. `no-consent-bridge`
 * says the machine can contain the run perfectly well and there is nobody
 * here to ask permission — a different fact, with a different fix, which is
 * why it does not share `unsupported-platform`'s sentence.
 */
export type SponsoredLocalUnavailableReason =
  | 'windows-no-containment'
  | 'bubblewrap-missing'
  | 'unsupported-platform'
  | 'no-consent-bridge'
  | 'containment-probe-failed'

export type SponsoredLocalContainment =
  | { available: true; mechanism: 'sandbox-exec' | 'bubblewrap' }
  | { available: false; reason: SponsoredLocalUnavailableReason }

/**
 * What the user is told, per reason.
 *
 * Written for the card rather than for a log: it names the limitation and it
 * does not imply the user did anything wrong or can fix it by retrying. The
 * bubblewrap line is the one exception — that one IS fixable, and saying so is
 * the difference between a refusal and a dead end.
 */
export const SPONSORED_LOCAL_UNAVAILABLE_COPY: Record<
  SponsoredLocalUnavailableReason,
  string
> = Object.freeze({
  'containment-probe-failed':
    'Sponsored tasks cannot start because the workspace sandbox is not working on this machine. No paid task has started.',
  'windows-no-containment':
    'Sponsored tasks can’t run on Windows yet: Freebuff has no way to keep an advertiser’s commands inside the workspace on this operating system.',
  'bubblewrap-missing':
    'Sponsored tasks need bubblewrap (`bwrap`) to stay inside the workspace. Install it and reopen this project to accept.',
  'unsupported-platform':
    'Sponsored tasks can’t run on this operating system: Freebuff has no way to keep an advertiser’s commands inside the workspace here.',
  // NOT a property of the operating system, and it must not borrow the
  // operating system's sentence. `unsupported-platform` used to carry this
  // case too, so a Mac with no desktop shell behind its orchestrator told its
  // user "Sponsored tasks can’t run on this operating system" — false, and
  // unactionable: the containment is right there and working, and what is
  // missing is the window that would ask them. One enum member cannot mean
  // both "this OS has no mechanism" and "there is nobody here to ask",
  // because the first is permanent and the second is fixed by opening the
  // app.
  'no-consent-bridge':
    'Sponsored tasks need the Freebuff desktop app, which is what asks you to approve the task before it runs. Open this project in the app to accept.',
})

/**
 * Which containment this machine has, if any.
 *
 * `bwrapAvailable` is asked of the caller rather than probed here so this stays
 * pure and testable; the SDK broker is the one that looks on disk.
 *
 * **Absent bubblewrap REFUSES rather than falling back to the floor** — open
 * question 3, decided. A fallback would mean the same product on the same OS
 * silently contains or does not contain depending on a package the user has
 * never heard of, and nothing anywhere would say which they got.
 */
export function sponsoredLocalContainment(
  platform: NodeJS.Platform | string,
  options: { bwrapAvailable?: boolean } = {},
): SponsoredLocalContainment {
  if (platform === 'darwin') return { available: true, mechanism: 'sandbox-exec' }
  if (platform === 'linux') {
    return options.bwrapAvailable
      ? { available: true, mechanism: 'bubblewrap' }
      : { available: false, reason: 'bubblewrap-missing' }
  }
  if (platform === 'win32') {
    return { available: false, reason: 'windows-no-containment' }
  }
  return { available: false, reason: 'unsupported-platform' }
}

/**
 * What the orchestrator reports on `GET /api/ad/proposal`, and the card gates
 * its Accept on.
 *
 * A string rather than a boolean because the card has to be able to SAY why:
 * an Accept that is simply missing, with no sentence beside it, reads as a
 * broken card rather than as a limitation.
 */
export type SponsoredLocalAvailability =
  | 'available'
  | `unavailable:${SponsoredLocalUnavailableReason}`

export function sponsoredLocalAvailability(
  containment: SponsoredLocalContainment,
): SponsoredLocalAvailability {
  return containment.available ? 'available' : `unavailable:${containment.reason}`
}

/** The reason inside an `unavailable:<reason>`, or null for `available`. */
export function sponsoredLocalUnavailableReason(
  availability: string,
): SponsoredLocalUnavailableReason | null {
  const reason = availability.startsWith('unavailable:')
    ? availability.slice('unavailable:'.length)
    : null
  return reason !== null && reason in SPONSORED_LOCAL_UNAVAILABLE_COPY
    ? (reason as SponsoredLocalUnavailableReason)
    : null
}

// ------------------------------------------------------------ the branch

/**
 * The ref namespace every branch a local sponsored run commits to lives in.
 *
 * WITHOUT A TRAILING SLASH, because that is the spelling the sandbox grant
 * wants: `sponsoredLinkedWorktreeGrants` writes `refs/heads/<namespace>` and
 * `logs/refs/heads/<namespace>` into the profile, and nothing else under
 * `refs/`. A run whose branch lived outside this namespace could not commit at
 * all, and a namespace widened to `refs` would let one rewrite every branch in
 * the user's repository.
 *
 * SHARED because two surfaces cut these branches and one sandbox grants them.
 * Desktop's `BRANCH_PREFIX`/`BRANCH_NAMESPACE` (`freebuff-desktop/src/server/
 * git/worktree.ts`) are deliberately NOT re-pointed at this constant — that
 * module names every branch the app cuts, sponsored or not, and coupling all
 * of Desktop's isolated-tab naming to an ads module would be the wrong
 * dependency. They are held equal by a parity test on Desktop's side instead,
 * so the two cannot drift without something going red.
 */
export const SPONSORED_LOCAL_BRANCH_NAMESPACE = 'freebuff'

/**
 * A title reduced to something that is legal in a ref.
 *
 * The same algorithm Desktop's `slugify` runs, with the same defaults, because
 * the branch a consent screen NAMES has to be the branch that is cut — and on
 * the CLI the same function has to produce it in two places (the consent, and
 * the `git worktree add`).
 */
export function sponsoredLocalSlug(
  input: string,
  options: { maxLen?: number; fallback?: string } = {},
): string {
  const { maxLen = 50, fallback = 'task' } = options
  const base = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen)
  return base || fallback
}

/** `freebuff/<slug>-<runId>` — the one branch a local sponsored run may write. */
export function sponsoredLocalBranchName(
  titleSlug: string,
  runId: string,
): string {
  return `${SPONSORED_LOCAL_BRANCH_NAMESPACE}/${sponsoredLocalSlug(titleSlug)}-${runId}`
}

// --------------------------------------------------------------- the grant

/**
 * The LOCAL grant, on a machine that has containment.
 *
 * Identical in membership to Cloud's `SPONSORED_V1_GRANT` today, and that is
 * not an accident to be tidied away by sharing one constant: the two are equal
 * because local execution was scoped to be no wider than what already ships,
 * and they are separate so that either can move without moving the other. The
 * two refusals Cloud makes are made here for the same reasons, which local
 * execution does not change:
 *
 *  - no `human_in_loop`: a sponsored run is unattended by construction. On
 *    Desktop the thread is never a send target (COD-397 requirement 2), so an
 *    `ask_user` there is a question nobody is shown and the run stalls until
 *    the turn limit rather than pausing.
 *  - no `delegate`: nothing propagates a per-run restriction into a spawned
 *    agent's template, so a gate a subagent does not inherit is a bypass with
 *    extra steps.
 */
export const SPONSORED_LOCAL_V1_GRANT: ReadonlySet<SponsoredCapability> =
  Object.freeze(
    new Set<SponsoredCapability>([
      'read_workspace',
      'write_workspace',
      'agent_control',
      'run_commands',
      'network',
    ]),
  )

/**
 * The Windows arm, and the arm for any machine whose containment we cannot
 * stand up: option A from the doc, kept as the explicit fallback rather than
 * as an absence. A run holding this can still edit files through the three
 * write tools, which is where the path refusals are load-bearing again.
 *
 * `network` GOES TOO, not only `run_commands`. Dropping the shell alone left
 * exactly the shape Cloud's own rationale excludes — a run that can read the
 * whole checkout and reach any host, with no OS boundary under it and nothing
 * between the two but a tool name. Whatever the argument for accepting egress
 * from a CONTAINED run, it does not survive removing the containment: this is
 * the grant for a machine where a boundary could not be established, and the
 * one capability that turns a read into a disclosure is not one to hand out
 * there.
 *
 * Nothing starts a run with this today — the surface refuses at the Accept.
 * It exists so the refusal is a decision expressed in one place, and so a
 * surface that later offers the degraded run has a grant rather than
 * inventing one.
 */
export const SPONSORED_LOCAL_UNCONTAINED_GRANT: ReadonlySet<SponsoredCapability> =
  Object.freeze(
    new Set(
      [...SPONSORED_LOCAL_V1_GRANT].filter(
        (capability) =>
          capability !== 'run_commands' && capability !== 'network',
      ),
    ),
  )

/**
 * The grant this machine actually hands out.
 *
 * Note that today no uncontained run is ever STARTED — the surface refuses at
 * the Accept, which is the honest thing to do rather than offering a run that
 * cannot execute a command and therefore cannot verify its own change. The
 * uncontained grant exists so that the refusal is a decision expressed in one
 * place, and so that a surface which later chooses to offer the degraded run
 * has a grant to give it rather than inventing one.
 */
export function sponsoredLocalGrant(
  containment: SponsoredLocalContainment,
): ReadonlySet<SponsoredCapability> {
  return containment.available
    ? SPONSORED_LOCAL_V1_GRANT
    : SPONSORED_LOCAL_UNCONTAINED_GRANT
}

export function evaluateSponsoredLocalToolCall(
  toolName: string,
  grant: ReadonlySet<SponsoredCapability> = SPONSORED_LOCAL_V1_GRANT,
): SponsoredToolDecision {
  return evaluateSponsoredToolCallWithGrant(toolName, grant)
}

export function sponsoredLocalToolNames(
  baseToolNames: readonly string[],
  grant: ReadonlySet<SponsoredCapability> = SPONSORED_LOCAL_V1_GRANT,
): string[] {
  return sponsoredToolNamesWithGrant(baseToolNames, grant)
}

/** Re-exported so a local caller never has to reach past this module. */
export { SPONSORED_CAPABILITIES }
export type { SponsoredCapability, SponsoredToolDecision }

// ------------------------------------------------------------- the environment

/**
 * The only environment variables a local sponsored run inherits.
 *
 * AN ALLOWLIST, NEVER A DENYLIST, and that is the whole design. A denylist of
 * `*_TOKEN`/`*_KEY`/`AWS_*` reads as thorough and is not: it says nothing about
 * `GITHUB_OAUTH`, `NPM_CONFIG_//registry.npmjs.org/:_authToken`, or whatever
 * the user's shell exports next week. Everything not on this list is simply
 * absent from the run, so a variable nobody thought about is refused by
 * default rather than admitted by default.
 *
 * `HOME`, `USERPROFILE`, `TMPDIR` and the git prompt suppressors are NOT here
 * because they are not inherited — {@link scrubSponsoredLocalEnv} sets them to
 * values of its own.
 */
export const SPONSORED_LOCAL_ENV_ALLOWLIST: readonly string[] = Object.freeze([
  'PATH',
  'LANG',
  'LC_ALL',
  'TERM',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
])

/**
 * Shapes that must never survive the scrub.
 *
 * Not the mechanism — the allowlist is the mechanism — but the assertion ON
 * the mechanism, run over the scrub's own OUTPUT. The failure this guards is
 * the plausible one: somebody widens the allowlist for a build tool and takes a
 * credential with it. Cheap, and it fails at the boundary rather than in a
 * postmortem.
 */
const CREDENTIAL_ENV_SHAPES: readonly RegExp[] = Object.freeze([
  /(^|_)(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)$/i,
  /(^|_)(API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|SESSION)$/i,
  /^AWS_/i,
  /^GH_|^GITHUB_/i,
  /^NPM_/i,
  /^OPENAI_|^ANTHROPIC_|^GEMINI_/i,
])

export function looksLikeCredentialEnvVar(name: string): boolean {
  return CREDENTIAL_ENV_SHAPES.some((shape) => shape.test(name))
}

/**
 * The complete environment a local sponsored command runs with.
 *
 * PURE: it creates no directories and touches no disk, so it can be asserted
 * on directly (COD-336 acceptance 4). The caller — the SDK broker — is the one
 * that makes `home` and `tmp` exist.
 *
 * `HOME` moving is the single cheapest large win in the whole boundary: with
 * it moved, `~/.ssh`, `~/.gitconfig`, `~/.aws`, `~/.npmrc` and the `gh` token
 * store are all simply not where the run looks, and `GIT_ASKPASS`/
 * `GIT_TERMINAL_PROMPT` stop git asking a human for the credential it can no
 * longer find. `USERPROFILE` is set alongside it because on Windows that is
 * the variable that means `HOME`, and the floor is meant to hold there too.
 */
export function scrubSponsoredLocalEnv(
  source: Record<string, string | undefined>,
  paths: { home: string; tmp: string },
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of SPONSORED_LOCAL_ENV_ALLOWLIST) {
    const value = source[key]
    if (value !== undefined && value !== '') env[key] = value
  }
  env.HOME = paths.home
  env.USERPROFILE = paths.home
  env.TMPDIR = paths.tmp
  env.TEMP = paths.tmp
  env.TMP = paths.tmp
  env.GIT_TERMINAL_PROMPT = '0'
  env.GIT_ASKPASS = 'echo'
  // `--no-verify` on the sponsored commit (COD-336 decision item 7), enforced
  // rather than asked for. The decision is about HOOKS, and a prompt bullet
  // saying "pass --no-verify" is honoured by a cooperative run and by no other
  // kind. `core.hooksPath` through git's own environment config applies to
  // every git invocation the run makes, including the ones it did not tell us
  // about, and it points at a directory under the run's private HOME that we
  // never create -- git finding no hooks directory is exactly the outcome.
  //
  // Both directions of Hole 4 close with this: the user's `pre-commit` does
  // not run against advertiser-authored content, and a hook the run writes
  // does not run against the user here either.
  env.GIT_CONFIG_COUNT = '1'
  env.GIT_CONFIG_KEY_0 = 'core.hooksPath'
  env.GIT_CONFIG_VALUE_0 = `${paths.home}/no-hooks`
  // Belt to the allowlist's braces. See CREDENTIAL_ENV_SHAPES.
  for (const key of Object.keys(env)) {
    if (looksLikeCredentialEnvVar(key)) {
      throw new Error(
        `Sponsored local env would have carried \`${key}\`, which is credential-shaped. Narrow SPONSORED_LOCAL_ENV_ALLOWLIST.`,
      )
    }
  }
  return env
}

// ------------------------------------------------------------------ installs

/**
 * No dependency installs in v1 (COD-336 decision item 5).
 *
 * A PRODUCT refusal, not a sandbox limitation, and it is stated as one so
 * nobody reads a future sandbox as permission to lift it: a procedure that
 * installs is a procedure whose diff the user cannot review, and review of the
 * diff is this channel's actual safety mechanism.
 *
 * What this pattern is and is not — and what it deliberately does not reach
 * — is in `docs/freebuff-sponsored-local-execution.md` §9, which is private.
 * `common` ships to the public repository with its comments, and an account of
 * a matcher's limits belongs where the people maintaining it read it.
 */
const INSTALL_COMMAND =
  /(^|[;&|]\s*)(npm|pnpm|yarn|bun|npx|pip|pip3|poetry|uv|cargo|gem|go|brew|apt|apt-get|dnf|yum|pacman|apk)\s+(?:(?:-\S+|--\S+)\s+)*(install|add|i|ci|get|sync|fetch)\b/i

export function commandInstallsDependencies(command: string): boolean {
  return INSTALL_COMMAND.test(command)
}

export const SPONSORED_LOCAL_INSTALL_REFUSAL =
  'Refusing to install dependencies: a sponsored run may not add packages, because a postinstall script runs outside everything the user reviews. Work with what the repository already has.'
