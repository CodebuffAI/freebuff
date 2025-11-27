import z from 'zod/v4'

import { $getNativeToolCallExampleString, jsonToolResultSchema } from '../utils'

import type { $ToolParams } from '../../constants'

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

export const gitCommitGuidePrompt = `
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

4. **Create the commit, ending with this specific footer:**
   \`\`\`
   Generated with Codebuff 🤖
   Co-Authored-By: Codebuff <noreply@codebuff.com>
   \`\`\`
   To maintain proper formatting, use cross-platform compatible commit messages:
   
   **For Unix/bash shells:**
   \`\`\`
   git commit -m "$(cat <<'EOF'
   Your commit message here.

   🤖 Generated with Codebuff
   Co-Authored-By: Codebuff <noreply@codebuff.com>
   EOF
   )"
   \`\`\`
   
   **For Windows Command Prompt:**
   \`\`\`
   git commit -m "Your commit message here.

   🤖 Generated with Codebuff
   Co-Authored-By: Codebuff <noreply@codebuff.com>"
   \`\`\`
   
   Always detect the platform and use the appropriate syntax. HEREDOC syntax (\`<<'EOF'\`) only works in bash/Unix shells and will fail on Windows Command Prompt.

**Important details**

- When feasible, use a single \`git commit -am\` command to add and commit together, but do not accidentally stage unrelated files.
- Never alter the git config.
- Do not push to the remote repository.
- Avoid using interactive flags (e.g., \`-i\`) that require unsupported interactive input.
- Do not create an empty commit if there are no changes.
- Make sure your commit message is concise yet descriptive, focusing on the intention behind the changes rather than merely describing them.
`

const toolName = 'run_terminal_command'
const endsAgentStep = true
const inputSchema = z
  .object({
    // Can be empty to use it for a timeout.
    command: z
      .string()
      .min(1, 'Command cannot be empty')
      .describe(`CLI command valid for user's OS.`),
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
      .describe(
        `Set to -1 for no timeout. Does not apply for BACKGROUND commands. Default 30`,
      ),
  })
  .describe(
    `Execute a CLI command from the **project root** (different from the user's cwd).`,
  )
const description = `
Stick to these use cases:
1. Typechecking the project or running build (e.g., "npm run build"). Reading the output can help you edit code to fix build errors. If possible, use an option that performs checks but doesn't emit files, e.g. \`tsc --noEmit\`.
2. Running tests (e.g., "npm test"). Reading the output can help you edit code to fix failing tests. Or, you could write new unit tests and then run them.
3. Moving, renaming, or deleting files and directories. These actions can be vital for refactoring requests. Use commands like \`mv\`/\`move\` or \`rm\`/\`del\`.

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

${gitCommitGuidePrompt}

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
    command: `git commit -m "Your commit message here.

🤖 Generated with Codebuff
Co-Authored-By: Codebuff <noreply@codebuff.com>"`,
  },
  endsAgentStep,
})}
    `.trim()

export const runTerminalCommandParams = {
  toolName,
  endsAgentStep,
  description,
  inputSchema,
  outputSchema: jsonToolResultSchema(terminalCommandOutputSchema),
} satisfies $ToolParams
