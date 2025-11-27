import z from 'zod/v4'

import { $getNativeToolCallExampleString, jsonToolResultSchema } from '../utils'

import type { $ToolParams } from '../../constants'

const toolName = 'code_search'
const endsAgentStep = true
const inputSchema = z
  .object({
    pattern: z
      .string()
      .min(1, 'Pattern cannot be empty')
      .describe(`The pattern to search for.`),
    flags: z
      .string()
      .optional()
      .describe(
        `Optional ripgrep flags to customize the search (e.g., "-i" for case-insensitive, "-g *.ts -g *.js" for TypeScript and JavaScript files only, "-g !*.test.ts" to exclude Typescript test files,  "-A 3" for 3 lines after match, "-B 2" for 2 lines before match).`,
      ),
    cwd: z
      .string()
      .optional()
      .describe(
        `Optional working directory to search within, relative to the project root. Defaults to searching the entire project.`,
      ),
    maxResults: z
      .number()
      .int()
      .positive()
      .optional()
      .default(15)
      .describe(
        `Maximum number of results to return per file. Defaults to 15. There is also a global limit of 250 results across all files.`,
      ),
  })
  .describe(
    `Search for string patterns in the project's files. This tool uses ripgrep (rg), a fast line-oriented search tool. Use this tool only when read_files is not sufficient to find the files you need.`,
  )
const description = `
Purpose: Search through code files to find files with specific text patterns, function names, variable names, and more.

Prefer to use read_files instead of code_search unless you need to search for a specific pattern in multiple files.

Use cases:
1. Finding all references to a function, class, or variable name across the codebase
2. Searching for specific code patterns or implementations
3. Looking up where certain strings or text appear
4. Finding files that contain specific imports or dependencies
5. Locating configuration settings or environment variables

The pattern supports regular expressions and will search recursively through all files in the project by default. Some tips:
- Be as constraining in the pattern as possible to limit the number of files returned, e.g. if searching for the definition of a function, use "(function foo|const foo)" or "def foo" instead of merely "foo".
- Use Rust-style regex, not grep-style, PCRE, RE2 or JavaScript regex - you must always escape special characters like { and }
- Be as constraining as possible to limit results, e.g. use "(function foo|const foo)" or "def foo" instead of merely "foo"
- Add context to your search with surrounding terms (e.g., "function handleAuth" rather than just "handleAuth")
- Use word boundaries (\\b) to match whole words only
- Use the cwd parameter to narrow your search to specific directories
- For case-sensitive searches like constants (e.g., ERROR vs error), omit the "-i" flag
- Searches file content and filenames
- Automatically ignores binary files, hidden files, and files in .gitignore


Advanced ripgrep flags (use the flags parameter):

- Case sensitivity: "-i" for case-insensitive search
- File type filtering: "-t ts -t js" (TypeScript and JavaScript), "-t py" (Python), etc.
- Exclude file types: "--type-not py" to exclude Python files
- Context lines: "-A 3" (3 lines after), "-B 2" (2 lines before), "-C 2" (2 lines before and after)
- Line numbers: "-n" to show line numbers
- Count matches: "-c" to count matches per file
- Only filenames: "-l" to show only filenames with matches
- Invert match: "-v" to show lines that don't match
- Word boundaries: "-w" to match whole words only
- Fixed strings: "-F" to treat pattern as literal string (not regex)

Note: Do not use the end_turn tool after this tool! You will want to see the output of this tool before ending your turn.

RESULT LIMITING:

- The maxResults parameter limits the number of results shown per file (default: 15)
- There is also a global limit of 250 total results across all files
- These limits allow you to see results across multiple files without being overwhelmed by matches in a single file
- If a file has more matches than maxResults, you'll see a truncation notice indicating how many results were found
- If the global limit is reached, remaining files will be skipped

Examples:
${$getNativeToolCallExampleString({
  toolName,
  inputSchema,
  input: { pattern: 'foo' },
  endsAgentStep,
})}
${$getNativeToolCallExampleString({
  toolName,
  inputSchema,
  input: { pattern: 'foo\\.bar = 1\\.0' },
  endsAgentStep,
})}
${$getNativeToolCallExampleString({
  toolName,
  inputSchema,
  input: { pattern: 'import.*foo', cwd: 'src' },
  endsAgentStep,
})}
${$getNativeToolCallExampleString({
  toolName,
  inputSchema,
  input: { pattern: 'function.*authenticate', flags: '-i -t ts -t js' },
  endsAgentStep,
})}
${$getNativeToolCallExampleString({
  toolName,
  inputSchema,
  input: { pattern: 'TODO', flags: '-n --type-not py' },
  endsAgentStep,
})}
${$getNativeToolCallExampleString({
  toolName,
  inputSchema,
  input: { pattern: 'getUserData', maxResults: 10 },
  endsAgentStep,
})}
`.trim()

export const codeSearchParams = {
  toolName,
  endsAgentStep,
  description,
  inputSchema,
  outputSchema: jsonToolResultSchema(
    z.union([
      z.object({
        stdout: z.string(),
        stderr: z.string().optional(),
        exitCode: z.number().optional(),
        message: z.string(),
      }),
      z.object({
        errorMessage: z.string(),
      }),
    ]),
  ),
} satisfies $ToolParams
