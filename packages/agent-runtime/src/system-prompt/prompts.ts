import {
  flattenTree,
  getLastReadFilePaths,
} from '@codebuff/common/project-file-tree'
import { createMarkdownFileBlock } from '@codebuff/common/util/file'
import { closeXml } from '@codebuff/common/util/xml'

import { truncateFileTreeBasedOnTokenBudget } from './truncate-file-tree'

import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { ProjectFileContext } from '@codebuff/common/util/file'

export const knowledgeFilesPrompt = `
# Knowledge files

Knowledge files are your guide to the project. Knowledge files (files ending in "knowledge.md", "AGENTS.md", or "CLAUDE.md") within a directory capture knowledge about that portion of the codebase. They are another way to take notes in this "Memento"-style environment.

Knowledge files were created by previous engineers working on the codebase, and they were given these same instructions. They contain key concepts or helpful tips that are not obvious from the code. e.g., let's say I want to use a package manager aside from the default. That is hard to find in the codebase and would therefore be an appropriate piece of information to add to a knowledge file.

Each knowledge file should develop over time into a concise but rich repository of knowledge about the files within the directory, subdirectories, or the specific file it's associated with.

There is a special class of user knowledge files that are stored in the user's home directory, e.g. \`~/.knowledge.md\`, \`~/.AGENTS.md\`, or \`~/.CLAUDE.md\`. These files are available to be read, but you cannot edit them because they are outside of the project directory. Do not try to edit them.

When should you update a knowledge file?
- If the user gives broad advice to "always do x", that is a good candidate for updating a knowledge file with a concise rule to follow or bit of advice so you won't make the mistake again.
- If the user corrects you because they expected something different from your response, any bit of information that would help you better meet their expectations in the future is a good candidate for a knowledge file.

What to include in knowledge files:
- The mission of the project. Goals, purpose, and a high-level overview of the project.
- Explanations of how different parts of the codebase work or interact.
- Examples of how to do common tasks with a short explanation.
- Anti-examples of what should be avoided.
- Anything the user has said to do.
- Anything you can infer that the user wants you to do going forward.
- Tips and tricks.
- Style preferences for the codebase.
- Technical goals that are in progress. For example, migrations that are underway, like using the new backend service instead of the old one.
- Links to reference pages that are helpful. For example, the url of documentation for an api you are using.
- Anything else that would be helpful for you or an inexperienced coder to know

What *not* to include in knowledge files:
- Documentation of a single file.
- Restated code or interfaces in natural language.
- Anything obvious from reading the codebase.
- Lots of detail about a minor change.
- An explanation of the code you just wrote, unless there's something very unintuitive.

Again, DO NOT include details from your recent change that are not relevant more broadly.

Guidelines for updating knowledge files:
- Be concise and focused on the most important aspects of the project.
- Integrate new knowledge into existing sections when possible.
- Avoid overemphasizing recent changes or the aspect you're currently working on. Your current change is less important than you think.
- Remove as many words as possible while keeping the meaning. Use command verbs. Use sentence fragments.
- Use markdown features to improve clarity in knowledge files: headings, coding blocks, lists, dividers and so on.

Once again: BE CONCISE!

If the user sends you the url to a page that is helpful now or could be helpful in the future (e.g. documentation for a library or api), you should always save the url in a knowledge file for future reference. Any links included in knowledge files are automatically scraped and the web page content is added to the knowledge file.
`.trim()

const compactPrompt = `
User has typed "compact". Summarize the current conversation and prepare it to replace the existing message history.

1. Summarize the entire conversation up to this point (excluding this 'compact' command).
2. The summary should be detailed and must capture the key decisions, analysis, changes, and outcomes.
`.trim()

const exportPrompt = `
User has typed "export". Export the current conversation. (It's ok to proceed even if in "Ask" mode because of user change to "Export" mode).

1. Summarize the entire conversation up to this point from the message history (excluding this 'export' command) into a new file.
2. The summary MUST be in Markdown format.
3. The summary MUST include:
   - All key decisions made during the conversation.
   - All significant file changes. If you have access to write_file blocks from our history, reproduce their paths and content accurately. If you only have diffs or descriptions of changes, summarize those.
   - The reasoning behind those decisions and changes.
4. Use the 'write_file' tool to save this Markdown summary to a new file with a generated name starting with the prefix 'codebuff-export-' like 'codebuff-export-topic-of-conversation.md' in the project root directory.

Write file tool format:

<write_file>
<path>codebuff-export-file-name.md${closeXml('path')}
<content>
[Insert markdown content here]
${closeXml('content')}
${closeXml('write_file')}
`.trim()

const initPrompt = `
User has typed "init". Help them set up project knowledge files for better results.

1. Ensure there is a \`knowledge.md\` file in the project root. If it does not exist, create it.
2. Fill \`knowledge.md\` with concise, high-signal information about this repo:
   - What this project is and where key code lives
   - Commands to run (install/dev/test/lint/build) based on package/tooling files
   - Notable conventions, constraints, and "gotchas"
3. Prefer reading existing docs (e.g. README, package.json, scripts) before writing.
4. Use the \`write_file\` tool to create/update \`knowledge.md\`. Do not mention any deprecated configuration files.
`.trim()

export const additionalSystemPrompts = {
  '/init': initPrompt,
  init: initPrompt,
  '/export': exportPrompt,
  export: exportPrompt,
  '/compact': compactPrompt,
  // The bare word stays ON PURPOSE: the CLI rejects unregistered slash
  // commands locally ("Command not found"), so the bare word is the only
  // spelling a shipped client can actually deliver — dropping it kills manual
  // compaction everywhere. What made it dangerous was run-agent-step's
  // history-replacing branch matching MORE prompts than this map injects the
  // summarize instruction for; that branch now uses isCompactCommandPrompt
  // below, so the two can never diverge.
  compact: compactPrompt,
} as const

/**
 * True when `prompt` is the compact command AND received `compactPrompt` from
 * the map above. run-agent-step's history-replacing branch must use this
 * rather than matching the prompt itself: a trigger that matches prompts the
 * map does not (e.g. `/Compact` under a lowercased comparison) replaces the
 * whole history with an ordinary answer instead of a summary.
 */
export function isCompactCommandPrompt(prompt: string | undefined): boolean {
  return (
    prompt !== undefined &&
    prompt in additionalSystemPrompts &&
    additionalSystemPrompts[prompt as keyof typeof additionalSystemPrompts] ===
      compactPrompt
  )
}

export const getProjectFileTreePrompt = (params: {
  fileContext: ProjectFileContext
  fileTreeTokenBudget: number
  mode: 'search' | 'agent'
  logger: Logger
}) => {
  const { fileContext, fileTreeTokenBudget, mode, logger } = params
  const { projectRoot } = fileContext
  const { printedTree, truncationLevel } = truncateFileTreeBasedOnTokenBudget({
    fileContext,
    tokenBudget: Math.max(0, fileTreeTokenBudget),
    logger,
  })

  const truncationNote =
    truncationLevel === 'none'
      ? ''
      : truncationLevel === 'unimportant-files'
        ? '\nNote: Unimportant files (like build artifacts and cache files) have been removed from the file tree.'
        : truncationLevel === 'tokens'
          ? '\nNote: Selected function, class, and variable names in source files have been removed from the file tree to fit within token limits.'
          : '\nNote: The file tree has been truncated to show a subset of files to fit within token limits.'

  return `
# Project file tree

As Buffy, you have access to all the files in the project.

The following is the path to the project on the user's computer. It is also the current working directory for terminal commands:
<project_path>
${projectRoot}
${closeXml('project_path')}

Within this project directory, here is the file tree.
Note that the file tree:
- Is cached from the start of this conversation. Files created after the start of this conversation will not appear.
- Excludes files that are .gitignored.
${
  mode === 'agent'
    ? `\nThe project file tree below can be ignored unless you need to know what files are in the project.\n`
    : ''
}
<project_file_tree>
${printedTree}
${closeXml('project_file_tree')}
${truncationNote}
`.trim()
}

const windowsNote = `
Note: terminal commands run in bash on Windows too, not cmd.exe or PowerShell.
Use POSIX syntax — \`ls\`, \`mv\`, \`rm\`, \`cp\`, \`grep\` — and never \`dir\`, \`move\`, \`del\`, \`copy\`, \`findstr\` or PowerShell cmdlets. Write paths with forward slashes: bash treats \`\\\` as an escape, so \`C:\\Users\\me\` becomes \`C:Usersme\`.
`.trim()

/**
 * A host whose terminal broker runs Windows PowerShell 5.1 says so with
 * `systemInfo.shell: 'powershell'` (the sponsored Windows floor, COD-642). It
 * replaces the bash note: telling the model "bash" there turns `a && b`,
 * `rm -rf` and `2>/dev/null` into errors on every command.
 */
export const powershellNote = `
Note: terminal commands run in Windows PowerShell 5.1, not bash or cmd.exe.
- \`&&\` and \`||\` do not exist here. Chain with \`;\` and check the last native command with \`if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }\`.
- Environment variables are \`$env:NAME\` (\`$env:NODE_ENV = 'test'\`), not \`NAME=value cmd\` or \`export\`.
- Remove with \`Remove-Item -Recurse -Force path\`, not \`rm -rf\`. Discard output with \`> $null\` or \`2> $null\`, never \`/dev/null\`.
- Native tools (\`git\`, \`node\`, \`npm\`, \`npx\`) work as usual; quote arguments with single quotes.
`.trim()

export const getSystemInfoPrompt = (fileContext: ProjectFileContext) => {
  const { fileTree, shellConfigFiles, systemInfo } = fileContext
  const flattenedNodes = flattenTree(fileTree)
  const lastReadFilePaths = getLastReadFilePaths(flattenedNodes, 20)
  const shellNote =
    systemInfo.shell === 'powershell'
      ? powershellNote + '\n'
      : systemInfo.platform === 'win32'
        ? windowsNote + '\n'
        : ''

  return `
# System Info

Operating System: ${systemInfo.platform}
${shellNote}
Shell: ${systemInfo.shell}
Chrome: ${systemInfo.chromeAvailable ? 'installed' : 'not found'}

<user_shell_config_files>
${Object.entries(shellConfigFiles)
  .map(([path, content]) => createMarkdownFileBlock(path, content))
  .join('\n')}
${closeXml('user_shell_config_files')}

The following are the most recently read files according to the OS atime. This is cached from the start of this conversation:
<recently_read_file_paths_most_recent_first>
${lastReadFilePaths.join('\n')}
${closeXml('recently_read_file_paths_most_recent_first')}
`.trim()
}

export const getGitChangesPrompt = (fileContext: ProjectFileContext) => {
  const { gitChanges } = fileContext
  if (!gitChanges) {
    return ''
  }

  const historyCountPrefix =
    gitChanges.historyScanTruncated || gitChanges.historyIsShallow
      ? 'at least '
      : ''
  const contributorStats =
    gitChanges.humanContributorCount !== undefined
      ? [
          `human_contributors: ${historyCountPrefix}${gitChanges.humanContributorCount}`,
          `bot_contributors: ${historyCountPrefix}${gitChanges.botContributorCount ?? 0}`,
        ]
      : gitChanges.contributorCount !== undefined
        ? [`contributor_identities: ${gitChanges.contributorCount}`]
        : []
  const stats = [
    gitChanges.branch ? `branch: ${gitChanges.branch}` : undefined,
    `repository_visibility: ${gitChanges.repositoryVisibility ?? 'unknown'}`,
    gitChanges.fileCount !== undefined
      ? `indexed_project_files: ${gitChanges.fileCountIsLowerBound ? 'at least ' : ''}${gitChanges.fileCount}`
      : undefined,
    gitChanges.testFileCount !== undefined
      ? `detected_test_files: ${gitChanges.fileCountIsLowerBound ? 'at least ' : ''}${gitChanges.testFileCount}`
      : undefined,
    gitChanges.commitCount !== undefined
      ? `${gitChanges.historyIsShallow ? 'commits_in_shallow_clone' : 'total_commits'}: ${gitChanges.commitCount}`
      : undefined,
    gitChanges.commitDatePercentiles
      ? `${gitChanges.historyIsShallow ? 'commit_dates_available_history' : 'commit_dates'}: first=${gitChanges.commitDatePercentiles.p0}, p25=${gitChanges.commitDatePercentiles.p25}, p50=${gitChanges.commitDatePercentiles.p50}, p75=${gitChanges.commitDatePercentiles.p75}, p100=${gitChanges.commitDatePercentiles.p100}`
      : undefined,
    gitChanges.mergedPullRequestCount !== undefined
      ? `merged_pull_requests_detected: ${historyCountPrefix}${gitChanges.mergedPullRequestCount}`
      : undefined,
    ...contributorStats,
  ].filter((line): line is string => line !== undefined)
  const changedFiles = gitChanges.changedFiles ?? []
  const gitAvailable =
    gitChanges.gitAvailable ?? gitChanges.changedFiles !== undefined
  const changedFileCount = gitChanges.changedFileCount ?? changedFiles.length
  const countLabel = gitChanges.changedFileScanTruncated
    ? `at least ${changedFileCount}`
    : `${changedFileCount}`
  const changedFilesLabel =
    changedFiles.length < changedFileCount ||
    gitChanges.changedFileScanTruncated
      ? `showing ${changedFiles.length} of ${countLabel}`
      : `${changedFileCount}`

  return `
Git repository summary captured at the start of the conversation. Repository visibility is a best-effort authenticated GitHub lookup; unknown does not imply private. Commit dates are chronological percentiles by committer date. A shallow clone labels them as available history rather than the full project timeline; truncated history omits them. Local file discovery respects repository ignore rules. Test files are detected from common language-agnostic path and filename conventions without reading file contents. Human and bot contributors are separated conservatively after Git mailmap alias canonicalization; aliases absent from .mailmap can still remain separate. Merged pull requests are detected from common merge and squash commit-subject formats, so histories that omit PR numbers can undercount them.
<repository_stats>
${stats.join('\n')}
${closeXml('repository_stats')}

Changed file paths (${gitAvailable ? changedFilesLabel : 'unavailable'}):
<changed_file_paths>
${gitAvailable ? (changedFiles.length > 0 ? changedFiles.join('\n') : '(none)') : '(Git metadata unavailable to this host)'}
${closeXml('changed_file_paths')}
`.trim()
}
