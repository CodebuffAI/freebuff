import z from 'zod/v4'

import { $getNativeToolCallExampleString, jsonToolResultSchema } from '../utils'

import type { $ToolParams } from '../../constants'

/**
 * Ceiling on a model-chosen SYNC command timeout.
 *
 * The value came straight from the model to the client with nothing in between
 * — no clamp anywhere in the runtime — and the only guidance was "Default 30".
 * In practice models picked 3-minute, 10-minute and 50-minute budgets for work
 * that finishes in seconds, and the cost of an over-long value is paid entirely
 * by the user: when the command does hang, they wait the whole budget watching
 * nothing happen.
 *
 * 10 minutes is above any legitimate SYNC command we ship (the longest bundled
 * agent budget is the librarian's 180s `git clone`) while cutting the tail that
 * makes a hang indistinguishable from a freeze. Genuinely open-ended work has
 * two better doors that this does not touch: `-1` for an explicit indefinite
 * wait, and `process_type: BACKGROUND` for long-running processes.
 */
export const MAX_TERMINAL_TIMEOUT_SECONDS = 600
export const MAX_TERMINAL_TIMEOUT_MINUTES = MAX_TERMINAL_TIMEOUT_SECONDS / 60

/** Clamp a model-supplied timeout, preserving the -1 "no timeout" sentinel and
 *  leaving an absent value to the schema default. */
export function clampTerminalTimeoutSeconds(
  seconds: number | undefined,
): number | undefined {
  if (seconds === undefined) return undefined
  if (seconds === -1) return -1
  if (!Number.isFinite(seconds)) return MAX_TERMINAL_TIMEOUT_SECONDS
  // A zero or negative value other than -1 is nonsense rather than a request
  // for a short wait; fall back to the default instead of failing instantly.
  if (seconds <= 0) return 30
  return Math.min(seconds, MAX_TERMINAL_TIMEOUT_SECONDS)
}

export const terminalCommandOutputSchema = z.union([
  z.object({
    command: z.string(),
    processId: z.number(),
    backgroundProcessStatus: z.enum(['running', 'completed', 'error']),
    stdoutPath: z.string().optional(),
    stderrPath: z.string().optional(),
    message: z.string().optional(),
  }),
  z.object({
    command: z.string(),
    startingCwd: z.string().optional(),
    message: z.string().optional(),
    stderr: z.string().optional(),
    stdout: z.string().optional(),
    exitCode: z.number().optional(),
  }),
  z.object({
    command: z.string(),
    startingCwd: z.string().optional(),
    message: z.string().optional(),
    stderr: z.string().optional(),
    stdoutOmittedForLength: z.literal(true),
    exitCode: z.number().optional(),
  }),

  z.object({
    command: z.string(),
    errorMessage: z.string(),
  }),
])

/**
 * The commit guidance, with or without the agent attribution trailer.
 *
 * `attribution: false` exists for ONE caller shape: a run whose commit lands in
 * somebody else's repository on somebody else's behalf. Today that is a
 * sponsored proposal — an advertiser-authored change, committed on a branch in
 * a user's own checkout, delivered through a pull request whose body already
 * says where it came from. A `Co-Authored-By` line there attributes the change
 * to us in a stranger's history, on a change we did not author, redundantly.
 *
 * Suppressed in the TOOL DESCRIPTION rather than by adding a "do not add a
 * trailer" bullet to the run's prompt, because this description ships a worked
 * `git commit` example containing the trailer, and a prose instruction losing
 * to a concrete example is the ordinary failure here. The variant removes the
 * footer step and the example both.
 *
 * Both variants share the same task-authorization guidance. This option only
 * changes commit attribution.
 */
export function buildGitCommitGuidePrompt(options: {
  attribution: boolean
}): string {
  return GIT_COMMIT_GUIDE_HEAD.concat(
    options.attribution ? GIT_COMMIT_ATTRIBUTION_STEP : GIT_COMMIT_PLAIN_STEP,
    GIT_COMMIT_GUIDE_TAIL,
  )
}

const GIT_COMMIT_ATTRIBUTION_STEP = `4. **Create the commit, ending with this specific footer:**
   \`\`\`
   Generated with Codebuff 🤖
   Co-Authored-By: Codebuff <noreply@codebuff.com>
   \`\`\`
   Commands run in bash on every OS (Git Bash on Windows), so always use HEREDOC syntax to format the message:
   \`\`\`
   git commit -m "$(cat <<'EOF'
   Your commit message here.

   🤖 Generated with Codebuff
   Co-Authored-By: Codebuff <noreply@codebuff.com>
   EOF
   )"
   \`\`\``

const GIT_COMMIT_PLAIN_STEP = `4. **Create the commit.** Do NOT add any trailer, footer, co-author line or attribution of any kind to the commit message — no \`Co-Authored-By\`, no "Generated with" line. The message is the message and nothing else.
   Commands run in bash on every OS (Git Bash on Windows), so always use HEREDOC syntax to format the message:
   \`\`\`
   git commit -m "$(cat <<'EOF'
   Your commit message here.
   EOF
   )"
   \`\`\``

const GIT_COMMIT_GUIDE_HEAD = `
### Using git to commit changes

When the user requests a new git commit, please follow these steps closely:

1. **Run two run_terminal_command tool calls:**
   - Run \`git diff\` to review both staged and unstaged modifications.
   - Run \`git log\` to check recent commit messages, ensuring consistency with this repository's style.

2. **Select relevant files to include in the commit:**
   Use the git context established at the start of this conversation to decide which files are pertinent to the changes. Stage any new untracked files that are relevant, but avoid committing previously modified files (from the beginning of the conversation) unless they directly relate to this commit.

3. **Analyze the staged changes and compose a commit message:**
   Enclose your analysis in <commit_analysis> tags. Within these tags, you should:
   - Note which files have been altered or added.
   - Categorize the nature of the changes (e.g., new feature, fix, refactor, documentation, etc.).
   - Consider the purpose or motivation behind the alterations.
   - Refrain from using tools to inspect code beyond what is presented in the git context.
   - Evaluate the overall impact on the project.
   - Check for sensitive details that should not be committed.
   - Draft a concise, one- to two-sentence commit message focusing on the “why” rather than the “what.”
   - Use precise, straightforward language that accurately represents the changes.
   - Ensure the message provides clarity—avoid generic or vague terms like “Update” or “Fix” without context.
   - Revisit your draft to confirm it truly reflects the changes and their intention.

`

const GIT_COMMIT_GUIDE_TAIL = `

**Important details**

- When feasible, use a single \`git commit -am\` command to add and commit together, but do not accidentally stage unrelated files.
- Change git configuration only when the task requires it; prefer repository-local settings.
- Push to the remote repository only when the user has authorized pushing.
- Avoid using interactive flags (e.g., \`-i\`) that require unsupported interactive input.
- Do not create an empty commit if there are no changes.
- Make sure your commit message is concise yet descriptive, focusing on the intention behind the changes rather than merely describing them.
`

/** The default commit guidance, including attribution. */
export const gitCommitGuidePrompt = buildGitCommitGuidePrompt({
  attribution: true,
})

const toolName = 'run_terminal_command'
const endsAgentStep = true
const inputSchema = z
  .object({
    // Can be empty to use it for a timeout.
    command: z
      .string()
      .min(1, 'Command cannot be empty')
      .describe(
        `CLI command. Always executed with bash (Git Bash on Windows), so use POSIX syntax on every OS: \`mv\`/\`rm\`, \`/dev/null\`, heredocs. Never use cmd.exe syntax like \`del\`, \`move\`, or \`> nul\` — on Windows \`> nul\` creates a literal file named "nul" that is very hard to delete.`,
      ),
    process_type: z
      .enum(['SYNC', 'BACKGROUND'])
      .default('SYNC')
      .describe(
        `Either SYNC (waits, returns output) or BACKGROUND (runs in background). Default SYNC`,
      ),
    cwd: z
      .string()
      .optional()
      .describe(
        `The working directory to run the command in. Default is the project root.`,
      ),
    timeout_seconds: z
      .number()
      .default(30)
      .optional()
      .transform(clampTerminalTimeoutSeconds)
      .describe(
        `How long to wait, in seconds. Default 30, which is right for almost everything — omit this field unless the command genuinely runs longer. Budget for the command you are actually running (a typecheck or test run is tens of seconds, not minutes); an over-long value does not make a command safer, it just means you wait that long when something hangs. Values above ${MAX_TERMINAL_TIMEOUT_SECONDS} (${MAX_TERMINAL_TIMEOUT_MINUTES} minutes) are clamped. Set to -1 to wait indefinitely, for genuinely open-ended commands only. Does not apply for BACKGROUND commands — use those for long-running processes instead.`,
      ),
  })
  .describe(
    `Execute a CLI command from the **project root** (different from the user's cwd).`,
  )
const buildDescription = (options: { attribution: boolean }) =>
  `
Execute commands needed to complete the user's task, including inspecting the environment, running scripts, installing task dependencies, building, testing, generating requested artifacts, and starting required services.

Authorization:
- The user's request authorizes the ordinary steps reasonably necessary to complete it. Carry that authorization through the task; do not ask again just because a step uses a script, creates a virtual environment, installs local dependencies, or starts a task-required process.
- Work on the paths and environment specified by the task. An explicitly requested output path can be outside the project root; do not treat that alone as a reason to stop or ask permission. Keep unrelated files and systems untouched, and prefer project-local dependencies and configuration.
- Ask only when a necessary action goes beyond the authorized scope or has significant destructive, external, or hard-to-undo effects that the user has not authorized. A coding request alone does not authorize publishing, pushing, deploying, modifying production data, deleting unrelated data, or changing system-wide settings. Honor authorization already given for a specific action.
- Follow explicit user restrictions and host execution limits. If a tool refuses an action, respect the refusal; do not bypass it. In unattended runs, complete the authorized work without inventing a permission exchange. If genuinely blocked on authorization, report the blocker without claiming success.

Execution:
- Inspect unfamiliar scripts or commands enough to understand their effects before running them. Use the project's package manager and the narrowest command that accomplishes the task.
- Prefer the file-editing tools for source changes. Running a script or build that generates the requested artifacts is allowed.
- Use non-interactive flags such as --yes when appropriate for an already-authorized operation; they do not expand its authorization.
- Use bash syntax on every OS (Git Bash on Windows), including mv/rm and /dev/null.
- Resolve user-provided paths against the intended working directory; set cwd when needed. Commands default to the project root, which can differ from the user's cwd.
- Commands can succeed without producing output. Check exit status and the requested artifacts or behavior before claiming completion.

${buildGitCommitGuidePrompt(options)}

Example:
${$getNativeToolCallExampleString({
  toolName,
  inputSchema,
  input: {
    command: 'echo "hello world"',
  },
  endsAgentStep,
})}

${$getNativeToolCallExampleString({
  toolName,
  inputSchema,
  input: {
    command: options.attribution
      ? `git commit -m "Your commit message here.

🤖 Generated with Codebuff
Co-Authored-By: Codebuff <noreply@codebuff.com>"`
      : `git commit -m "Your commit message here."`,
  },
  endsAgentStep,
})}
    `.trim()

const description = buildDescription({ attribution: true })

/**
 * The `run_terminal_command` description with every agent-attribution trailer
 * removed, for a run that commits into somebody else's repository.
 *
 * Selected per run in `getToolSet`, off the agent definition's
 * `suppressCommitAttribution`. See {@link buildGitCommitGuidePrompt}.
 */
export const runTerminalCommandNoAttributionDescription = buildDescription({
  attribution: false,
})

export const runTerminalCommandParams = {
  toolName,
  endsAgentStep,
  description,
  inputSchema,
  outputSchema: jsonToolResultSchema(terminalCommandOutputSchema),
} satisfies $ToolParams
