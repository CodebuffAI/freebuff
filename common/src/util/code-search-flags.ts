/**
 * Parse the user-facing flag string once so validation and process spawning see
 * the same argv. Quotes group whitespace but are not passed to ripgrep because
 * spawn() does not invoke a shell.
 */
export function parseCodeSearchFlags(flags: string | undefined): string[] | null {
  if (!flags?.trim()) return []
  const tokens: string[] = []
  let token = ''
  let quote: "'" | '"' | null = null
  let tokenStarted = false
  for (const character of flags) {
    if (quote) {
      if (character === quote) quote = null
      else token += character
      tokenStarted = true
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
      tokenStarted = true
    } else if (/\s/.test(character)) {
      if (tokenStarted) {
        tokens.push(token)
        token = ''
        tokenStarted = false
      }
    } else {
      token += character
      tokenStarted = true
    }
  }
  if (quote) return null
  if (tokenStarted) tokens.push(token)
  return tokens
}

/**
 * Ripgrep flags that make it start another program. `--pre` runs a command per
 * searched file, `--hostname-bin` runs one to learn the hostname, and
 * `-z`/`--search-zip` spawns decompressors (gzip, xz, ...) found on PATH.
 * `--pre-glob` has no use without `--pre`, so it is refused with it.
 *
 * The model writes `code_search` flags, and repo content can steer the model,
 * so any agent granted `code_search` could otherwise run commands even without
 * a terminal tool. Checked against `rg --help` of the bundled ripgrep 15.2.0.
 * Ripgrep accepts no abbreviated long flags, so exact names are enough.
 */
const RIPGREP_EXEC_LONG_FLAGS: ReadonlySet<string> = new Set([
  '--pre',
  '--pre-glob',
  '--hostname-bin',
  '--search-zip',
])
const RIPGREP_EXEC_SHORT_FLAGS: ReadonlySet<string> = new Set(['z'])
/** Short flags that take a value, so the rest of a cluster is that value. */
const RIPGREP_SHORT_FLAGS_WITH_VALUE: ReadonlySet<string> = new Set(
  'efEmjgdtTABCMr',
)

/**
 * Returns a message for the model when any argv token is an exec-capable
 * ripgrep flag, in `--flag`, `--flag=value` or short-cluster (`-iz`) form.
 * Every token is checked, including ones ripgrep would read as a flag's value,
 * so this can refuse a harmless search (`-e -z`) but never misses one.
 */
export function codeSearchExecFlagRefusal(
  tokens: readonly string[],
): string | null {
  for (const token of tokens) {
    let flag: string | null = null
    if (token.startsWith('--')) {
      const name = token.split('=', 1)[0]!
      if (RIPGREP_EXEC_LONG_FLAGS.has(name)) flag = name
    } else if (token.startsWith('-')) {
      for (const short of token.slice(1)) {
        if (RIPGREP_EXEC_SHORT_FLAGS.has(short)) {
          flag = `-${short}`
          break
        }
        if (RIPGREP_SHORT_FLAGS_WITH_VALUE.has(short)) break
      }
    }
    if (flag) {
      return `Code search flag ${flag} is not allowed: it makes ripgrep run another program. Search again without it.`
    }
  }
  return null
}

/** How ripgrep prints: its `--json` events, or plain per-file records. */
export type CodeSearchOutputFormat = 'json' | 'paths' | 'counts'

/** Long flags that take a value, from `rg --help` of the bundled 15.2.0. */
const RIPGREP_LONG_FLAGS_WITH_VALUE: ReadonlySet<string> = new Set([
  '--after-context',
  '--before-context',
  '--color',
  '--colors',
  '--context',
  '--context-separator',
  '--dfa-size-limit',
  '--encoding',
  '--engine',
  '--field-context-separator',
  '--field-match-separator',
  '--file',
  '--generate',
  '--glob',
  '--hostname-bin',
  '--hyperlink-format',
  '--iglob',
  '--ignore-file',
  '--max-columns',
  '--max-count',
  '--max-depth',
  '--max-filesize',
  '--path-separator',
  '--pre',
  '--pre-glob',
  '--regex-size-limit',
  '--regexp',
  '--replace',
  '--sort',
  '--sortr',
  '--threads',
  '--type',
  '--type-add',
  '--type-clear',
  '--type-not',
])

/** Search modes. Note `-L` is `--follow`, not `--files-without-match`. */
const RIPGREP_LONG_MODE_FLAGS: ReadonlyMap<string, CodeSearchOutputFormat> =
  new Map([
    ['--json', 'json'],
    ['--files-with-matches', 'paths'],
    ['--files-without-match', 'paths'],
    ['--count', 'counts'],
    ['--count-matches', 'counts'],
  ])
const RIPGREP_SHORT_MODE_FLAGS: ReadonlyMap<string, CodeSearchOutputFormat> =
  new Map([
    ['l', 'paths'],
    ['c', 'counts'],
  ])

/** Flags that leave no results to read, whatever else the search asks for. */
const RIPGREP_NO_RESULTS_LONG_FLAGS: ReadonlySet<string> = new Set([
  '--generate',
  '--help',
  '--no-json',
  '--pcre2-version',
  '--quiet',
  '--type-list',
  '--version',
])
const RIPGREP_NO_RESULTS_SHORT_FLAGS: ReadonlySet<string> = new Set('hqV')

/**
 * What ripgrep will print given the caller's flags, which `codeSearch` places
 * after its own `--json`. Modes are last-one-wins (`-lc` counts, `-cl` lists,
 * `-c --json` is JSON, `--files -c` counts), and ripgrep prints `-l` and `-c`
 * as plain text even with `--json` before them. Under `--files` it reads the
 * pattern after `--` as a path to list.
 *
 * Unlike the exec refusal this walks argv as ripgrep does, skipping flag
 * values: `-e -c` searches for "-c", and misreading it would drop every result.
 */
export function codeSearchOutputFormat(tokens: readonly string[]): {
  format: CodeSearchOutputFormat
  /** `--files`: ripgrep lists files and must not be given the pattern. */
  listsFiles: boolean
  /** A message for the model when the flags can yield nothing to read. */
  refusal: string | null
} {
  let format: CodeSearchOutputFormat = 'json'
  let listsFiles = false
  const setMode = (mode: CodeSearchOutputFormat | undefined) => {
    if (!mode) return
    format = mode
    listsFiles = false
  }
  const refuse = (flag: string) => ({
    format,
    listsFiles,
    refusal: `Code search flag ${flag} gives this tool no search results to read. Search again without it.`,
  })
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!
    if (token === '--') break
    if (token.startsWith('--')) {
      const name = token.split('=', 1)[0]!
      if (RIPGREP_NO_RESULTS_LONG_FLAGS.has(name)) return refuse(name)
      if (name === '--files') listsFiles = true
      setMode(RIPGREP_LONG_MODE_FLAGS.get(name))
      if (name === token && RIPGREP_LONG_FLAGS_WITH_VALUE.has(name)) index++
    } else if (token.startsWith('-')) {
      for (let position = 1; position < token.length; position++) {
        const short = token[position]!
        if (RIPGREP_NO_RESULTS_SHORT_FLAGS.has(short)) {
          return refuse(`-${short}`)
        }
        setMode(RIPGREP_SHORT_MODE_FLAGS.get(short))
        if (RIPGREP_SHORT_FLAGS_WITH_VALUE.has(short)) {
          // The rest of the cluster is the value, or the next token is.
          if (position === token.length - 1) index++
          break
        }
      }
    }
  }
  return {
    format: listsFiles ? 'paths' : format,
    listsFiles,
    refusal: null,
  }
}
