/**
 * Shell commands a sponsored run may not use, whatever the procedure says
 * (COD-665, interim).
 *
 * Three classes, each drawn from a run that went past the intended boundary:
 *
 * - `wsl`: entering the Windows Subsystem for Linux, which is the user's own
 *   Linux environment with its own home directory and credentials;
 * - `database`: dropping, resetting, wiping, rolling back or force-seeding a
 *   database, which may be one the user's main checkout (or production) uses;
 * - `container`: building, starting, stopping, removing or pushing containers
 *   and images, which may be the user's running services.
 *
 * Like the install refusal, these are sentences the MODEL reads, answered
 * before the command reaches a shell. What they cover and what they do not is
 * in `docs/freebuff-sponsored-local-execution.md` §9.
 */

export type SponsoredCommandRefusalKind = 'wsl' | 'database' | 'container'

export type SponsoredRefusedCommand = {
  kind: SponsoredCommandRefusalKind
  /** The invocation named in the refusal, e.g. `docker compose up`. */
  invocation: string
}

/**
 * `quoted` is true when any part of the word was quoted; `literal` when every
 * quoted part was single-quoted, so `$(…)` and backticks inside it are text.
 */
type Token = { text: string; quoted: boolean; literal: boolean }

const MAX_DEPTH = 6

// ------------------------------------------------------------------- lexing

/**
 * Split a command line into simple commands, respecting quotes.
 *
 * `;`, `&`, `|`, parentheses, braces, backticks, `$(` and newlines end a
 * command outside quotes; `&` inside a redirection (`2>&1`, `&>`) does not.
 * Backslashes are literal, because Windows paths are the common case here.
 */
function lexCommandLine(command: string): Token[][] {
  const segments: Token[][] = []
  let current: Token[] = []
  let text = ''
  let quoted = false
  let expands = false
  let inToken = false
  const endToken = () => {
    if (inToken) current.push({ text, quoted, literal: quoted && !expands })
    text = ''
    quoted = false
    expands = false
    inToken = false
  }
  const endSegment = () => {
    endToken()
    if (current.length > 0) segments.push(current)
    current = []
  }
  for (let index = 0; index < command.length; index++) {
    const ch = command[index]!
    if (ch === '"' || ch === "'") {
      const close = command.indexOf(ch, index + 1)
      text += command.slice(index + 1, close < 0 ? command.length : close)
      quoted = true
      if (ch === '"') expands = true
      inToken = true
      index = close < 0 ? command.length : close
      continue
    }
    if (ch === '\n' || ch === '\r') {
      endSegment()
      continue
    }
    if (/\s/.test(ch)) {
      endToken()
      continue
    }
    if (
      ch === '&' &&
      (command[index - 1] === '>' ||
        command[index - 1] === '<' ||
        command[index + 1] === '>')
    ) {
      text += ch
      inToken = true
      continue
    }
    if (';&|(){}`'.includes(ch)) {
      endSegment()
      continue
    }
    if (ch === '$' && command[index + 1] === '(') {
      endSegment()
      index++
      continue
    }
    text += ch
    inToken = true
  }
  endSegment()
  return segments
}

/**
 * `C:\Program Files\Docker\docker.exe` → `docker`; `bin/rails` → `rails`;
 * `prisma@5` → `prisma`.
 */
function commandName(token: string): string {
  const base = token.split(/[\\/]/).pop() ?? token
  return base
    .toLowerCase()
    .replace(/(.)@[^@]*$/, '$1')
    .replace(/\.(exe|cmd|bat|com|ps1)$/, '')
}

function isFlag(token: string): boolean {
  return token.startsWith('-')
}

/**
 * The non-flag arguments, lowercased, with `--` dropped, and without the value
 * of any option in `valueOptions` (`prisma --schema x.prisma migrate reset`).
 */
function words(
  tokens: Token[],
  valueOptions: ReadonlySet<string> = NO_OPTIONS,
): string[] {
  const out: string[] = []
  for (let index = 0; index < tokens.length; index++) {
    const text = tokens[index]!.text
    if (text === '--') continue
    if (isFlag(text)) {
      if (!text.includes('=') && valueOptions.has(text.toLowerCase())) index++
      continue
    }
    out.push(text.toLowerCase())
  }
  return out
}

const NO_OPTIONS: ReadonlySet<string> = new Set()

function flags(tokens: Token[]): string[] {
  return tokens
    .map((token) => token.text.toLowerCase())
    .filter((text) => isFlag(text))
}

// ---------------------------------------------------------------------- wsl

const WSL_COMMANDS: ReadonlySet<string> = new Set(['wsl', 'wslg', 'wslconfig'])

/**
 * Distribution launchers from the Store run the same Linux user as `wsl`.
 * Windows only: on Linux `alpine` and `debian` name other programs.
 */
const WSL_DISTRO_LAUNCHER =
  /^(ubuntu[\d.]*|debian|kali|opensuse[-\w.]*|sles[-\w.]*|oraclelinux[\w.]*|almalinux[\w.]*|fedoraremix|alpine)$/

/**
 * `\\wsl$\Ubuntu\home\…` and `\\wsl.localhost\…` reach the same files, as do
 * the long-path spellings `\\?\UNC\wsl$\…` and `\\.\UNC\wsl.localhost\…`.
 */
const WSL_SHARE = /(?:\\\\|\/\/|\bunc[\\/])wsl(?:\$|\.localhost)(?:[\\/]|$)/i

/**
 * On Windows a bare `bash` is `System32\bash.exe` — the WSL launcher — unless
 * something earlier on PATH shadows it, so it is refused. A spelled-out path
 * elsewhere (Git Bash's own `bash.exe`) is not WSL and is not refused.
 */
function isWindowsWslBash(token: string, platform: string): boolean {
  if (platform !== 'win32' || commandName(token) !== 'bash') return false
  if (!/[\\/]/.test(token)) return true
  return /[\\/](system32|sysnative)[\\/]/i.test(token)
}

// ----------------------------------------------------------------- database

const SQL_CLIENTS: ReadonlySet<string> = new Set([
  'psql',
  'pgcli',
  'mysql',
  'mariadb',
  'mycli',
  'sqlite3',
  'sqlcmd',
  'cockroach',
  'mongo',
  'mongosh',
  'clickhouse-client',
  'turso',
  'wrangler',
])

const DESTRUCTIVE_SQL =
  /\b(?:drop\s+(?:database|schema|table|owned|column)\b|truncate\s+(?:table\s+)?[\w"`[]|dropdatabase\s*\()|\.drop\s*\(\s*\)|\.(?:deletemany|remove)\s*\(\s*\{\s*\}\s*\)/i

/**
 * `DELETE FROM users` with no `WHERE`: the table name followed by `;` or the
 * end of the text. See `linePassesDestructiveSql` for which texts are judged.
 */
const UNBOUNDED_DELETE = /\bdelete\s+from\s+[^\s;]+\s*(?:;|$)/i

/**
 * Commands that only SEARCH text. A line such as
 * `rg "drop table" migrations && psql -c "select 1"` mentions the SQL without
 * sending it, so their arguments are left out of the SQL judgement.
 */
const TEXT_SEARCH_COMMANDS: ReadonlySet<string> = new Set([
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'ag',
  'ack',
  'git',
  'findstr',
  'select-string',
  'sls',
])

type DatabaseRule = (args: Token[]) => string | null

const firstWordIs =
  (pattern: RegExp, valueOptions?: ReadonlySet<string>): DatabaseRule =>
  (args) => {
    const [first] = words(args, valueOptions)
    return first && pattern.test(first) ? first : null
  }

/** Options that take a separate value, so it is not read as the subcommand. */
const PRISMA_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '--schema',
  '--config',
  '--name',
  '-n',
  '--url',
  '--file',
])
const DRIZZLE_VALUE_OPTIONS: ReadonlySet<string> = new Set(['--config'])
const ALEMBIC_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '-c',
  '--config',
  '-n',
  '--name',
  '-x',
])
const SUPABASE_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '--workdir',
  '--profile',
  '-o',
  '--output',
  '--project-ref',
  '--db-url',
  '--network-id',
  '--dns-resolver',
])

/** Django's `flush`, `reset_db` and `migrate <app> zero`. */
const djangoRule: DatabaseRule = (args) => {
  const list = words(args, new Set(['--settings', '--database']))
  const [first] = list
  if (first === 'flush' || first === 'reset_db') return first
  return first === 'migrate' && list.includes('zero') ? 'migrate … zero' : null
}

const anyWordIs =
  (pattern: RegExp): DatabaseRule =>
  (args) =>
    words(args).find((word) => pattern.test(word)) ?? null

const RAILS_DESTRUCTIVE =
  /^db:(drop|reset|purge|setup|truncate_all|rollback|schema:load|migrate:reset|migrate:redo|seed:replant)(:|$)/

const ARTISAN_DESTRUCTIVE = /^(migrate:(fresh|refresh|reset|rollback)|db:wipe)$/

/** Keyed by `commandName` of the executable, after runners are unwrapped. */
const DATABASE_RULES: ReadonlyMap<string, DatabaseRule> = new Map(
  Object.entries<DatabaseRule>({
    prisma: (args) => {
      const [first, second] = words(args, PRISMA_VALUE_OPTIONS)
      if (first === 'migrate' && second === 'reset') return 'migrate reset'
      const forced = flags(args).find((flag) =>
        /^--(force-reset|accept-data-loss)(=|$)/.test(flag),
      )
      return forced ? [first, second, forced].filter(Boolean).join(' ') : null
    },
    'drizzle-kit': firstWordIs(/^(push|drop)(:|$)/, DRIZZLE_VALUE_OPTIONS),
    dropdb: () => '',
    dropuser: () => '',
    mysqladmin: anyWordIs(/^drop$/),
    'redis-cli': anyWordIs(/^(flushall|flushdb)$/),
    knex: anyWordIs(/^migrate:(rollback|down)$/),
    sequelize: anyWordIs(/^db:(drop|migrate:undo(:all)?|seed:undo(:all)?)$/),
    'sequelize-cli': anyWordIs(
      /^db:(drop|migrate:undo(:all)?|seed:undo(:all)?)$/,
    ),
    rails: anyWordIs(RAILS_DESTRUCTIVE),
    rake: anyWordIs(RAILS_DESTRUCTIVE),
    artisan: (args) => {
      const [first] = words(args)
      if (!first) return null
      if (ARTISAN_DESTRUCTIVE.test(first)) return first
      const forced = flags(args).includes('--force')
      return forced && /^(migrate|db:seed)(:|$)/.test(first)
        ? `${first} --force`
        : null
    },
    'manage.py': djangoRule,
    'django-admin': djangoRule,
    alembic: firstWordIs(/^downgrade$/, ALEMBIC_VALUE_OPTIONS),
    mix: anyWordIs(/^ecto\.(drop|reset|rollback)$/),
    typeorm: anyWordIs(/^(schema:drop|schema:sync|migration:revert)$/),
    'typeorm-ts-node-commonjs': anyWordIs(
      /^(schema:drop|schema:sync|migration:revert)$/,
    ),
    'typeorm-ts-node-esm': anyWordIs(
      /^(schema:drop|schema:sync|migration:revert)$/,
    ),
    supabase: (args) => {
      const [first, second] = words(args, SUPABASE_VALUE_OPTIONS)
      return first === 'db' && second === 'reset' ? 'db reset' : null
    },
    flyway: anyWordIs(/^clean$/),
    liquibase: anyWordIs(/^(drop-all|dropall)$/),
    dotnet: (args) => {
      const [first, second, third, fourth] = words(args)
      if (first !== 'ef' || second !== 'database') return null
      if (third === 'drop') return 'ef database drop'
      // `update 0` reverts every migration.
      return third === 'update' && fourth === '0'
        ? 'ef database update 0'
        : null
    },
  }),
)

// `db` only as its own word or at an edge (`db:reset`, `dbreset`, `api-db`),
// so `feedback:reset` is not read as a database script.
const DB_SCRIPT_SUBJECT =
  /((^|[^a-z])db|db([^a-z]|$)|database|prisma|drizzle|schema|migrat|sql|postgres|mysql|mongo|redis|seed)/
const DB_SCRIPT_VERB =
  /(^|[:\-_])(reset|drop|fresh|wipe|nuke|purge|truncate|flush|push|rollback|down|undo|revert|clean|clear|destroy|recreate)([:\-_]|$)/

/**
 * A `package.json` script name that states a destructive database action
 * (`db:reset`, `db:push`, `prisma:reset`), or a seed forced past its guard.
 * Script BODIES are not read; see the doc.
 */
function refusedDatabaseScript(script: string, args: Token[]): boolean {
  const name = script.toLowerCase()
  if (!DB_SCRIPT_SUBJECT.test(name)) return false
  if (DB_SCRIPT_VERB.test(name)) return true
  const forcedFlags = flags(args)
  if (
    /seed/.test(name) &&
    forcedFlags.some((flag) => /^--force(=|$)/.test(flag))
  )
    return true
  return forcedFlags.some((flag) =>
    /^--(force-reset|accept-data-loss)(=|$)/.test(flag),
  )
}

const CONTAINER_SCRIPT_SUBJECT =
  /(^|[:\-_])(docker|compose|podman|container|containers)([:\-_]|$)/
const CONTAINER_SCRIPT_READ =
  /(^|[:\-_])(ps|logs|config|ls|images|version|status|lint)([:\-_]|$)/

/**
 * A script NAMED for a container action (`docker:up`, `compose:restart`,
 * `build:docker`), unless the name says it only reads (`docker:logs`). The
 * container class refuses everything but reads, and a script is the usual
 * way a repository spells `docker compose up`.
 */
function refusedContainerScript(script: string): boolean {
  const name = script.toLowerCase()
  return (
    CONTAINER_SCRIPT_SUBJECT.test(name) && !CONTAINER_SCRIPT_READ.test(name)
  )
}

/** The refusal for running the script or task `name`, or null. */
function refusedScript(
  runner: string,
  name: string,
  args: Token[],
): SponsoredRefusedCommand | null {
  if (refusedDatabaseScript(name, args)) {
    return { kind: 'database', invocation: `${runner} ${name}` }
  }
  if (refusedContainerScript(name)) {
    return { kind: 'container', invocation: `${runner} ${name}` }
  }
  return null
}

// ---------------------------------------------------------------- container

const CONTAINER_ENGINES: ReadonlySet<string> = new Set([
  'docker',
  'podman',
  'nerdctl',
])
const COMPOSE_COMMANDS: ReadonlySet<string> = new Set([
  'docker-compose',
  'podman-compose',
])

/** Top-level engine subcommands that only read. Everything else is refused. */
const ENGINE_READ_ONLY: ReadonlySet<string> = new Set([
  'ps',
  'images',
  'logs',
  'inspect',
  'version',
  'info',
  'help',
  'stats',
  'top',
  'port',
  'diff',
  'history',
  'search',
  'events',
])

/** Management commands whose SECOND word decides (`docker image ls`). */
const ENGINE_MANAGEMENT: ReadonlySet<string> = new Set([
  'container',
  'image',
  'volume',
  'network',
  'context',
  'system',
  'builder',
  'buildx',
  'plugin',
  'swarm',
  'node',
  'service',
  'stack',
  'secret',
  'config',
  'manifest',
  'trust',
  'machine',
  'pod',
])

const MANAGEMENT_READ_ONLY: ReadonlySet<string> = new Set([
  'ls',
  'list',
  'inspect',
  'history',
  'logs',
  'ps',
  'df',
  'info',
  'show',
  'top',
  'port',
  'stats',
  'events',
  'diff',
  'exists',
  'version',
  'help',
])

const COMPOSE_READ_ONLY: ReadonlySet<string> = new Set([
  'ps',
  'ls',
  'config',
  'convert',
  'logs',
  'images',
  'top',
  'port',
  'version',
  'events',
  'help',
  'stats',
])

/** Global options that take a separate value (`-H host`, `-f file`). */
const ENGINE_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '-h',
  '--host',
  '-c',
  '--context',
  '--config',
  '-l',
  '--log-level',
  '--tlscacert',
  '--tlscert',
  '--tlskey',
  '--connection',
  '--url',
  '--root',
  '--runroot',
  '--storage-driver',
  '--namespace',
  '-n',
  '--address',
  '-a',
])
const COMPOSE_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '-f',
  '--file',
  '-p',
  '--project-name',
  '--project-directory',
  '--env-file',
  '--profile',
  '--ansi',
  '--progress',
  '--parallel',
])

/**
 * The index of the first word after `start` that is not an option. An option
 * we do not know to take a value is assumed not to; if it did, its value is
 * read as the subcommand, is not on a read-only list, and is refused.
 */
function nextWord(
  tokens: Token[],
  start: number,
  valueOptions: ReadonlySet<string>,
): number {
  let index = start
  while (index < tokens.length) {
    const text = tokens[index]!.text
    if (text === '--') return index + 1
    if (!isFlag(text)) return index
    index += !text.includes('=') && valueOptions.has(text.toLowerCase()) ? 2 : 1
  }
  return index
}

function composeRefusal(prefix: string, args: Token[]): string | null {
  const index = nextWord(args, 0, COMPOSE_VALUE_OPTIONS)
  const sub = args[index]?.text.toLowerCase()
  if (!sub || COMPOSE_READ_ONLY.has(sub)) return null
  return `${prefix} ${sub}`
}

function containerRefusal(head: string, args: Token[]): string | null {
  if (COMPOSE_COMMANDS.has(head)) return composeRefusal(head, args)
  const index = nextWord(args, 0, ENGINE_VALUE_OPTIONS)
  const sub = args[index]?.text.toLowerCase()
  if (!sub) return null
  if (sub === 'compose') {
    return composeRefusal(`${head} compose`, args.slice(index + 1))
  }
  if (ENGINE_MANAGEMENT.has(sub)) {
    const rest = args.slice(index + 1)
    const second = rest[nextWord(rest, 0, new Set())]?.text.toLowerCase()
    if (!second || MANAGEMENT_READ_ONLY.has(second)) return null
    return `${head} ${sub} ${second}`
  }
  return ENGINE_READ_ONLY.has(sub) ? null : `${head} ${sub}`
}

// ----------------------------------------------------------------- wrappers

/**
 * Words that run the command after them (`sudo docker …`, `env X=1 knex …`),
 * each with the options that take a separate value (`sudo -u root docker …`,
 * `timeout -s KILL 10 docker …`), so the value is not read as the command.
 */
const PREFIX_COMMANDS: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  Object.entries({
    sudo: ['-u', '-g', '-h', '-p', '-c', '-r', '-t', '-d'],
    doas: ['-u', '-c'],
    env: ['-u', '-c', '--unset', '--chdir'],
    exec: ['-a'],
    command: [],
    builtin: [],
    nohup: [],
    time: ['-f', '-o', '--format', '--output'],
    nice: ['-n', '--adjustment'],
    timeout: ['-s', '-k', '--signal', '--kill-after'],
    xargs: ['-i', '-n', '-p', '-l', '-s', '-d', '-e', '-a'],
    watch: ['-n', '--interval'],
    stdbuf: ['-i', '-o', '-e'],
    caffeinate: ['-t', '-w'],
    unbuffer: [],
    'cross-env': [],
    'cross-env-shell': [],
    dotenv: ['-e', '-c', '-v', '-p'],
    'env-cmd': ['-f', '-e', '--file', '--environments'],
    call: [],
    source: [],
    '.': [],
  }).map(([name, options]) => [name, new Set(options)]),
)

/**
 * `bundle exec rails …`, `npm exec prisma …`, `bun x drizzle-kit …`, and the
 * secret injectors that run a command after `--` (`infisical run --env dev --
 * npx prisma migrate reset`).
 */
const TWO_WORD_PREFIXES: Record<string, ReadonlySet<string>> = {
  bundle: new Set(['exec']),
  poetry: new Set(['run']),
  uv: new Set(['run']),
  pipenv: new Set(['run']),
  pdm: new Set(['run']),
  npm: new Set(['exec', 'x']),
  pnpm: new Set(['exec', 'dlx']),
  yarn: new Set(['exec', 'dlx']),
  bun: new Set(['x']),
  infisical: new Set(['run']),
  op: new Set(['run']),
  doppler: new Set(['run']),
  dotenvx: new Set(['run']),
}

/**
 * Wrappers whose own options end at `--`: for these, the command is whatever
 * follows the first `--`, however many option values came before it.
 */
const DASH_DASH_WRAPPERS: ReadonlySet<string> = new Set([
  'dotenv',
  'env-cmd',
  'cross-env',
  'infisical',
  'op',
  'doppler',
  'dotenvx',
  'npm',
  'pnpm',
  'yarn',
  'bun',
])

/** Task runners whose every plain word is a script or target NAME. */
const TASK_RUNNERS: ReadonlySet<string> = new Set([
  'turbo',
  'nx',
  'make',
  'gmake',
  'just',
  'task',
  'npm-run-all',
  'npm-run-all2',
  'run-s',
  'run-p',
  'lerna',
])

/**
 * Task-runner options whose value is a directory, file or package rather than
 * a task (`make -C docker build`, `turbo run build --filter docker-app`).
 */
const TASK_RUNNER_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '-c',
  '--directory',
  '-f',
  '--file',
  '--makefile',
  '--filter',
  '--scope',
  '--projects',
  '-p',
  '--cwd',
  '--dir',
  '--justfile',
  '--working-directory',
  '-d',
])

/** Runners whose quoted arguments are each a whole command line. */
const COMMAND_LIST_RUNNERS: ReadonlySet<string> = new Set([
  'concurrently',
  'parallel',
])

const PACKAGE_RUNNERS: ReadonlySet<string> = new Set(['npx', 'bunx', 'pnpx'])
const SCRIPT_RUNNERS: ReadonlySet<string> = new Set([
  'npm',
  'pnpm',
  'yarn',
  'bun',
])
const POSIX_SHELLS: ReadonlySet<string> = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'fish',
])
const POWERSHELLS: ReadonlySet<string> = new Set(['powershell', 'pwsh'])
const POWERSHELL_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  'executionpolicy',
  'ex',
  'ep',
  'windowstyle',
  'w',
  'outputformat',
  'o',
  'inputformat',
  'if',
  'configurationname',
  'workingdirectory',
  'wd',
  'version',
  'v',
  'psconsolefile',
  'settingsfile',
])
const SCRIPT_RUNNER_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '--filter',
  '-f',
  '--prefix',
  '-c',
  '--cwd',
  '--dir',
  '-w',
  '--workspace',
])
const PYTHONS = /^(python[\d.]*|py)$/

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

/**
 * The index of the `--` that ends a wrapper's own options, or -1. Only options,
 * their values and `VAR=x` may come before it: in
 * `npm exec prisma migrate reset -- --force` the `--` belongs to prisma.
 */
function wrapperDashDash(tokens: Token[], start: number): number {
  for (let index = start; index < tokens.length; index++) {
    const text = tokens[index]!.text
    if (text === '--') return index
    if (isFlag(text) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(text)) continue
    const previous = index > start ? tokens[index - 1]!.text : ''
    if (isFlag(previous) && !previous.includes('=')) continue
    return -1
  }
  return -1
}

/** Analyse a command STRING handed to a wrapper: re-lex it if quoted. */
function analyzeRest(
  rest: Token[],
  platform: string,
  depth: number,
): SponsoredRefusedCommand | null {
  // `sh -c -- "…"`: the `--` ends the shell's options.
  if (rest[0]?.text === '--' && !rest[0].quoted) rest = rest.slice(1)
  if (rest.length === 0) return null
  if (rest[0]!.quoted) return analyzeCommandLine(rest[0]!.text, platform, depth)
  return analyzeSegment(rest, platform, depth)
}

/**
 * The index of the command a segment runs, past `VAR=x` assignments and the
 * wrappers that run the command after them (`sudo`, `env`, `npm exec` …).
 */
function commandStart(tokens: Token[]): number {
  let index = 0
  while (index < tokens.length) {
    const token = tokens[index]!
    const name = commandName(token.text)
    if (!token.quoted && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token.text)) {
      index++
      continue
    }
    const valueOptions = PREFIX_COMMANDS.get(name)
    const second = tokens[index + 1]?.text.toLowerCase()
    const twoWord = !!second && !!TWO_WORD_PREFIXES[name]?.has(second)
    if (!valueOptions && !twoWord) break
    index += twoWord ? 2 : 1
    const dashDash = DASH_DASH_WRAPPERS.has(name)
      ? wrapperDashDash(tokens, index)
      : -1
    if (dashDash >= 0) {
      index = dashDash + 1
      continue
    }
    while (index < tokens.length) {
      const text = tokens[index]!.text
      if (isFlag(text)) {
        index +=
          !text.includes('=') && valueOptions?.has(text.toLowerCase()) ? 2 : 1
      } else if (
        /^\d+(\.\d+)?[smhd]?$/.test(text) ||
        /^[A-Za-z_][A-Za-z0-9_]*=/.test(text)
      ) {
        index++
      } else {
        break
      }
    }
  }
  return index
}

/**
 * Whether this segment runs an interpreter that reads its commands from
 * stdin: `… | bash`, `bash <<< "…"`, `… | powershell -`, `… | iex`.
 */
function readsCommandsFromStdin(tokens: Token[]): boolean {
  const start = commandStart(tokens)
  const headToken = tokens[start]
  if (!headToken) return false
  const head = commandName(headToken.text)
  const args = tokens.slice(start + 1)
  if (POSIX_SHELLS.has(head)) {
    if (args.some((t) => t.text === '-s' || t.text === '-')) return true
    if (args.some((t) => /^-[A-Za-z]*c[A-Za-z]*$/.test(t.text))) return false
    const script = args.find((t) => !isFlag(t.text))
    return !script || script.text.startsWith('<')
  }
  if (head === 'cmd') return !args.some((t) => /^\/[ck]/i.test(t.text))
  if (POWERSHELLS.has(head)) {
    return args.length === 0 || args.some((t) => t.text === '-')
  }
  if (head === 'iex' || head === 'invoke-expression') return args.length === 0
  return false
}

function analyzeSegment(
  tokens: Token[],
  platform: string,
  depth: number,
): SponsoredRefusedCommand | null {
  if (depth > MAX_DEPTH) return null

  // A double-quoted argument still runs `$(…)` and backticks inside it; a
  // single-quoted one (`echo 'run \`docker compose up\`' >> README.md`) does
  // not.
  for (const token of tokens) {
    if (!token.quoted || token.literal) continue
    const nested = /\$\(|`/.exec(token.text)
    if (nested) {
      const found = analyzeCommandLine(
        token.text.slice(nested.index + nested[0].length),
        platform,
        depth + 1,
      )
      if (found) return found
    }
  }

  const index = commandStart(tokens)
  const headToken = tokens[index]
  if (!headToken) return null
  const head = commandName(headToken.text)
  const args = tokens.slice(index + 1)

  // A quoted command line where a program was expected: `npx -c "…"`,
  // `npm exec -c "…"`, `& "docker compose up"`. A quoted path with a space in
  // it (`"C:\Program Files\…\bash.exe"`) re-lexes to nothing and falls through.
  if (headToken.quoted && /\s/.test(headToken.text.trim())) {
    const found = analyzeCommandLine(headToken.text, platform, depth + 1)
    if (found) return found
  }

  // ---- wsl
  if (
    WSL_COMMANDS.has(head) ||
    (platform === 'win32' && WSL_DISTRO_LAUNCHER.test(head)) ||
    isWindowsWslBash(headToken.text, platform)
  ) {
    return { kind: 'wsl', invocation: head }
  }

  // ---- wrappers that run a command string
  if (POSIX_SHELLS.has(head)) {
    const flagIndex = args.findIndex(
      (token) =>
        token.text === '--command' ||
        (/^-[A-Za-z]*c[A-Za-z]*$/.test(token.text) && !token.quoted),
    )
    return flagIndex < 0
      ? null
      : analyzeRest(args.slice(flagIndex + 1), platform, depth + 1)
  }
  if (head === 'cmd') {
    const flagIndex = args.findIndex((token) => /^\/[ck]/i.test(token.text))
    if (flagIndex < 0) return null
    // `cmd /c"wsl ls"` reaches us as the one word `/cwsl ls`.
    const attached = args[flagIndex]!.text.slice(2)
    return attached
      ? analyzeCommandLine(
          [attached, ...args.slice(flagIndex + 1).map((t) => t.text)].join(' '),
          platform,
          depth + 1,
        )
      : analyzeRest(args.slice(flagIndex + 1), platform, depth + 1)
  }
  if (POWERSHELLS.has(head)) {
    let flagIndex = 0
    while (flagIndex < args.length) {
      const text = args[flagIndex]!.text
      // Windows PowerShell reads its first plain argument as the command.
      if (!/^[-/]/.test(text) || args[flagIndex]!.quoted) {
        return analyzeRest(args.slice(flagIndex), platform, depth + 1)
      }
      const option = text.slice(1).toLowerCase()
      if (option.length > 0 && 'command'.startsWith(option)) {
        return analyzeRest(args.slice(flagIndex + 1), platform, depth + 1)
      }
      if (
        option === 'ec' ||
        (option.length > 0 && 'encodedcommand'.startsWith(option))
      ) {
        const decoded = decodePowerShellCommand(args[flagIndex + 1]?.text ?? '')
        return decoded === null
          ? null
          : analyzeCommandLine(decoded, platform, depth + 1)
      }
      if (option.length > 0 && 'file'.startsWith(option)) return null
      flagIndex += POWERSHELL_VALUE_OPTIONS.has(option) ? 2 : 1
    }
    return null
  }
  if (head === 'iex' || head === 'invoke-expression' || head === 'eval') {
    return analyzeCommandLine(
      args.map((token) => token.text).join(' '),
      platform,
      depth + 1,
    )
  }
  if (head === 'start' || head === 'start-process' || head === 'saps') {
    const rest = args.filter(
      (token) =>
        !(token.quoted && token.text === '') &&
        !/^(\/\w+|-(filepath|nonewwindow|wait|passthru|windowstyle|verb))$/i.test(
          token.text,
        ),
    )
    return analyzeSegment(rest, platform, depth + 1)
  }
  if (COMMAND_LIST_RUNNERS.has(head)) {
    for (const token of args) {
      const shorthand = /^(npm|pnpm|yarn|bun):(.+)$/i.exec(token.text)
      const found = shorthand
        ? refusedScript(`${shorthand[1]!.toLowerCase()} run`, shorthand[2]!, [])
        : token.quoted
          ? analyzeCommandLine(token.text, platform, depth + 1)
          : null
      if (found) return found
    }
    return null
  }
  if (TASK_RUNNERS.has(head)) {
    // `turbo run db:reset`, `nx run api:db-reset`, `make db-reset`,
    // `run-s db:reset build`: judged by the task NAME, like a package script.
    for (const name of words(args, TASK_RUNNER_VALUE_OPTIONS)) {
      if (name === 'run' || name.includes('=')) continue
      const found = refusedScript(head, name, args)
      if (found) return found
    }
    return null
  }

  // ---- package runners
  if (PACKAGE_RUNNERS.has(head)) {
    let start = 0
    while (start < args.length && isFlag(args[start]!.text)) {
      start += /^(-p|--package)$/.test(args[start]!.text) ? 2 : 1
    }
    return analyzeSegment(args.slice(start), platform, depth + 1)
  }
  if (SCRIPT_RUNNERS.has(head)) {
    let start = nextWord(args, 0, SCRIPT_RUNNER_VALUE_OPTIONS)
    const first = args[start]?.text.toLowerCase()
    if (head === 'yarn' && first === 'workspace') {
      // `yarn workspace <name> [run] <script>`
      start = nextWord(args, start + 2, NO_OPTIONS)
    }
    if (
      args[start]?.text.toLowerCase() === 'run' ||
      args[start]?.text.toLowerCase() === 'run-script'
    ) {
      start = nextWord(args, start + 1, SCRIPT_RUNNER_VALUE_OPTIONS)
    } else if (head === 'npm') {
      return null
    }
    const target = args[start]
    if (!target) return null
    const targetArgs = args.slice(start + 1)
    const found = refusedScript(`${head} run`, target.text, targetArgs)
    if (found) return found
    // `yarn prisma migrate reset`, `bun run drizzle-kit push`.
    return analyzeSegment([target, ...targetArgs], platform, depth + 1)
  }

  // ---- database
  if (PYTHONS.test(head)) {
    // `python -m django flush`, `python -m alembic downgrade base`.
    const moduleFlag = args.findIndex((token) => token.text === '-m')
    if (moduleFlag >= 0) {
      const module = args[moduleFlag + 1]?.text.toLowerCase() ?? ''
      const rule = DATABASE_RULES.get(
        module === 'django' ? 'django-admin' : module,
      )
      const found = rule?.(args.slice(moduleFlag + 2)) ?? null
      return found === null
        ? null
        : { kind: 'database', invocation: `python -m ${module} ${found}` }
    }
    const script = args.find((token) => !isFlag(token.text))
    if (script && commandName(script.text) === 'manage.py') {
      const found = DATABASE_RULES.get('manage.py')!(
        args.slice(args.indexOf(script) + 1),
      )
      if (found !== null)
        return { kind: 'database', invocation: `manage.py ${found}` }
    }
    return null
  }
  if (head === 'php') {
    const script = args.find((token) => !isFlag(token.text))
    if (script && commandName(script.text) === 'artisan') {
      const found = DATABASE_RULES.get('artisan')!(
        args.slice(args.indexOf(script) + 1),
      )
      if (found !== null)
        return { kind: 'database', invocation: `artisan ${found}` }
    }
    return null
  }
  if (SQL_CLIENTS.has(head)) return null // judged on the whole line, below
  const rule = DATABASE_RULES.get(head)
  if (rule) {
    const found = rule(args)
    if (found !== null) {
      return {
        kind: 'database',
        invocation: found ? `${head} ${found}` : head,
      }
    }
    return null
  }

  // ---- container
  if (CONTAINER_ENGINES.has(head) || COMPOSE_COMMANDS.has(head)) {
    const found = containerRefusal(head, args)
    if (found) return { kind: 'container', invocation: found }
  }
  return null
}

function segmentRunsSqlClient(tokens: Token[]): string | null {
  for (const token of tokens) {
    const name = commandName(token.text)
    if (SQL_CLIENTS.has(name)) return name
  }
  // `prisma db execute --stdin` sends whatever reaches it to the database.
  const list = words(tokens)
  const prisma = list.findIndex((word) => commandName(word) === 'prisma')
  if (
    prisma >= 0 &&
    list[prisma + 1] === 'db' &&
    list[prisma + 2] === 'execute'
  ) {
    return 'prisma db execute'
  }
  return null
}

/**
 * Whether the text a SQL client on this line could receive — its arguments,
 * a pipe into it, a heredoc — drops, truncates or empties something. Segments
 * that only search text (`rg "drop table" …`) are left out.
 */
function linePassesDestructiveSql(
  command: string,
  segments: Token[][],
): boolean {
  const sent = segments.filter((segment) => {
    const head = segment[commandStart(segment)]
    return !head || !TEXT_SEARCH_COMMANDS.has(commandName(head.text))
  })
  const joined = sent.map((segment) => segment.map((t) => t.text).join(' '))
  if (DESTRUCTIVE_SQL.test(joined.join('\n'))) return true
  // An unbounded DELETE is judged per quoted argument, and on the raw line
  // with its newlines flattened so a heredoc's `WHERE` on the next line still
  // bounds it. The raw line is used only when nothing on it merely searches.
  return [
    ...sent.flatMap((segment) =>
      segment.filter((t) => t.quoted).map((t) => t.text),
    ),
    ...(sent.length === segments.length ? [command.replace(/\s+/g, ' ')] : []),
  ].some((text) => UNBOUNDED_DELETE.test(text))
}

function analyzeCommandLine(
  command: string,
  platform: string,
  depth: number,
): SponsoredRefusedCommand | null {
  if (depth > MAX_DEPTH) return null
  if (WSL_SHARE.test(command)) {
    return { kind: 'wsl', invocation: '\\\\wsl$' }
  }
  const segments = lexCommandLine(command)
  for (const segment of segments) {
    const found = analyzeSegment(segment, platform, depth)
    if (found) return found
  }
  // `echo "docker compose up" | bash`, `bash <<< "…"`, `"wsl ls" | iex`: the
  // text piped into an interpreter is a command line too.
  if (segments.some(readsCommandsFromStdin)) {
    for (const segment of segments) {
      const start = commandStart(segment)
      const texts = [
        segment
          .slice(start + 1)
          .map((t) => t.text)
          .join(' '),
        ...segment
          .filter((t) => t.quoted)
          .map((t) => t.text.replace(/^<<</, '')),
      ]
      for (const text of texts) {
        const found = analyzeCommandLine(text, platform, depth + 1)
        if (found) return found
      }
    }
  }
  // SQL can reach a client as an argument, on stdin through a pipe or from a
  // heredoc, so a line that runs a SQL client is judged on the text around it.
  if (linePassesDestructiveSql(command, segments)) {
    for (const segment of segments) {
      const client = segmentRunsSqlClient(segment)
      if (client) return { kind: 'database', invocation: client }
    }
  }
  return null
}

/**
 * The refused command this command line runs, or null.
 *
 * `platform` is `process.platform` of the machine the command will run on;
 * only the `bash` spelling of WSL depends on it.
 */
export function sponsoredRefusedCommand(
  command: string,
  platform: string,
): SponsoredRefusedCommand | null {
  return analyzeCommandLine(command, platform, 0)
}

const STOP_AND_REPORT =
  'Do not try to reach the same result another way — not with a different command, script, shell, wrapper or path. Stop here and tell the user what the procedure needed this for, so they can decide whether to run it themselves.'

export function sponsoredCommandRefusal(
  refused: SponsoredRefusedCommand,
): string {
  switch (refused.kind) {
    case 'wsl':
      return `Refusing \`${refused.invocation}\`: a sponsored task may not enter the Windows Subsystem for Linux. WSL is the user's own Linux environment, with its own home directory and credentials, outside this project. ${STOP_AND_REPORT}`
    case 'database':
      return `Refusing \`${refused.invocation}\`: a sponsored task may not drop, reset, wipe, roll back or force-seed a database. The database this project points at may be one the user's other checkouts, or production, rely on. ${STOP_AND_REPORT}`
    case 'container':
      return `Refusing \`${refused.invocation}\`: a sponsored task may not build, start, stop, restart, remove or push containers or images; they may be the user's running services, including production. Read-only commands such as \`docker ps\`, \`docker logs\` and \`docker compose config\` are allowed. ${STOP_AND_REPORT}`
  }
}
