/**
 * What an accepted Agentic Ads Lab run is told, and what its mid-run account
 * step answers. The lab exists to predict production sponsored runs, so these
 * are MIRRORED from Desktop, sentence for sentence wherever the sentence
 * holds in a Cloud VM:
 *
 *  - the turn prompt from `freebuff-desktop/src/server/services/sponsored-run.ts`
 *    (`buildSponsoredPrompt`, `SPONSORED_TASK_FRAMING`, ...),
 *  - the system prompt sections from
 *    `freebuff-desktop/src/server/harness/sponsored-agent.ts`,
 *  - the account step's questions and notes from
 *    `freebuff-desktop/src/server/services/sponsored-signup.ts`.
 *
 * `web/src/server/desktop-cloud/lab-sponsored-parity.test.ts` reads those
 * files as text and fails when a mirrored string stops matching, the way
 * the CLI's mirror is pinned (`cli/src/utils/sponsored-agent.ts`).
 *
 * The system prompt sections are APPENDED to base3's, never substituted for
 * it, as the CLI does: a lab run is an ordinary free-mode request on the
 * tester's session, and the completions route checks that its root prompt
 * opens with base3's text (`FREEBUFF_ROOT_SYSTEM_PROMPT_OPENINGS`,
 * `web/src/llm-api/root-prompt-shape.ts`). Desktop's sponsored agent opens
 * with its own sentence only because its requests go to the sponsored compute
 * route instead.
 */
import { TURN_ENDING_RULE } from '../constants/turn-ending-rule'
import { sponsoredProcedurePrompt } from './sponsored-procedure-inputs'
import {
  SPONSORED_RUN_CONTEXT_HEADING,
  SPONSORED_RUN_DEFERRED_SIGNUP_CREDENTIALS,
  SPONSORED_RUN_DEFERRED_SIGNUP_LINK,
  SPONSORED_RUN_LOCKFILE_RESTORE_COMMANDS,
  SPONSORED_RUN_NO_KEYS_IN_CHAT_BULLET,
  SPONSORED_RUN_RESULT_REPORT,
  SPONSORED_RUN_SCOPE_GUIDANCE,
  SPONSORED_RUN_TASK_FRAMING,
  SPONSORED_RUN_WEB_GUIDANCE,
} from './sponsored-run-prompt'

import type { SponsoredProcedureRuntimeInputs } from './sponsored-procedure-inputs'

import type { SponsoredRunCredential } from './sponsored-run-credentials'

// ---------------------------------------------------------------- turn prompt
//
// The sentences are the canonical run prompt's (`./sponsored-run-prompt.ts`),
// which is Desktop's; these names stay for the Lab and the legacy CLI.

/** MIRRORED: Desktop's `SPONSORED_TASK_FRAMING`. */
export const LAB_SPONSORED_TASK_FRAMING = SPONSORED_RUN_TASK_FRAMING

/** MIRRORED: Desktop's `SPONSORED_CONTEXT_HEADING`. */
export const LAB_SPONSORED_CONTEXT_HEADING = SPONSORED_RUN_CONTEXT_HEADING

/** MIRRORED: Desktop's `SPONSORED_SCOPE_GUIDANCE`, report_friction included. */
export const LAB_SPONSORED_SCOPE_GUIDANCE = SPONSORED_RUN_SCOPE_GUIDANCE

/** MIRRORED: Desktop's `SPONSORED_RESULT_REPORT`. */
export const LAB_SPONSORED_RESULT_REPORT = SPONSORED_RUN_RESULT_REPORT

/** MIRRORED: Desktop's deferred account step with a tracked signup link (COD-827). */
export const LAB_DEFERRED_SIGNUP_LINK = SPONSORED_RUN_DEFERRED_SIGNUP_LINK

/** MIRRORED: Desktop's deferred account step for a credential-only campaign (COD-827). */
export const LAB_DEFERRED_SIGNUP_CREDENTIALS =
  SPONSORED_RUN_DEFERRED_SIGNUP_CREDENTIALS

/** MIRRORED: Desktop's `SPONSORED_NO_KEYS_IN_CHAT_BULLET`. */
export const LAB_NO_KEYS_IN_CHAT_BULLET = SPONSORED_RUN_NO_KEYS_IN_CHAT_BULLET

/**
 * Commands that restore a project's existing dependencies from its lockfile,
 * and nothing else (`SPONSORED_RUN_LOCKFILE_RESTORE_COMMANDS`).
 */
export const LAB_LOCKFILE_RESTORE_COMMANDS =
  SPONSORED_RUN_LOCKFILE_RESTORE_COMMANDS

/** Whether `command` is exactly one lockfile restore, spacing aside. */
export function isLabLockfileRestore(command: string): boolean {
  return LAB_LOCKFILE_RESTORE_COMMANDS.has(
    command.trim().split(/\s+/).join(' '),
  )
}

/**
 * "How to carry it out here": Desktop's in-place rules, because a lab run,
 * like an in-place one, delivers uncommitted edits, for where it runs
 * (`SPONSORED_RUN_WEB_GUIDANCE`).
 */
export const LAB_SPONSORED_GUIDANCE = SPONSORED_RUN_WEB_GUIDANCE

/** The newest user messages a run is given as background, as Desktop bounds them. */
export const LAB_TASK_CONTEXT_MAX_MESSAGES = 8
export const LAB_TASK_CONTEXT_MAX_CHARS = 8_192

/**
 * The chat's own user messages, oldest first, bounded the way Desktop's
 * `sponsoredTaskEvidence` bounds them: at most eight, whole messages up to
 * 8,192 characters, and only the newest cut (head and tail) when it alone
 * exceeds the budget.
 */
export function labTaskContext(messages: readonly string[]): string[] {
  const recent = messages
    .filter((message) => message.trim().length > 0)
    .slice(-LAB_TASK_CONTEXT_MAX_MESSAGES)
  const context: string[] = []
  let chars = 0
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const message = recent[index]!
    if (chars + message.length > LAB_TASK_CONTEXT_MAX_CHARS) {
      if (context.length === 0) context.unshift(excerpt(message))
      break
    }
    context.unshift(message)
    chars += message.length
  }
  return context
}

/** Desktop's `excerptTaskMessage`: tail-weighted, the cut marked in the text. */
function excerpt(text: string, max = LAB_TASK_CONTEXT_MAX_CHARS): string {
  if (text.length <= max) return text
  const marker = (omitted: number) =>
    ` [… ${omitted.toLocaleString('en-US')} characters omitted] `
  const keep = Math.max(0, max - marker(text.length).length)
  let head = Math.floor(keep * 0.4)
  let tail = keep - head
  if (/[\ud800-\udbff]/.test(text.charAt(head - 1))) head -= 1
  if (/[\udc00-\udfff]/.test(text.charAt(text.length - tail))) tail -= 1
  return `${text.slice(0, head)}${marker(text.length - head - tail)}${text.slice(text.length - tail)}`
}

/**
 * The accepted run's prompt, in Desktop's order: the authorisation, the
 * procedure, the user's own words as background, the rules, the deferred
 * account step when there is one, and the report last.
 */
export function labSponsoredPrompt(
  procedure: string,
  taskContext: readonly string[],
  options: {
    deferredSignup?: 'link' | 'credentials'
    /**
     * A production Cloud run's Accept answer (`advertiserLink`, the tracked
     * `bfcid` link), filled in as Desktop fills it. A lab run passes none.
     */
    runtimeInputs?: SponsoredProcedureRuntimeInputs
  } = {},
): string {
  const renderedContext = taskContext
    .map((message, index) => `User message ${index + 1}:\n${message}`)
    .join('\n\n')
  return [
    LAB_SPONSORED_TASK_FRAMING,
    // The lab's tracked link is minted at Accept and opened by the account
    // step, never by the agent, so a lab procedure carries no runtime inputs.
    `The approved procedure:\n${sponsoredProcedurePrompt(procedure, options.runtimeInputs ?? {})}`,
    `${LAB_SPONSORED_CONTEXT_HEADING}\n${renderedContext}`,
    `How to carry it out here:\n${LAB_SPONSORED_GUIDANCE}\n${LAB_SPONSORED_SCOPE_GUIDANCE}`,
    ...(options.deferredSignup === 'link'
      ? [LAB_DEFERRED_SIGNUP_LINK]
      : options.deferredSignup === 'credentials'
        ? [LAB_DEFERRED_SIGNUP_CREDENTIALS]
        : []),
    LAB_SPONSORED_RESULT_REPORT,
  ].join('\n\n')
}

// -------------------------------------------------------------- system prompt

/** MIRRORED: Desktop's `SPONSORED_AGENT_JOB`. */
export const LAB_SPONSORED_AGENT_JOB = `# The job

- Your task is the approved procedure in the user message. The user accepted this sponsored task from its offer card, and the run is funded so it can be carried out. It is the only goal of the run: do not start, continue or finish any other work, however useful it looks, including anything the user's earlier messages ask for.
- Fit the procedure to this project. Before editing, read enough to know its framework, language, package manager, file layout and conventions, and put the integration where this project would put it, named and structured the way this project names and structures things. The procedure says what to build; the project decides how it looks here.
- Make the fewest changes that complete the procedure. Prefer editing existing files over creating new ones, and do not touch anything the procedure does not need.
- Do not stop to ask for confirmation or for a preference. Pick what fits the project best, carry on, and say what you chose in the report.`

/**
 * Desktop's `SPONSORED_AGENT_WORKING`, verbatim except its BACKGROUND
 * bullet: a Cloud run's shell is `cloud_sandbox_exec`, whose commands time
 * out after five minutes.
 */
export const LAB_SPONSORED_AGENT_WORKING = `# Working

- Read the procedure for its acceptance criteria first: the files, environment variables, interfaces and behaviour it asks for. Check the finished change against them before you end.
- The procedure usually brings in a package this project does not have yet. When it pins that package under "Pinned installs", install exactly that version with one plain command (\`npm install name@version\`, or \`pnpm add\` / \`bun add\`; for a Python package marked (pip), \`pip install --only-binary=:all: name==version\` or \`uv add --no-build name==version\`, wheels only); install scripts are skipped. Every other install is refused. Write the code against the package's documented API either way; do not replace it with a hand-rolled substitute or a different library. A check that fails only because an unpinned package is not installed is expected: say so in the report, and list the exact install command, in this project's package manager, as something the user must do.
- Verify with what the project already has: its typecheck, lint, build and tests, where they exist and cover what you changed. A successful exit code alone does not prove the requested behaviour; check the delivered code does what the procedure asks.
- Fix the cause of any other failing check. Do not skip tests, weaken assertions, swallow errors, or add type or lint suppressions to make a check pass. After a fix, rerun the affected checks: earlier passes do not cover later edits. When piping test or build output, preserve the command's exit status, and read the failure output.
- Report checks that failed or could not run as exactly that, never as passes.
- Commands run through cloud_sandbox_exec and stop after five minutes. Start dev servers and long jobs in the background with nohup and a log file, check the log for readiness, and confirm they are still running when you rely on them.
- Do not run destructive or hard-to-undo commands: deleting files or data you did not create, resets, force operations. Run a deploy, migration or publish against a live service only when the procedure asks for that step.
- Keep prose short: the user is watching a live transcript.
- ${TURN_ENDING_RULE}`

/**
 * MIRRORED: Desktop's `SPONSORED_AGENT_INSTALL_TOOL_BULLET` (COD-965): the
 * install bullet for a run that has `install_package`, in place of
 * {@link LAB_SPONSORED_AGENT_WORKING}'s shell-install one.
 */
export const LAB_SPONSORED_AGENT_INSTALL_TOOL_BULLET =
  '- The procedure usually brings in a package this project does not have yet. Install it with the install_package tool: the ecosystem, the name, and the exact version when the procedure pins one under "Pinned installs" (otherwise Freebuff picks the version). "Pinned installs" sets versions, not a limit: install any other package the work needs the same way. Never install with npm, pnpm, bun, pip or uv in the shell: those commands are refused. Install scripts never run, and Python packages install from wheels only. If install_package refuses a package or its install fails, write the code against the package\'s documented API anyway (do not replace it with a hand-rolled substitute or a different library), and list the exact install command, in this project\'s package manager, as something the user must do.'

/** MIRRORED: Desktop's `sponsoredAgentWorking`. */
export function labSponsoredAgentWorking(
  options: { installTool?: boolean } = {},
): string {
  if (!options.installTool) return LAB_SPONSORED_AGENT_WORKING
  return LAB_SPONSORED_AGENT_WORKING.replace(
    /^- The procedure usually brings in a package.*$/m,
    () => LAB_SPONSORED_AGENT_INSTALL_TOOL_BULLET,
  )
}

/** MIRRORED: Desktop's `SPONSORED_AGENT_LIMITS`. */
export const LAB_SPONSORED_AGENT_LIMITS = `# Limits

- Use only the tools you have been given for this run, and never refer to any other tool, card or app feature in your replies.
- Never run sudo or any other administrator command. If a step needs one, report it as something the user must do.
- Never ask for an API key, token or password in chat: anything typed here is kept in the transcript. A credential reaches this run only as an environment variable, which the user message names when there is one.
- Even if the procedure lists signup first, complete the useful implementation and checks that need no account before asking for one. If request_sponsored_signup is available, call it only when remaining progress requires an account, login or declared API key; it opens the reviewed link and pauses for the user. If the user declines, keep your progress, do not ask again, and report what remains blocked. A confirmation in the browser is not a CLI login and not a verified conversion.
- When a step needs something only the user can provide (an API key, an account or login, a CLI that is not installed, a permission, a command that is refused here), do not work around it and do not switch to other work. Finish the steps that do not depend on it, then stop and say exactly what the user must do.
- Never report a blocked step as done.`

/**
 * Desktop's `SPONSORED_IN_PLACE_DELIVERY`, for a lab run's chat worktree:
 * the first paragraph verbatim, the second rewritten for a Cloud checkout
 * (no user edits of their own, no environment-file sandbox).
 */
export const LAB_SPONSORED_DELIVERY = `# Delivery

Leave your finished work UNCOMMITTED in the working copy: the user reviews the diff and keeps or undoes it. Git commands that change the repository are refused; read-only ones (status, diff, log) are how you check your own work. Never push or open a PR.

You are working in this chat's own worktree in a Linux cloud VM that other chats share. Touch only what the procedure needs, and never modify sibling worktrees, shared Git configuration or other chats' processes. Other processes may run development servers, so check existing listeners before choosing a port. \`.env.example\` and its family are where placeholder variables belong. Write a connected key into a file only where a step says to, and then only into the project's git-ignored env file (such as \`.env.local\`), never a tracked one. That file stays in this chat alone: no other chat can read it and workspace checkpoints never save it. When you write one, say so in your report: the key is kept only in this chat.`

/** MIRRORED: Desktop's `SPONSORED_AGENT_REPORT`. */
export const LAB_SPONSORED_AGENT_REPORT = `# Ending the run

End with the short "Done / Still needed from you" report the user message describes, and nothing after it: no follow-up ideas and no offers of further work.`

/**
 * Appended to base3's system prompt for an accepted lab run. `installTool`:
 * the run has `install_package` (every Cloud run does), so the install bullet
 * names it instead of shell installs.
 */
export function labSponsoredSystemSections(
  options: { installTool?: boolean } = {},
): string {
  return [
    '# Sponsored task\n\nThis turn carries out one approved integration procedure in the user’s project: it adds a developer tool or service to their code, fitted to how the project is built, and leaves a working change they can review. The rules below are this turn’s and win over any general instruction above where they differ.',
    LAB_SPONSORED_AGENT_JOB,
    labSponsoredAgentWorking(options),
    LAB_SPONSORED_AGENT_LIMITS,
    LAB_SPONSORED_DELIVERY,
    LAB_SPONSORED_AGENT_REPORT,
  ].join('\n\n')
}

// --------------------------------------------------------------- account step

/** MIRRORED: the answers Desktop's account-step questions offer. */
export const LAB_SIGNUP_YES = 'I’m signed in'
export const LAB_SIGNUP_NO = 'Not now'
/** MIRRORED: the descriptions of Desktop's sign-in answers. */
export const LAB_SIGNUP_YES_DESCRIPTION = 'Continue connecting your project.'
export const LAB_SIGNUP_NO_DESCRIPTION =
  'Keep the work so far. Leave the account connection for later.'
export const LAB_INSTANT_SETUP_YES = 'Yes, set it up'
export const LAB_INSTANT_SETUP_NO = 'No, I’ll sign up myself'
export const LAB_PREFILL_YES = 'Yes, fill in my email'
export const LAB_PREFILL_NO = 'No, I’ll type it'

/** MIRRORED: the sentence Desktop's sign-in question adds when a key follows. */
export const LAB_SIGNIN_CONNECT_NEXT =
  ' Next, I’ll ask you to connect your API key securely.'

/** MIRRORED: Desktop's sign-in question. */
export function labSignInQuestion(
  advertiserName: string,
  connectNext = false,
): string {
  return `Sign in to ${advertiserName} in the tab I opened so I can finish your free setup. Create an account if you don’t have one. Keep that tab open when you’re done.${connectNext ? LAB_SIGNIN_CONNECT_NEXT : ''}`
}

/** MIRRORED: Desktop's Instant setup question (COD-830). */
export function labInstantSetupQuestion(
  advertiserName: string,
  email: string,
): string {
  return `${advertiserName} can create your account and an API key for this task, with no sign-up. Freebuff will send ${email} to them to do it.`
}

/** MIRRORED: Desktop's `{email}` prefill question (COD-830). */
export function labPrefillQuestion(
  advertiserName: string,
  email: string,
): string {
  return `Fill in ${email} on the ${advertiserName} sign-up page? This shares your email with them before you sign up.`
}

/**
 * How long a lab run waits on its account step. Desktop's question has no
 * timer of its own and waits as long as the run's grant can fund it
 * (COD-828), because the "Needs you" notification brings the user back. A
 * lab run has no grant, so this bounds the worker's wait instead.
 */
export const LAB_SIGNUP_WAIT_MINUTES = 45

/** MIRRORED: Desktop's `sponsoredCredentialSection` (non-floor). */
export function labCredentialSection(
  credentials: readonly SponsoredRunCredential[],
  status: 'provided' | 'skipped' | 'timeout',
  advertiserName?: string,
): string {
  const account = advertiserName
    ? `their ${advertiserName} account`
    : 'their account'
  if (status === 'provided') {
    return [
      'Credentials:',
      ...credentials.map(
        (credential) =>
          `- The user connected ${account}: \`${credential.env}\` (${credential.label}) is set in the environment of every terminal command in this run. Reference it as \`$${credential.env}\`.`,
      ),
      '- Never print, echo, log or write these values into a file, a commit or your reply, and do not ask the user for them. Command output shows them as `[redacted:NAME]`; that is expected, not an error.',
      '- Because a key is present, SKIP any device-code or browser login the procedure describes: do not start, print or poll a login flow. Authenticate with the environment variable instead (a CLI flag, an Authorization header, or the variable name the tool reads).',
    ].join('\n')
  }
  const why =
    status === 'timeout'
      ? `The user did not connect ${account} when asked`
      : `The user chose not to connect ${account}`
  return [
    'Credentials:',
    `- ${why}, so ${credentials.map((credential) => `\`${credential.env}\``).join(' and ')} ${credentials.length === 1 ? 'is' : 'are'} NOT set.`,
    '- Do every part of the procedure that needs no account. Do not ask for the key in the conversation, and do not start a device-code or browser login that nobody is here to approve.',
    '- In your final message, name the step that still needs the account as something the user has to finish, and say exactly which variable it expects.',
  ].join('\n')
}

/** MIRRORED: the notes Desktop's `SponsoredSignupHandoff` answers the tool with. */
export const LAB_SIGNUP_DECLINED_NOTE =
  'Sign-in or the credential was declined, skipped, or expired. Do not ask again or open another signup link. Keep the work so far, finish every remaining step that does not need the account, and end with an honest summary of the completed work and the account step the user still has to do.'
export const LAB_SIGNUP_NO_STEP_NOTE =
  'This sponsored run has no account step. Report the account-dependent steps as blocked.'
export const LAB_SIGNUP_STOPPED_NOTE = 'This sponsored run has stopped.'

export function labSignInConfirmedNote(credentialNote: string): string {
  return `The user confirmed browser sign-in. Do not repeat signup. This is not a verified conversion and does not authenticate a CLI. ${credentialNote || 'Use only credentials explicitly provided for this run; leave any further interactive authentication as a user action.'}`
}

export function labConnectedNote(credentialNote: string): string {
  return `The user connected their account for this run. Do not ask again. ${credentialNote}`
}

export function labInstantSetupNote(credentialNote: string): string {
  return `Instant setup created the user's account and API key; there is no sign-up step. Do not open a signup link. ${credentialNote}`
}

/** MIRRORED: Desktop's `request_sponsored_signup` description, for a browser tab. */
export const LAB_SIGNUP_TOOL_DESCRIPTION =
  'Ask the user for this sponsored offer’s account: open the reviewed signup/sign-in link in a browser tab and/or show a secure form for the declared credentials, then pause for the user. Complete useful implementation and checks that do not require an account first. Call only when further progress requires authentication or the credential. The app supplies the URL, question and form; this tool takes no arguments. A decline means preserve the work and report what remains blocked, without asking again.'
