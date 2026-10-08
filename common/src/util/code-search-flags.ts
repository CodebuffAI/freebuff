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
