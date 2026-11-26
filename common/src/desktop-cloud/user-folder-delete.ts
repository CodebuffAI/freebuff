/**
 * Recursive deletes an agent may never run on the user's own computer: the
 * home folder, anything above it, and the user's own folders in it (Desktop,
 * Documents, Downloads, ...).
 *
 * On 2026-11-25 a Desktop device run on Windows installed a third-party
 * browser skill whose installer walked up from the project (a folder inside
 * Downloads) to a marker file in the home folder and installed there. The
 * agent then cleaned up with `cd /c/Users/<name>; rm -rf shots downloads`.
 * NTFS is case-insensitive, so `downloads` was the user's real Downloads
 * folder: 20-100 GB, a research paper among it, gone.
 *
 * A pre-shell check for ordinary device commands (`run_terminal_command`,
 * `process_start` and the plain `exec` method), run by Desktop before its
 * shell and by Cloud before it dispatches. It resolves each target the way
 * the shell would: quotes, backslash escapes, `~`, `$HOME`, `%USERPROFILE%`,
 * `$env:USERPROFILE`, brace expansion, globs, `cd` earlier on the line, Git
 * Bash's `/c/...` paths, and the wrappers that run a command string (`bash -c`,
 * `cmd /c`, `powershell -Command`, `eval`, `sudo`, `npx`). Names are compared
 * case-insensitively on Windows and macOS.
 *
 * It is narrow on purpose. It refuses only a recursive delete whose target
 * resolves to one of those folders, never a delete inside the project or
 * inside a folder the run made for itself, and a target it cannot resolve (an
 * unknown variable, a command substitution, a relative path with no known
 * working directory) is let through. It guards against an agent's mistake,
 * not a deliberate attempt: the sponsored walk
 * (`common/src/ads/sponsored-command-refusals.ts`) fails closed because a
 * sponsored run is a stranger's procedure, and this one must never get in the
 * way of the user's own work. That walk's lexer drops the quoting a path
 * depends on (whether `~` was quoted, backslash escapes), so this file reads
 * words itself and mirrors only its list of wrappers.
 */

import path from 'node:path'

export type UserFolderDeleteContext = {
  /** `process.platform` of the computer the command runs on. */
  platform: string
  /** The directory the command starts in, absolute; null when unknown. */
  cwd: string | null
  /** The user's home folder; null when unknown (Cloud passes `inferHomeFolder(cwd)`). */
  home: string | null
  /** The command's environment, for `$VAR`, `%VAR%` and `$env:VAR`. */
  env?: Readonly<Record<string, string | undefined>>
}

export type UserFolderDeleteKind =
  /** The home folder itself. */
  | 'home'
  /** A folder that contains the home folder (`/Users`, `C:\`). */
  | 'above-home'
  /** One of the user's own folders in it (`~/Downloads`). */
  | 'user-folder'
  /** Everything inside one (`~/Downloads/*`). */
  | 'user-folder-contents'

export type RefusedUserFolderDelete = {
  kind: UserFolderDeleteKind
  /** The delete as written, e.g. `rm -rf` or `Remove-Item -Recurse`. */
  invocation: string
  /** The target as written, e.g. `downloads` or `~/*`. */
  target: string
  /** The folder it resolves to, e.g. `C:\Users\ana\Downloads`. */
  resolved: string
}

type Dialect = 'bash' | 'cmd' | 'powershell'
type Quote = 'none' | 'single' | 'double'
type Part = { text: string; quote: Quote } | { subst: true }
type Word = Part[]
type Item =
  | { kind: 'command'; words: Word[] }
  | { kind: 'open' }
  | { kind: 'close' }
  /** A command substitution, run before the command it sits in. */
  | { kind: 'nested'; command: string }

/** How many wrappers deep the walk reads. Past it, nothing is refused. */
const MAX_DEPTH = 8
/** Brace expansion past this many words stops judging the word. */
const MAX_EXPANSIONS = 64
/** No path is longer (PATH_MAX); a longer word is not judged. */
const MAX_WORD = 4096

// ------------------------------------------------------------------- lexing

/**
 * Split a command line into simple commands and their words, keeping which
 * part of each word was quoted, as `dialect` reads it.
 *
 * Redirection targets and heredoc bodies are dropped: they are files the
 * command writes or text it reads, never arguments.
 */
function lex(command: string, dialect: Dialect): Item[] {
  const items: Item[] = []
  let words: Word[] = []
  let word: Part[] = []
  let inWord = false
  let dropNextWord = false
  const heredocs: { delimiter: string; strip: boolean }[] = []
  const escape = dialect === 'bash' ? '\\' : dialect === 'cmd' ? '^' : '`'

  const push = (text: string, quote: Quote) => {
    const last = word[word.length - 1]
    if (last && !('subst' in last) && last.quote === quote) last.text += text
    else word.push({ text, quote })
    inWord = true
  }
  const pushSubst = (inner: string | null) => {
    if (inner !== null) items.push({ kind: 'nested', command: inner })
    word.push({ subst: true })
    inWord = true
  }
  const endWord = () => {
    if (inWord) {
      if (dropNextWord) dropNextWord = false
      else words.push(word)
    }
    word = []
    inWord = false
  }
  const endCommand = () => {
    endWord()
    dropNextWord = false
    if (words.length > 0) items.push({ kind: 'command', words })
    words = []
  }
  /** `$(…)`, `` `…` ``: the text up to the matching close. */
  const substitution = (index: number): { inner: string; end: number } => {
    if (command[index] === '`') {
      let end = index + 1
      while (end < command.length && command[end] !== '`') {
        if (command[end] === '\\') end++
        end++
      }
      return { inner: command.slice(index + 1, end), end }
    }
    // `$(`: count parentheses outside quotes.
    let depth = 1
    let end = index + 2
    while (end < command.length && depth > 0) {
      const ch = command[end]!
      if (ch === "'" && dialect !== 'cmd') {
        const close = command.indexOf("'", end + 1)
        end = close < 0 ? command.length : close + 1
        continue
      }
      if (ch === '"') {
        let close = end + 1
        while (close < command.length && command[close] !== '"') {
          if (command[close] === escape) close++
          close++
        }
        end = close + 1
        continue
      }
      if (ch === escape) {
        end += 2
        continue
      }
      if (ch === '(') depth++
      else if (ch === ')') depth--
      end++
    }
    return { inner: command.slice(index + 2, end - 1), end: end - 1 }
  }
  /** After a newline: skip the bodies of the heredocs opened on that line. */
  const skipHeredocs = (index: number): number => {
    let at = index
    while (heredocs.length > 0) {
      const { delimiter, strip } = heredocs.shift()!
      while (at < command.length) {
        const next = command.indexOf('\n', at)
        const line = command.slice(at, next < 0 ? command.length : next)
        at = next < 0 ? command.length : next + 1
        if ((strip ? line.replace(/^\t+/, '') : line) === delimiter) break
      }
    }
    return at
  }

  for (let index = 0; index < command.length; index++) {
    const ch = command[index]!
    const next = command[index + 1]
    if (ch === '\n' || ch === '\r') {
      endCommand()
      if (ch === '\n' && heredocs.length > 0) index = skipHeredocs(index + 1) - 1
      continue
    }
    if (ch === escape) {
      if (next === '\n') {
        index++
        continue
      }
      if (next === '\r' && command[index + 2] === '\n') {
        index += 2
        continue
      }
      if (next !== undefined) {
        push(next, 'single')
        index++
      } else push(ch, 'single')
      continue
    }
    if (ch === "'" && dialect !== 'cmd') {
      const close = command.indexOf("'", index + 1)
      push(command.slice(index + 1, close < 0 ? command.length : close), 'single')
      index = close < 0 ? command.length : close
      continue
    }
    if (ch === '$' && next === "'" && dialect === 'bash') {
      let end = index + 2
      let text = ''
      while (end < command.length && command[end] !== "'") {
        if (command[end] === '\\' && end + 1 < command.length) end++
        text += command[end]
        end++
      }
      push(text, 'single')
      index = end
      continue
    }
    if (ch === '"') {
      let end = index + 1
      let text = ''
      while (end < command.length && command[end] !== '"') {
        const inner = command[end]!
        if (dialect === 'bash' && inner === '\\' && /[$`"\\\n]/.test(command[end + 1] ?? '')) {
          if (command[end + 1] !== '\n') text += command[end + 1]
          end += 2
          continue
        }
        if (dialect === 'powershell' && inner === '`' && end + 1 < command.length) {
          text += command[end + 1]
          end += 2
          continue
        }
        if (dialect !== 'cmd' && inner === '$' && command[end + 1] === '(') {
          if (text) push(text, 'double')
          text = ''
          const found = substitution(end)
          pushSubst(command[end + 2] === '(' ? null : found.inner)
          end = found.end + 1
          continue
        }
        if (dialect === 'bash' && inner === '`') {
          if (text) push(text, 'double')
          text = ''
          const found = substitution(end)
          pushSubst(found.inner)
          end = found.end + 1
          continue
        }
        text += inner
        end++
      }
      push(text, 'double')
      inWord = true
      index = end
      continue
    }
    if (dialect !== 'cmd' && ch === '$' && next === '(') {
      const found = substitution(index)
      // `$((…))` is arithmetic: a number, never a command.
      pushSubst(command[index + 2] === '(' ? null : found.inner)
      index = found.end
      continue
    }
    if (dialect === 'bash' && ch === '`') {
      const found = substitution(index)
      pushSubst(found.inner)
      index = found.end
      continue
    }
    if (ch === '#' && !inWord && dialect !== 'cmd') {
      const close = command.indexOf('\n', index)
      index = (close < 0 ? command.length : close) - 1
      continue
    }
    if (ch === ' ' || ch === '\t') {
      endWord()
      continue
    }
    if (ch === '<' || ch === '>') {
      // `2>`, `2>&1`: the fd number belongs to the redirection.
      const fd = word.length === 1 && !('subst' in word[0]!) &&
        word[0]!.quote === 'none' && /^\d+$/.test(word[0]!.text)
      if (fd) {
        word = []
        inWord = false
      } else endWord()
      if (ch === '<' && next === '<' && command[index + 2] === '<') {
        index += 2
      } else if (ch === '<' && next === '<' && dialect === 'bash') {
        const strip = command[index + 2] === '-'
        index += strip ? 2 : 1
        let at = index + 1
        while (command[at] === ' ' || command[at] === '\t') at++
        let delimiter = ''
        while (at < command.length && !/[\s;&|<>()]/.test(command[at]!)) {
          if (command[at] !== '"' && command[at] !== "'" && command[at] !== '\\') delimiter += command[at]
          at++
        }
        heredocs.push({ delimiter, strip })
        index = at - 1
        continue
      } else if (next === '>' || next === '&' || next === '|') {
        index++
      }
      dropNextWord = true
      // `2>&1`, `>&2`: the fd after `&` is the whole target.
      if (command[index] === '&' && /\d/.test(command[index + 1] ?? '')) {
        index++
        while (/\d/.test(command[index + 1] ?? '')) index++
        dropNextWord = false
      }
      continue
    }
    if (ch === '&' && next === '>' && dialect === 'bash') {
      endWord()
      index++
      if (command[index + 1] === '>') index++
      dropNextWord = true
      continue
    }
    if (ch === '&' || ch === '|') {
      // PowerShell's lone `&` is its call operator.
      if (dialect === 'powershell' && ch === '&' && next !== '&') {
        endWord()
        continue
      }
      endCommand()
      if (next === ch) index++
      continue
    }
    if (ch === ';' && dialect !== 'cmd') {
      endCommand()
      continue
    }
    if (ch === ';' || (ch === ',' && dialect === 'cmd')) {
      endWord()
      continue
    }
    if (ch === ',' && dialect === 'powershell') {
      endWord()
      continue
    }
    if ((ch === '{' || ch === '}') && dialect === 'powershell') {
      endCommand()
      continue
    }
    if (ch === '(' && !inWord) {
      endCommand()
      items.push({ kind: 'open' })
      continue
    }
    if (ch === ')') {
      endCommand()
      items.push({ kind: 'close' })
      continue
    }
    push(ch, 'none')
  }
  endCommand()
  return items
}

/** The word's text with quotes removed and nothing expanded. */
function rawText(word: Word): string {
  return word.map((part) => ('subst' in part ? '' : part.text)).join('')
}

/** Whether every part of the word is an unquoted literal. */
function unquoted(word: Word): boolean {
  return word.every((part) => !('subst' in part) && part.quote === 'none')
}

/** `C:\Program Files\Git\usr\bin\rm.exe` → `rm`; `rimraf@5` → `rimraf`. */
function commandName(text: string): string {
  const base = text.split(/[\\/]/).pop() ?? text
  return base
    .toLowerCase()
    .replace(/(.)@[^@]*$/, '$1')
    .replace(/\.(exe|cmd|bat|com|ps1)$/, '')
}

// --------------------------------------------------------------- the walk

type Context = {
  platform: string
  home: string | null
  env: Readonly<Record<string, string | undefined>>
  /** Inside `wsl`: `~` and `$HOME` are the Linux home, which is not resolved here. */
  linuxHome: boolean
}

type State = {
  cwd: string | null
  vars: Map<string, string | null>
}

const KEYWORDS: ReadonlySet<string> = new Set([
  'then', 'do', 'else', 'elif', 'if', 'while', 'until', '!', '{', '}', 'time',
])

/**
 * Words that run the command after them, each with its options that take a
 * separate value, so the value is not read as the command.
 */
const PREFIX_COMMANDS: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  Object.entries({
    sudo: ['-u', '-g', '-h', '-p', '-c', '-r', '-t', '-d', '-D', '-C', '-U'],
    doas: ['-u', '-c'],
    env: ['-u', '--unset', '-C', '--chdir', '-S', '--split-string'],
    exec: ['-a'],
    command: [],
    builtin: [],
    nohup: [],
    nice: ['-n', '--adjustment'],
    timeout: ['-s', '-k', '--signal', '--kill-after'],
    stdbuf: ['-i', '-o', '-e'],
    caffeinate: ['-t', '-w'],
    unbuffer: [],
    xargs: ['-I', '-i', '-n', '-P', '-L', '-l', '-s', '-d', '-E', '-e', '-a'],
    'cross-env': [],
    dotenv: ['-e', '-c', '-v', '-p'],
    'env-cmd': ['-f', '-e', '--file', '--environments'],
  }).map(([name, options]) => [name, new Set(options)]),
)

/** `npm exec rimraf x`, `pnpm dlx rimraf x`, `bun x rimraf x`. */
const RUNNER_SUBCOMMANDS: Record<string, ReadonlySet<string>> = {
  npm: new Set(['exec', 'x']),
  pnpm: new Set(['exec', 'dlx']),
  yarn: new Set(['exec', 'dlx']),
  bun: new Set(['x']),
}
const PACKAGE_RUNNERS: ReadonlySet<string> = new Set(['npx', 'bunx', 'pnpx'])
const POSIX_SHELLS: ReadonlySet<string> = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish'])
const POWERSHELLS: ReadonlySet<string> = new Set(['powershell', 'pwsh'])
const POWERSHELL_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  'executionpolicy', 'ex', 'ep', 'windowstyle', 'w', 'outputformat', 'o',
  'inputformat', 'if', 'configurationname', 'workingdirectory', 'wd', 'version',
  'v', 'psconsolefile', 'settingsfile',
])
const CD_COMMANDS: ReadonlySet<string> = new Set([
  'cd', 'pushd', 'chdir', 'sl', 'set-location', 'push-location',
])
const POWERSHELL_REMOVE: ReadonlySet<string> = new Set(['remove-item', 'ri'])
/** Aliases of Remove-Item in PowerShell; in bash and cmd, their own commands. */
const POWERSHELL_REMOVE_ALIASES: ReadonlySet<string> = new Set([
  'rm', 'rmdir', 'rd', 'del', 'erase',
])
/** Remove-Item parameters that take a value which is not a path to delete. */
const REMOVE_ITEM_VALUE_PARAMETERS: ReadonlySet<string> = new Set([
  'filter', 'include', 'exclude', 'credential', 'stream',
])
const REMOVE_ITEM_PATH_PARAMETERS: ReadonlySet<string> = new Set([
  'path', 'literalpath', 'lp', 'pspath',
])

function analyze(
  command: string,
  dialect: Dialect,
  context: Context,
  state: State,
  depth: number,
): RefusedUserFolderDelete | null {
  if (depth > MAX_DEPTH) return null
  const scopes: (string | null)[] = []
  for (const item of lex(command, dialect)) {
    if (item.kind === 'open') {
      scopes.push(state.cwd)
      continue
    }
    if (item.kind === 'close') {
      if (scopes.length > 0) state.cwd = scopes.pop()!
      continue
    }
    if (item.kind === 'nested') {
      const found = analyze(item.command, dialect, context, {
        cwd: state.cwd,
        vars: new Map(state.vars),
      }, depth + 1)
      if (found) return found
      continue
    }
    const found = analyzeCommand(item.words, dialect, context, state, depth)
    if (found) return found
  }
  return null
}

function analyzeCommand(
  words: Word[],
  dialect: Dialect,
  context: Context,
  state: State,
  depth: number,
): RefusedUserFolderDelete | null {
  let index = 0
  const assignments: [string, Word][] = []
  while (index < words.length) {
    const word = words[index]!
    const text = rawText(word)
    const first = word[0]
    const assignment = dialect === 'bash' && first && !('subst' in first) &&
      first.quote === 'none' && /^[A-Za-z_][A-Za-z0-9_]*=/.exec(first.text)
    if (assignment) {
      const name = assignment[0].slice(0, -1)
      const value: Word = [
        { text: first.text.slice(assignment[0].length), quote: 'none' },
        ...word.slice(1),
      ]
      assignments.push([name, value])
      index++
      continue
    }
    const name = commandName(text)
    if (dialect === 'bash' && unquoted(word) && KEYWORDS.has(text)) {
      index++
      continue
    }
    if (dialect === 'bash' && ['export', 'local', 'declare', 'readonly'].includes(name)) {
      // `export X=1`: the words after it are assignments, not a command.
      for (const rest of words.slice(index + 1)) {
        const restFirst = rest[0]
        const found = restFirst && !('subst' in restFirst) &&
          /^[A-Za-z_][A-Za-z0-9_]*=/.exec(restFirst.text)
        if (!found) continue
        assignments.push([found[0].slice(0, -1), [
          { text: restFirst.text.slice(found[0].length), quote: restFirst.quote },
          ...rest.slice(1),
        ]])
      }
      index = words.length
      break
    }
    const valueOptions = PREFIX_COMMANDS.get(name)
    const second = words[index + 1] ? rawText(words[index + 1]!).toLowerCase() : ''
    const runner = RUNNER_SUBCOMMANDS[name]?.has(second) === true
    if (!valueOptions && !runner && !PACKAGE_RUNNERS.has(name)) break
    index += runner ? 2 : 1
    while (index < words.length) {
      const option = rawText(words[index]!)
      if (option === '--') {
        index++
        break
      }
      if (option.startsWith('-')) {
        const takesValue = !option.includes('=') && (
          valueOptions?.has(option) ||
          ((runner || PACKAGE_RUNNERS.has(name)) && /^(-p|--package)$/.test(option))
        )
        index += takesValue ? 2 : 1
        continue
      }
      if (/^\d+(\.\d+)?[smhd]?$/.test(option) && name === 'timeout') {
        index++
        continue
      }
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(option) && (name === 'env' || name === 'cross-env')) {
        index++
        continue
      }
      break
    }
  }

  // A line of only assignments sets them for the rest of the line.
  if (index >= words.length) {
    for (const [name, value] of assignments) {
      state.vars.set(name, expandText(value, dialect, context, state))
    }
    return null
  }

  const headWord = words[index]!
  const head = commandName(rawText(headWord))
  const args = words.slice(index + 1)
  const argText = (word: Word) => rawText(word)
  /**
   * Words joined back into a command line for another shell, spaces kept
   * inside quotes. One word is the whole line (`cmd /c "rd /s x"`): its quotes
   * are the outer shell's, which `cmd` and PowerShell strip.
   */
  const joined = (list: Word[]) =>
    list.length === 1 ? argText(list[0]!) : list.map((word) => {
      const text = argText(word)
      return /\s/.test(text) && !word.every((part) => !('subst' in part) && part.quote === 'none') ? `"${text}"` : text
    }).join(' ')

  // ---- the working directory
  if (CD_COMMANDS.has(head)) {
    if (dialect === 'cmd' && head !== 'cd' && head !== 'chdir' && head !== 'pushd') return null
    const target = args.find((word) => {
      const text = argText(word)
      if (dialect === 'cmd') return !/^\/d$/i.test(text)
      if (dialect === 'powershell') return !/^-(path|literalpath|lp)$/i.test(text)
      return !/^-[LPe@]+$/.test(text)
    })
    if (!target) {
      // `cd` alone: home in bash and PowerShell 7; cmd only prints the directory.
      if (dialect !== 'cmd') state.cwd = context.linuxHome ? null : context.home
      return null
    }
    if (argText(target) === '-') {
      state.cwd = null
      return null
    }
    const resolved = resolveWords(target, dialect, context, state)
    state.cwd = resolved.length === 1 && !resolved[0]!.glob ? resolved[0]!.path : null
    return null
  }
  if (head === 'popd' || head === 'pop-location') {
    state.cwd = null
    return null
  }

  // ---- wrappers that run a command string
  const inner = (text: string, innerDialect: Dialect, innerContext = context) =>
    analyze(text, innerDialect, innerContext, {
      cwd: state.cwd,
      vars: new Map(innerDialect === dialect ? state.vars : []),
    }, depth + 1)
  if (POSIX_SHELLS.has(head)) {
    const flag = args.findIndex((word) => {
      const text = argText(word)
      return text === '--command' || (unquoted(word) && /^-[A-Za-z]*c[A-Za-z]*$/.test(text))
    })
    if (flag < 0) return null
    let rest = args.slice(flag + 1)
    if (rest[0] && argText(rest[0]) === '--') rest = rest.slice(1)
    return rest[0] ? inner(argText(rest[0]), 'bash') : null
  }
  if (head === 'cmd') {
    const flag = args.findIndex((word) => /^\/\/?[ck]/i.test(argText(word)))
    if (flag < 0) return null
    const attached = argText(args[flag]!).replace(/^\/\/?[ck]/i, '')
    return inner(
      [attached, joined(args.slice(flag + 1))].filter(Boolean).join(' '),
      'cmd',
    )
  }
  if (POWERSHELLS.has(head)) {
    let at = 0
    while (at < args.length) {
      const text = argText(args[at]!)
      if (!/^[-/]/.test(text)) return inner(joined(args.slice(at)), 'powershell')
      const option = text.slice(1).toLowerCase()
      if (option.length > 0 && 'command'.startsWith(option))
        return inner(joined(args.slice(at + 1)), 'powershell')
      if (option === 'ec' || (option.length > 0 && 'encodedcommand'.startsWith(option))) {
        const decoded = decodePowerShellCommand(argText(args[at + 1] ?? []))
        return decoded === null ? null : inner(decoded, 'powershell')
      }
      if (option.length > 0 && 'file'.startsWith(option)) return null
      at += POWERSHELL_VALUE_OPTIONS.has(option) ? 2 : 1
    }
    return null
  }
  if (head === 'eval' || head === 'iex' || head === 'invoke-expression') {
    return inner(joined(args), dialect)
  }
  if (head === 'wsl') {
    let at = 0
    while (at < args.length) {
      const option = argText(args[at]!)
      if (option === '--' || option === '-e' || option === '--exec') {
        at++
        break
      }
      if (['-d', '--distribution', '-u', '--user', '--cd', '--shell-type'].includes(option)) at += 2
      else if (option.startsWith('-')) at++
      else break
    }
    return inner(joined(args.slice(at)), 'bash', { ...context, linuxHome: true })
  }

  // ---- deletes
  const remove = deleteCommand(head, args, dialect)
  if (!remove) return null
  for (const target of remove.targets) {
    for (const resolved of resolveWords(target, dialect, context, state)) {
      const found = classify(resolved, context)
      if (found) {
        return {
          kind: found.kind,
          invocation: remove.invocation,
          target: rawText(target),
          resolved: found.resolved,
        }
      }
    }
  }
  return null
}

/** A recursive delete's invocation and targets, or null when the command is not one. */
function deleteCommand(
  head: string,
  args: Word[],
  dialect: Dialect,
): { invocation: string; targets: Word[] } | null {
  const text = (word: Word) => rawText(word)
  if (POWERSHELL_REMOVE.has(head) || (dialect === 'powershell' && POWERSHELL_REMOVE_ALIASES.has(head))) {
    let recursive = false
    const targets: Word[] = []
    for (let at = 0; at < args.length; at++) {
      const value = text(args[at]!)
      const parameter = /^-([A-Za-z]+)(:.*)?$/.exec(value)
      if (!parameter) {
        targets.push(args[at]!)
        continue
      }
      const name = parameter[1]!.toLowerCase()
      if (name === 'whatif' || name === 'wi') return null
      // `-r`, `-rec`, `-Recurse`, and `-rf`, which errors in PowerShell but means it.
      if ('recurse'.startsWith(name) || (/r/.test(name) && name.length <= 3 && !'force'.startsWith(name))) {
        if (!/^:\$false$/i.test(parameter[2] ?? '')) recursive = true
        continue
      }
      if (REMOVE_ITEM_PATH_PARAMETERS.has(name)) {
        if (parameter[2]) targets.push([{ text: parameter[2].slice(1), quote: 'none' }])
        else if (args[at + 1]) targets.push(args[++at]!)
        continue
      }
      if (REMOVE_ITEM_VALUE_PARAMETERS.has(name) && !parameter[2]) at++
    }
    return recursive ? { invocation: `${head === 'ri' ? 'ri' : head === 'remove-item' ? 'Remove-Item' : head} -Recurse`, targets } : null
  }
  if (head === 'rm') {
    let recursive = false
    let flagText = ''
    const targets: Word[] = []
    let ended = false
    for (const word of args) {
      const value = text(word)
      if (!ended && value === '--') {
        ended = true
        continue
      }
      if (!ended && value === '--recursive') {
        recursive = true
        flagText = value
        continue
      }
      if (!ended && /^-[A-Za-z]+$/.test(value)) {
        if (/[rR]/.test(value)) {
          recursive = true
          flagText ||= value
        }
        continue
      }
      if (!ended && value.startsWith('--')) continue
      targets.push(word)
    }
    return recursive ? { invocation: `rm ${flagText}`, targets } : null
  }
  if (head === 'rmdir' || head === 'rd' || head === 'del' || head === 'erase') {
    // `//s`: Git Bash's spelling, so MSYS does not read the switch as a path.
    const isSwitch = (word: Word) => /^\/\/?[A-Za-z]$/.test(text(word))
    if (!args.some((word) => /^\/\/?s$/i.test(text(word)))) return null
    return {
      invocation: `${head} /s`,
      targets: args.filter((word) => !isSwitch(word)),
    }
  }
  if (head === 'rimraf') {
    return { invocation: 'rimraf', targets: args.filter((word) => !text(word).startsWith('-')) }
  }
  return null
}

/** Decode `-EncodedCommand`'s base64 UTF-16LE, or null if it is not that. */
function decodePowerShellCommand(encoded: string): string | null {
  try {
    const binary = globalThis.atob(encoded)
    let text = ''
    for (let index = 0; index + 1 < binary.length; index += 2) {
      text += String.fromCharCode(
        binary.charCodeAt(index) | (binary.charCodeAt(index + 1) << 8),
      )
    }
    return text
  } catch {
    return null
  }
}

// ------------------------------------------------------- words into paths

type Ch = { c: string; q: Quote }
type Resolved = {
  /** The absolute path; for a glob, the folder the pattern is matched in. */
  path: string
  /** The last component's pattern, when it has one. */
  glob: string | null
}

/** The word as characters with their quoting, or null when part of it is a command's output. */
function characters(word: Word): Ch[] | null {
  const out: Ch[] = []
  for (const part of word) {
    if ('subst' in part) return null
    for (const c of part.text) out.push({ c, q: part.quote })
  }
  return out
}

/** Bash brace expansion of unquoted `{a,b}`, bounded. */
function braceExpand(chars: Ch[], budget = { left: MAX_EXPANSIONS }): Ch[][] | null {
  for (let open = 0; open < chars.length; open++) {
    const ch = chars[open]!
    if (ch.c !== '{' || ch.q !== 'none' || chars[open - 1]?.c === '$') continue
    let depth = 0
    const commas: number[] = []
    let close = -1
    for (let at = open; at < chars.length; at++) {
      const inner = chars[at]!
      if (inner.q !== 'none') continue
      if (inner.c === '{') depth++
      else if (inner.c === '}' && --depth === 0) {
        close = at
        break
      } else if (inner.c === ',' && depth === 1) commas.push(at)
    }
    if (close < 0 || commas.length === 0) continue
    const before = chars.slice(0, open)
    const after = chars.slice(close + 1)
    const bounds = [open, ...commas, close]
    const out: Ch[][] = []
    for (let at = 0; at + 1 < bounds.length; at++) {
      const expanded = braceExpand(
        [...before, ...chars.slice(bounds[at]! + 1, bounds[at + 1]), ...after],
        budget,
      )
      if (!expanded) return null
      out.push(...expanded)
      if ((budget.left -= expanded.length) < 0) return null
    }
    return out
  }
  return [chars]
}

/** The value of a variable the command line can name, or undefined when unknown. */
function variable(
  name: string,
  dialect: Dialect,
  context: Context,
  state: State,
): string | null | undefined {
  if (state.vars.has(name)) return state.vars.get(name)
  const upper = name.toUpperCase()
  const windows = context.platform === 'win32'
  const key = windows || dialect !== 'bash' ? upper : name
  if (key === 'HOME' || upper === 'USERPROFILE') {
    if (context.linuxHome) return undefined
    return context.home ?? envValue(context, name) ?? undefined
  }
  if (key === 'PWD') return state.cwd ?? undefined
  if (windows && context.home && upper === 'HOMEPATH') {
    const parsed = path.win32.parse(context.home)
    return context.home.slice(parsed.root.replace(/[\\/]$/, '').length)
  }
  if (windows && context.home && upper === 'HOMEDRIVE') {
    return path.win32.parse(context.home).root.replace(/[\\/]$/, '')
  }
  return envValue(context, name)
}

function envValue(context: Context, name: string): string | undefined {
  if (context.platform !== 'win32') return context.env[name] || undefined
  const upper = name.toUpperCase()
  for (const [key, value] of Object.entries(context.env)) {
    if (key.toUpperCase() === upper && value) return value
  }
  return undefined
}

/**
 * `$HOME`, `${HOME}`, `${X:-default}`, `$env:USERPROFILE`, `%USERPROFILE%` and
 * `~` expanded, as characters; null when something on the way is unknown.
 * Expanded text counts as quoted: it is neither globbed nor re-expanded.
 */
function expand(
  chars: Ch[],
  dialect: Dialect,
  context: Context,
  state: State,
): Ch[] | null {
  const out: Ch[] = []
  const insert = (value: string) => {
    for (const c of value) out.push({ c, q: 'double' })
  }
  let at = 0
  // `~`, `~/x`: bash only when unquoted; PowerShell resolves it in any path.
  const first = chars[0]
  if (first?.c === '~' && (dialect === 'bash' ? first.q === 'none' : dialect === 'powershell')) {
    const next = chars[1]?.c
    if (next === undefined || next === '/' || (next === '\\' && dialect === 'powershell')) {
      if (context.linuxHome || !context.home) return null
      insert(context.home)
      at = 1
    } else if (dialect === 'bash' && chars[1]?.q === 'none') {
      return null // `~user`: another account's home
    }
  }
  // Variable names are short: look a bounded way ahead, so a long word stays linear.
  const textFrom = (start: number, pattern: RegExp) => {
    let text = ''
    for (let index = start; index < chars.length && index < start + 256; index++) text += chars[index]!.c
    return pattern.exec(text)
  }
  while (at < chars.length) {
    const ch = chars[at]!
    if (ch.c === '$' && ch.q !== 'single' && dialect !== 'cmd') {
      const env = textFrom(at, /^\$(?:\{env:([A-Za-z_][A-Za-z0-9_()]*)\}|env:([A-Za-z_][A-Za-z0-9_]*))/i)
      const braced = textFrom(at, /^\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?-)([^}]*))?\}/)
      const plain = textFrom(at, /^\$([A-Za-z_][A-Za-z0-9_]*)/)
      if (env) {
        const value = variable(env[1] ?? env[2]!, dialect, context, state)
        if (value == null) return null
        insert(value)
        at += env[0].length
        continue
      }
      if (braced) {
        const value = variable(braced[1]!, dialect, context, state)
        if (value != null && !(braced[2] === ':-' && value === '')) insert(value)
        else if (braced[2]) insert(braced[3]!)
        else return null
        at += braced[0].length
        continue
      }
      if (plain) {
        const value = variable(plain[1]!, dialect, context, state)
        if (value == null) return null
        insert(value)
        at += plain[0].length
        continue
      }
      // `$1`, `$@`, `$_`, a `${…}` this does not read: unknown. A lone `$` is text.
      if (/^\S/.test(chars[at + 1]?.c ?? ' ') && chars[at + 1]?.c !== '/' && chars[at + 1]?.c !== '\\') return null
    }
    if (ch.c === '%' && (dialect === 'cmd' || ch.q !== 'single')) {
      const percent = textFrom(at, /^%([A-Za-z_][A-Za-z0-9_()]*)%/)
      if (percent) {
        const value = variable(percent[1]!, dialect, context, state)
        if (value != null) {
          insert(value)
          at += percent[0].length
          continue
        }
        if (dialect === 'cmd') return null
      }
    }
    out.push(ch)
    at++
  }
  return out
}

/** A word's value as text, for a variable assignment; null when unknown. */
function expandText(word: Word, dialect: Dialect, context: Context, state: State): string | null {
  const chars = characters(word)
  const expanded = chars && expand(chars, dialect, context, state)
  return expanded ? expanded.map((ch) => ch.c).join('') : null
}

/** Every path a target word names, resolved; empty when it cannot be resolved. */
function resolveWords(
  word: Word,
  dialect: Dialect,
  context: Context,
  state: State,
): Resolved[] {
  const chars = characters(word)
  if (!chars || chars.length > MAX_WORD) return []
  const alternatives = dialect === 'bash' ? braceExpand(chars) : [chars]
  if (!alternatives) return []
  const out: Resolved[] = []
  for (const alternative of alternatives) {
    const expanded = expand(alternative, dialect, context, state)
    if (!expanded) continue
    const resolved = resolvePath(expanded, dialect, context, state.cwd)
    if (resolved) out.push(resolved)
  }
  return out
}

function isGlob(ch: Ch, dialect: Dialect): boolean {
  if (dialect === 'bash') return ch.q === 'none' && (ch.c === '*' || ch.c === '?' || ch.c === '[')
  return ch.c === '*' || ch.c === '?'
}

const windowsDrive = /^\/(?:mnt\/)?([A-Za-z])(?=\/|$)/

function resolvePath(
  chars: Ch[],
  dialect: Dialect,
  context: Context,
  cwd: string | null,
): Resolved | null {
  const windows = context.platform === 'win32'
  const p = windows ? path.win32 : path.posix
  const text = chars.map((ch) => ch.c).join('')
  if (text === '') return null
  // Components, keeping which one holds a glob character.
  const components: { text: string; glob: boolean }[] = []
  let current = { text: '', glob: false }
  for (const ch of chars) {
    if (ch.c === '/' || (windows && ch.c === '\\')) {
      components.push(current)
      current = { text: '', glob: false }
      continue
    }
    current.text += ch.c
    if (isGlob(ch, dialect)) current.glob = true
  }
  components.push(current)
  const globAt = components.findIndex((component) => component.glob)
  // A glob before the last component names things inside what it matches.
  const lastNamed = components.map((component) => component.text !== '').lastIndexOf(true)
  if (globAt >= 0 && globAt !== lastNamed) return null
  let literal = globAt >= 0
    ? components.slice(0, globAt).map((component) => component.text).join('/') || (text.startsWith('/') || (windows && text.startsWith('\\')) ? '/' : '.')
    : text
  if (windows) {
    // Git Bash and WSL spell `C:\` as `/c/` and `/mnt/c/`.
    const drive = windowsDrive.exec(literal.replace(/\\/g, '/'))
    if (drive) literal = `${drive[1]!.toUpperCase()}:\\${literal.replace(/\\/g, '/').slice(drive[0].length).replace(/^\//, '')}`
  }
  const absolute = windows ? /^([A-Za-z]:)?[\\/]/.test(literal) : literal.startsWith('/')
  if (!absolute && !cwd) return null
  // A drive-relative `\x` takes the working directory's drive; with none known, C:.
  const base = cwd ?? (windows ? 'C:\\' : '/')
  const resolved = p.resolve(base, literal)
  return { path: resolved, glob: globAt >= 0 ? components[globAt]!.text : null }
}

// ------------------------------------------------------------- the folders

/**
 * The user's own folders in the home folder, by their first components. Not `Public`: a web
 * app's `public` is the usual folder of that name an agent deletes (seen in real commands), and
 * macOS's ~/Public holds little; Windows keeps it at C:\Users\Public, outside any user's home.
 */
const USER_FOLDERS: readonly (readonly string[])[] = [
  ['Desktop'], ['Documents'], ['Downloads'], ['Pictures'], ['Music'],
  ['Videos'], ['Movies'], ['Applications'], ['Dropbox'],
  ['AppData'], ['AppData', 'Roaming'], ['AppData', 'Local'], ['AppData', 'LocalLow'],
  ['Library'], ['Library', 'Application Support'], ['Library', 'Mobile Documents'],
  ['Library', 'Keychains'], ['Library', 'Containers'], ['Library', 'Group Containers'],
  ['.ssh'], ['.gnupg'], ['.config'], ['.local'],
]
/** OneDrive moves these folders into itself on Windows. */
const ONEDRIVE_FOLDERS: readonly string[] = [
  'Desktop', 'Documents', 'Downloads', 'Pictures', 'Music', 'Videos',
]
/** What a glob in the home folder is tried against. */
const HOME_NAMES: readonly string[] = [
  ...new Set(USER_FOLDERS.map((folder) => folder[0]!)),
  'OneDrive', 'OneDrive - Personal',
]

function caseInsensitive(platform: string): boolean {
  return platform === 'win32' || platform === 'darwin'
}

function pathApi(platform: string) {
  return platform === 'win32' ? path.win32 : path.posix
}

/** The components of `child` below `parent`, or null when it is not inside it. */
function below(parent: string, child: string, platform: string): string[] | null {
  const p = pathApi(platform)
  const fold = (value: string) => (caseInsensitive(platform) ? value.toLowerCase() : value)
  const relative = p.relative(fold(parent), fold(child))
  if (relative === '') return []
  if (relative === '..' || relative.startsWith(`..${p.sep}`) || p.isAbsolute(relative)) return null
  // `relative` is folded; take the same components from `child` as written.
  const count = relative.split(p.sep).length
  const parts = p.normalize(child).split(p.sep).filter(Boolean)
  return parts.slice(parts.length - count)
}

/** The user folder these components under the home folder name, as its components are spelled. */
function userFolder(components: string[], platform: string): string[] | null {
  const fold = (value: string) => (caseInsensitive(platform) ? value.toLowerCase() : value)
  const folded = components.map(fold)
  for (const folder of USER_FOLDERS) {
    if (folder.length === folded.length && folder.every((name, at) => fold(name) === folded[at]))
      return [...folder]
  }
  if (folded[0]?.startsWith(fold('OneDrive'))) {
    if (folded.length === 1) return [components[0]!]
    const inner = ONEDRIVE_FOLDERS.find((name) => fold(name) === folded[1])
    if (folded.length === 2 && inner) return [components[0]!, inner]
  }
  return null
}

/**
 * The home folder a path is in by the platform's convention (`/Users/<name>`,
 * `/home/<name>`, `C:\Users\<name>`), or null. Cloud passes this for the
 * folder a device chat runs in, since it does not know the computer's home.
 */
export function inferHomeFolder(platform: string, folder: string): string | null {
  if (platform === 'win32') {
    const match = /^([A-Za-z]:[\\/]Users[\\/][^\\/]+)/i.exec(folder)
    return match ? path.win32.normalize(match[1]!) : null
  }
  const match = platform === 'darwin'
    ? /^\/Users\/[^/]+/.exec(folder)
    : /^(?:\/home\/[^/]+|\/root)(?=\/|$)/.exec(folder)
  return match ? match[0] : null
}

function globMatches(pattern: string, name: string, dialect: Dialect, platform: string): boolean {
  // Bash's `*` skips names that start with a dot; Windows shells' does not.
  if (dialect === 'bash' && name.startsWith('.') && !pattern.startsWith('.')) return false
  let source = ''
  for (let at = 0; at < pattern.length; at++) {
    const ch = pattern[at]!
    if (ch === '*') source += '.*'
    else if (ch === '?') source += '.'
    else if (ch === '[' && dialect === 'bash') {
      const close = pattern.indexOf(']', at + 2)
      if (close < 0) {
        source += '\\['
        continue
      }
      const body = pattern.slice(at + 1, close).replace(/^!/, '^').replace(/\\/g, '\\\\')
      source += `[${body}]`
      at = close
    } else source += ch.replace(/[.+^${}()|\\\]]/g, '\\$&')
  }
  try {
    return new RegExp(`^${source}$`, caseInsensitive(platform) ? 'i' : '').test(name)
  } catch {
    return false
  }
}

/** Whether a pattern takes everything in a folder (`*`, `*.*`). */
function takesEverything(pattern: string, dialect: Dialect, platform: string): boolean {
  if (pattern === '*.*') return true
  return ['Photos', 'report.pdf', 'a'].every((name) => globMatches(pattern, name, dialect, platform))
}

function classify(
  resolved: Resolved,
  context: Context,
): { kind: UserFolderDeleteKind; resolved: string } | null {
  const { platform } = context
  const p = pathApi(platform)
  const homes = [...new Set([context.home, inferHomeFolder(platform, resolved.path)]
    .filter((home): home is string => !!home)
    .map((home) => p.normalize(home)))]
  const isRoot = p.parse(resolved.path).root === p.normalize(resolved.path)
  const dialect: Dialect = 'bash'
  if (resolved.glob === null) {
    for (const home of homes) {
      const inside = below(home, resolved.path, platform)
      if (inside === null) {
        if (below(resolved.path, home, platform) !== null)
          return { kind: 'above-home', resolved: resolved.path }
        continue
      }
      if (inside.length === 0) return { kind: 'home', resolved: resolved.path }
      // Spelled as the folder is, so `downloads` reads as the user's Downloads.
      const folder = userFolder(inside, platform)
      if (folder) return { kind: 'user-folder', resolved: p.join(home, ...folder) }
    }
    return isRoot ? { kind: 'above-home', resolved: resolved.path } : null
  }
  const pattern = resolved.glob
  const named = p.join(resolved.path, pattern)
  for (const home of homes) {
    const inside = below(home, resolved.path, platform)
    if (inside === null) {
      const toHome = below(resolved.path, home, platform)
      if (toHome && toHome.length > 0 && globMatches(pattern, toHome[0]!, dialect, platform))
        return { kind: toHome.length === 1 ? 'home' : 'above-home', resolved: named }
      continue
    }
    if (inside.length === 0) {
      if (HOME_NAMES.some((name) => globMatches(pattern, name, dialect, platform)))
        return { kind: 'user-folder', resolved: named }
      continue
    }
    if (userFolder(inside, platform) && takesEverything(pattern, dialect, platform))
      return { kind: 'user-folder-contents', resolved: named }
    // `~/AppData/*` takes Roaming and Local.
    if (inside.length === 1 && USER_FOLDERS.some((folder) => folder.length === 2 &&
        userFolder([inside[0]!], platform)?.[0] === folder[0] &&
        globMatches(pattern, folder[1]!, dialect, platform)))
      return { kind: 'user-folder', resolved: named }
  }
  return isRoot && takesEverything(pattern, dialect, platform)
    ? { kind: 'above-home', resolved: named }
    : null
}

// ---------------------------------------------------------------- answers

/**
 * A line the walk could refuse names one of the deletes it judges, under any
 * spelling it reads (`\\rm`, `/bin/rm`, `rm.exe`, `Remove-Item`), or carries
 * PowerShell's `-EncodedCommand` (any prefix of it, `-e`, `-ec`), whose
 * command is not on the line as text.
 */
const MAY_DELETE =
  /(^|[^a-z0-9_-])(rm|rmdir|rd|del|erase|remove-item|ri|rimraf)([^a-z0-9_-]|$)|(^|\s)[-/]e[a-z]*(\s|$)/i

/**
 * The recursive delete of the user's home folder, a folder above it, or one
 * of the user's own folders that this command line runs, or null.
 *
 * Commands start in Git Bash on every OS (`run_terminal_command`), so the line
 * is read as bash, and the strings it hands `cmd /c` or `powershell -Command`
 * as those shells read them.
 */
export function refusedUserFolderDelete(
  command: string,
  context: UserFolderDeleteContext,
): RefusedUserFolderDelete | null {
  // Most lines name no delete at all (about 93% of agent commands, 2026-11-26): not read.
  if (!MAY_DELETE.test(command)) return null
  const p = pathApi(context.platform)
  return analyze(command, 'bash', {
    platform: context.platform,
    home: context.home ? p.normalize(context.home) : null,
    env: context.env ?? {},
    linuxHome: false,
  }, {
    cwd: context.cwd ? p.normalize(context.cwd) : null,
    vars: new Map(),
  }, 0)
}

/**
 * The sentence the model reads instead of the command's output. `projectRoot`
 * is the folder the chat works in, named so the model has somewhere to go.
 */
export function userFolderDeleteRefusal(
  refused: RefusedUserFolderDelete,
  options: { platform: string; projectRoot?: string | null },
): string {
  const { platform } = options
  const p = pathApi(platform)
  const shown = (value: string) => (platform === 'win32' ? value.replace(/\\/g, '/') : value)
  const name = p.basename(refused.resolved)
  const globbed = /[*?[]/.test(name)
  const what =
    refused.kind === 'home'
      ? globbed
        ? `${refused.resolved} takes the user's home folder`
        : `it would delete the user's home folder (${refused.resolved})`
      : refused.kind === 'above-home'
        ? `it would delete ${refused.resolved}, which holds the user's home folder`
        : refused.kind === 'user-folder-contents'
          ? `it would delete everything in ${p.dirname(refused.resolved)}, the user's own ${p.basename(p.dirname(refused.resolved))} folder`
          : globbed
            ? `${refused.resolved} takes the user's own folders in their home folder`
            : `it would delete ${refused.resolved}, the user's own ${name} folder`
  const written = refused.target.split(/[\\/]/).filter(Boolean).pop() ?? ''
  const caseNote = caseInsensitive(platform) && refused.kind === 'user-folder' &&
    written !== name && written.toLowerCase() === name.toLowerCase()
    ? ` Folder names are not case-sensitive on ${platform === 'win32' ? 'Windows' : 'macOS'}, so \`${written}\` is that folder.`
    : ''
  const root = options.projectRoot ? p.normalize(options.projectRoot) : null
  const home = root ? inferHomeFolder(platform, root) : null
  const rootIsHome = !root || (home !== null && below(root, home, platform) !== null)
  const instead = rootIsHome
    ? `This chat's folder is the user's home folder, so put anything you create in a new folder of your own (for example \`mkdir -p ~/freebuff-scratch\`) and delete only paths inside it, by their full path.`
    : `Delete only what you created, by its full path inside the project folder (for example \`rm -rf "${shown(p.join(root!, 'shots'))}"\`), never by a bare name from another directory.`
  return `Refused \`${refused.invocation} ${refused.target}\`: ${what}.${caseNote} Nothing ran. An agent may never recursively delete the user's home folder, a folder above it, or the user's own folders in it (Desktop, Documents, Downloads, Pictures, Music, Videos, OneDrive, AppData, Library). ${instead} If the user asked for this, tell them to delete it themselves.`
}
