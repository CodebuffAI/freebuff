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
    processId: z.number(),
    backgroundProcessStatus: z.enum(['running', 'completed', 'error']),
  }),
  z.object({
    command: z.string(),
    errorMessage: z.string(),
  }),
])

// FREEBUFF_MODE is injected for Freebuff builds and read once when this module
// is initialized. Tests can pass an explicit product flag to avoid depending on
// process.env mutation after import.
const isFreebuffBuild = process.env.FREEBUFF_MODE === 'true'

type CommitAttribution = {
  productName: 'Freebuff' | 'Codebuff'
  productDomain: 'freebuff.com' | 'codebuff.com'
}

function getCommitAttribution(isFreebuff: boolean): CommitAttribution {
  return isFreebuff
    ? { productName: 'Freebuff', productDomain: 'freebuff.com' }
    : { productName: 'Codebuff', productDomain: 'codebuff.com' }
}

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
 */
export function buildGitCommitGuidePrompt(options: {
  attribution: boolean
  isFreebuff?: boolean
}): string {
  const commitAttribution = getCommitAttribution(
    options.isFreebuff ?? isFreebuffBuild,
  )

  return GIT_COMMIT_GUIDE_HEAD.concat(
    options.attribution
      ? getGitCommitAttributionStep(commitAttribution)
      : GIT_COMMIT_PLAIN_STEP,
    GIT_COMMIT_GUIDE_TAIL,
  )
}

/** Build the attributed guide for an explicit product, or the current build. */
export function getGitCommitGuidePrompt(isFreebuff?: boolean): string {
  return buildGitCommitGuidePrompt({ attribution: true, isFreebuff })
}

function getGitCommitAttributionStep({
  productName,
  productDomain,
}: CommitAttribution): string {
  return `4. **Create the commit, ending with this specific footer:**
   \`\`\`
   Generated with ${productName} 🤖
   Co-Authored-By: ${productName} <noreply@${productDomain}>
   \`\`\`
   Commands run in bash on every OS (Git Bash on Windows), so always use HEREDOC syntax to format the message:
   \`\`\`
   git commit -m "$(cat <<'EOF'
   Your commit message here.

   🤖 Generated with ${productName}
   Co-Authored-By: ${productName} <noreply@${productDomain}>
   EOF
   )"
   \`\`\``
}

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
- Never alter the git config.
- Do not push to the remote repository.
- Avoid using interactive flags (e.g., \`-i\`) that require unsupported interactive input.
- Do not create an empty commit if there are no changes.
- Make sure your commit message is concise yet descriptive, focusing on the intention behind the changes rather than merely describing them.
`

/** The default guidance for the product that owns the current binary. */
export const gitCommitGuidePrompt = getGitCommitGuidePrompt()

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

type BuildDescriptionOptions = {
  attribution: boolean
  isFreebuff?: boolean
}

const buildDescription = (options: BuildDescriptionOptions) => {
  const { productName, productDomain } = getCommitAttribution(
    options.isFreebuff ?? isFreebuffBuild,
  )

  return `
Stick to these use cases:
1. Typechecking the project or running build (e.g., "npm run build"). Reading the output can help you edit code to fix build errors. If possible, use an option that performs checks but doesn't emit files, e.g. \`tsc --noEmit\`.
2. Running tests (e.g., "npm test"). Reading the output can help you edit code to fix failing tests. Or, you could write new unit tests and then run them.
3. Moving, renaming, or deleting files and directories. These actions can be vital for refactoring requests. Use \`mv\` or \`rm\` (commands run in bash on every OS, including Windows — do not use \`move\`/\`del\`).

Most likely, you should ask for permission for any other type of command you want to run. If asking for permission, show the user the command you want to run using \`\`\` tags and *do not* use the tool call format, e.g.:
\`\`\`bash
git branch -D foo
\`\`\`

DO NOT do any of the following:
1. Run commands that can modify files outside of the project directory, install packages globally, install virtual environments, or have significant side effects outside of the project directory, unless you have explicit permission from the user. Treat anything outside of the project directory as read-only.
2. Run \`git push\` because it can break production (!) if the user was not expecting it. Don't run \`git commit\`, \`git rebase\`, or related commands unless you get explicit permission. If a user asks to commit changes, you can do so, but you should not invoke any further git commands beyond the git commit command.
3. Run scripts without asking. Especially don't run scripts that could run against the production environment or have permanent effects without explicit permission from the user.
4. Be careful with any command that has big or irreversible effects. Anything that touches a production environment, servers, the database, or other systems that could be affected by a command should be run with explicit permission from the user.
5. Use the run_terminal_command tool to create or edit files. Do not use \`cat\` or \`echo\` to create or edit files. You should instead use other tools for creating or editing files.
6. Use the wrong package manager for the project. For example, if the project uses \`pnpm\` or \`bun\` or \`yarn\`, you should not use \`npm\`. Similarly not everyone uses \`pip\` for python, etc.

Do:
- If there's an opportunity to use "-y" or "--yes" flags, use them. Any command that prompts for confirmation will hang if you don't use the flags.

Notes:
- If the user references a specific file, it could be either from their cwd or from the project root. You **must** determine which they are referring to (either infer or ask). Then, you must specify the path relative to the project root (or use the cwd parameter)
- Commands can succeed without giving any output, e.g. if no type errors were found.

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

🤖 Generated with ${productName}
Co-Authored-By: ${productName} <noreply@${productDomain}>"`
      : `git commit -m "Your commit message here."`,
  },
  endsAgentStep,
})}
    `.trim()
}

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
