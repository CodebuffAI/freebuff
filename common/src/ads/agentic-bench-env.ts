import type { LabEnvironment } from './agentic-ad-lab-batch'

/**
 * The bench's environment axis (bench-v2, B3): what the machine around the
 * repository looks like. Sampled, never crossed with every repository: the
 * planner (`agentic-bench-plan.ts`) picks each case's live cells by
 * `hash(skill.id, env)`, so successive versions of a skill hit the same cells.
 *
 * - `lab`: a Cloud Lab VM (Linux), set up by the Lab batch's environment case
 *   (`LAB_ENVIRONMENTS`).
 * - `desktop`: headless Freebuff Desktop on a GitHub runner (the bench
 *   workflow that ran it was removed in COD-965), with real containment (bwrap and a private
 *   HOME on Linux), which the Lab cannot reproduce (the COD-825 shim failures).
 *   `setup` runs on the runner before the leg. It may append `KEY=VALUE` lines
 *   to `$BENCH_ENV_FILE` (the Desktop process's environment overrides; `PATH`
 *   replaces it) and set `BENCH_PROJECT_PARENT=<dir>` there, the folder the
 *   project is cloned under (paths with spaces, OneDrive, >260 characters).
 *
 * `hides` names the toolchains the case takes away. A cell whose run needs one
 * is labelled `should_fail_gracefully` by the oracle until managed toolchains
 * (spec E1) ship and `BENCH_HEALED_TOOLCHAINS` lists it.
 */
export type BenchSurface = 'lab' | 'desktop'
export type BenchOs = 'linux' | 'win32' | 'darwin'
export type BenchToolchain = 'node' | 'python' | 'pip'

export type BenchEnvironment = {
  key: string
  surface: BenchSurface
  os: BenchOs
  /** smoke: in every smoke run; full: only in full runs and sweeps. */
  tier: 'smoke' | 'full'
  label: string
  /** The Lab batch's environment case (surface `lab`). */
  lab?: LabEnvironment
  /** Runs on the GitHub runner before a Desktop leg (surface `desktop`). */
  setup?: { shell: 'bash' | 'pwsh'; script: string }
  hides: BenchToolchain[]
  /** The case needs a root package.json (the collision writer edits it). */
  needsRootPackageJson?: boolean
}

/** Toolchains a run installs for itself once spec E1 ships; empty until then. */
export const BENCH_HEALED_TOOLCHAINS: readonly BenchToolchain[] = []

const lab = (
  key: LabEnvironment,
  tier: BenchEnvironment['tier'],
  label: string,
  hides: BenchToolchain[] = [],
  extra: Partial<BenchEnvironment> = {},
): BenchEnvironment => ({
  key: `lab:${key}`,
  surface: 'lab',
  os: 'linux',
  tier,
  label,
  lab: key,
  hides,
  ...extra,
})

const desktop = (
  os: BenchOs,
  key: string,
  label: string,
  setup: BenchEnvironment['setup'] | undefined,
  hides: BenchToolchain[] = [],
): BenchEnvironment => ({
  key: `desktop:${key}`,
  surface: 'desktop',
  os,
  tier: 'full',
  label,
  ...(setup ? { setup } : {}),
  hides,
})

/** PATH without any directory a Node install lives in (Linux and macOS runners). */
const POSIX_PATH_WITHOUT_NODE = `p=$(printf %s "$PATH" | tr ':' '\\n' | grep -v -e hostedtoolcache -e '/usr/local/bin' -e nvm -e volta -e '/opt/homebrew' -e fnm -e asdf -e mise | paste -sd: -)
echo "PATH=$p:/usr/bin:/bin" >> "$BENCH_ENV_FILE"`

/** A manager activated only from the profile, the way a developer's shell does it. */
const POSIX_MANAGER = (install: string, profile: string) => `set -eu
${install}
printf '%s\\n' ${profile
  .split('\n')
  .map((line) => `'${line}'`)
  .join(' ')} >> "$HOME/.bashrc"
printf '%s\\n' ${profile
  .split('\n')
  .map((line) => `'${line}'`)
  .join(' ')} >> "$HOME/.zprofile"
${POSIX_PATH_WITHOUT_NODE}`

const WIN_PATH_WITHOUT = (pattern: string) =>
  `$p = ($env:PATH -split ';' | Where-Object { $_ -and $_ -notmatch '${pattern}' }) -join ';'`

export const BENCH_ENVIRONMENTS: readonly BenchEnvironment[] = [
  // Lab Linux: smoke.
  lab('default', 'smoke', 'Lab VM as is'),
  lab('no-node', 'smoke', 'No Node at all', ['node']),
  lab('python-pep668', 'smoke', 'System pip refuses (PEP 668)', ['pip']),
  // Lab Linux: full adds.
  lab('node-nvm', 'full', 'Node through nvm only'),
  lab('node-mise', 'full', 'Node through mise only'),
  lab('node-volta', 'full', 'Node through Volta only'),
  lab('node-fnm', 'full', 'Node through fnm only'),
  lab('node-asdf', 'full', 'Node through asdf shims only'),
  lab('uv-only', 'full', 'Python through uv only', ['pip']),
  lab(
    'concurrent-package-json',
    'full',
    'Second thread edits package.json',
    [],
    {
      needsRootPackageJson: true,
    },
  ),

  // Linux Desktop on ubuntu-latest: real bwrap and a private HOME.
  desktop(
    'linux',
    'linux-default',
    'Linux Desktop as the runner is',
    undefined,
  ),
  desktop('linux', 'linux-volta', 'Linux Desktop, Node through Volta shims', {
    shell: 'bash',
    script: POSIX_MANAGER(
      'curl -fsSL https://get.volta.sh | bash -s -- --skip-setup >/dev/null 2>&1\n"$HOME/.volta/bin/volta" install node@22 >/dev/null 2>&1',
      'export VOLTA_HOME="$HOME/.volta"\nexport PATH="$VOLTA_HOME/bin:$PATH"',
    ),
  }),
  desktop('linux', 'linux-asdf', 'Linux Desktop, Node through asdf shims', {
    shell: 'bash',
    script: POSIX_MANAGER(
      'mkdir -p "$HOME/.asdf/bin"\ncurl -fsSL https://github.com/asdf-vm/asdf/releases/download/v0.18.0/asdf-v0.18.0-linux-amd64.tar.gz | tar -xz -C "$HOME/.asdf/bin"\nexport PATH="$HOME/.asdf/bin:$HOME/.asdf/shims:$PATH"\nasdf plugin add nodejs >/dev/null 2>&1 || true\nasdf install nodejs 22.12.0 >/dev/null 2>&1\n(cd "$HOME" && asdf set --home nodejs 22.12.0)',
      'export PATH="$HOME/.asdf/bin:$HOME/.asdf/shims:$PATH"',
    ),
  }),
  desktop('linux', 'linux-mise', 'Linux Desktop, Node through mise', {
    shell: 'bash',
    script: POSIX_MANAGER(
      'curl -fsSL https://mise.run | sh >/dev/null 2>&1\n"$HOME/.local/bin/mise" use --global node@22 >/dev/null 2>&1',
      'eval "$("$HOME/.local/bin/mise" activate bash)"',
    ),
  }),
  desktop(
    'linux',
    'linux-no-node',
    'Linux Desktop with no Node',
    { shell: 'bash', script: POSIX_PATH_WITHOUT_NODE },
    ['node'],
  ),

  // Windows on windows-latest: PowerShell 5.1 floor, core.autocrlf=true.
  desktop('win32', 'win-default', 'Windows, Node from the MSI', undefined),
  desktop(
    'win32',
    'win-no-node',
    'Windows with Node stripped from PATH',
    {
      shell: 'pwsh',
      script: `${WIN_PATH_WITHOUT('nodejs|npm|nvm|volta|fnm')}\n"PATH=$p" | Out-File -Append -Encoding utf8 $env:BENCH_ENV_FILE`,
    },
    ['node'],
  ),
  desktop('win32', 'win-nvm', 'Windows, Node through nvm-windows', {
    shell: 'pwsh',
    script: `$ErrorActionPreference = 'Stop'
$nvm = "$env:LOCALAPPDATA\\nvm"; $link = "$env:LOCALAPPDATA\\nodejs-nvm"
New-Item -ItemType Directory -Force $nvm | Out-Null
Invoke-WebRequest https://github.com/coreybutler/nvm-windows/releases/download/1.2.2/nvm-noinstall.zip -OutFile "$env:RUNNER_TEMP\\nvm.zip"
Expand-Archive "$env:RUNNER_TEMP\\nvm.zip" -DestinationPath $nvm -Force
"root: $nvm\`r\`npath: $link" | Set-Content "$nvm\\settings.txt"
$env:NVM_HOME = $nvm; $env:NVM_SYMLINK = $link
& "$nvm\\nvm.exe" install 22.12.0 | Out-Null
& "$nvm\\nvm.exe" use 22.12.0 | Out-Null
${WIN_PATH_WITHOUT('nodejs|npm|volta|fnm')}
"NVM_HOME=$nvm", "NVM_SYMLINK=$link", "PATH=$nvm;$link;$p" | Out-File -Append -Encoding utf8 $env:BENCH_ENV_FILE`,
  }),
  desktop(
    'win32',
    'win-python-alias',
    'Windows, only the Store python.exe alias and py',
    {
      shell: 'pwsh',
      script: `$stub = "$env:RUNNER_TEMP\\store-alias"
New-Item -ItemType Directory -Force $stub | Out-Null
foreach ($name in 'python', 'python3') {
  "@echo off\`r\`necho Python was not found; run without arguments to install from the Microsoft Store, or disable this shortcut from Settings ^> Apps ^> Advanced app settings ^> App execution aliases.\`r\`nexit /b 9009" | Set-Content -Encoding ascii "$stub\\$name.cmd"
}
${WIN_PATH_WITHOUT('Python|hostedtoolcache\\\\windows\\\\Python')}
"PATH=$stub;$p;C:\\Windows" | Out-File -Append -Encoding utf8 $env:BENCH_ENV_FILE`,
    },
    ['pip'],
  ),
  desktop(
    'win32',
    'win-unicode-path',
    'Windows, project under a path with spaces and non-ASCII',
    {
      shell: 'pwsh',
      script: `$dir = Join-Path $env:USERPROFILE 'Projets Élève\\mes apps'
New-Item -ItemType Directory -Force $dir | Out-Null
"BENCH_PROJECT_PARENT=$dir" | Out-File -Append -Encoding utf8 $env:BENCH_ENV_FILE`,
    },
  ),
  desktop(
    'win32',
    'win-onedrive-path',
    'Windows, project in OneDrive Documents',
    {
      shell: 'pwsh',
      script: `$od = Join-Path $env:USERPROFILE 'OneDrive'
$dir = Join-Path $od 'Documents\\Projects'
New-Item -ItemType Directory -Force $dir | Out-Null
"OneDrive=$od", "OneDriveConsumer=$od", "BENCH_PROJECT_PARENT=$dir" | Out-File -Append -Encoding utf8 $env:BENCH_ENV_FILE`,
    },
  ),
  desktop(
    'win32',
    'win-long-path',
    'Windows, a >260-character project path with LongPaths off',
    {
      shell: 'pwsh',
      script: `Set-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\FileSystem' -Name LongPathsEnabled -Value 0
git config --global core.longpaths false
$dir = Join-Path $env:USERPROFILE ((1..12 | ForEach-Object { 'a-rather-long-folder-name' }) -join '\\')
New-Item -ItemType Directory -Force "\\\\?\\$dir" | Out-Null
"BENCH_PROJECT_PARENT=$dir" | Out-File -Append -Encoding utf8 $env:BENCH_ENV_FILE`,
    },
  ),

  // macOS on macos-15.
  desktop('darwin', 'mac-homebrew', 'macOS, Node from /opt/homebrew', {
    shell: 'bash',
    script: `set -eu
brew install node@22 >/dev/null
p=$(printf %s "$PATH" | tr ':' '\\n' | grep -v -e hostedtoolcache -e '/usr/local/bin' | paste -sd: -)
echo "PATH=/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:$p" >> "$BENCH_ENV_FILE"`,
  }),
  desktop(
    'darwin',
    'mac-gui-path',
    'macOS GUI launch: launchd PATH, Node only in the login shell',
    {
      shell: 'bash',
      script: `set -eu
brew install node@22 >/dev/null
echo 'eval "$(/opt/homebrew/bin/brew shellenv)"; export PATH="/opt/homebrew/opt/node@22/bin:$PATH"' >> "$HOME/.zprofile"
echo "PATH=/usr/bin:/bin:/usr/sbin:/sbin" >> "$BENCH_ENV_FILE"`,
    },
  ),
  desktop('darwin', 'mac-pkg-node', 'macOS, Node from the official .pkg', {
    shell: 'bash',
    script: `set -eu
curl -fsSLo "$RUNNER_TEMP/node.pkg" https://nodejs.org/dist/v22.12.0/node-v22.12.0.pkg
sudo installer -pkg "$RUNNER_TEMP/node.pkg" -target / >/dev/null
echo "PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" >> "$BENCH_ENV_FILE"`,
  }),
  desktop('darwin', 'mac-volta', 'macOS, Node through Volta', {
    shell: 'bash',
    script: POSIX_MANAGER(
      'curl -fsSL https://get.volta.sh | bash -s -- --skip-setup >/dev/null 2>&1\n"$HOME/.volta/bin/volta" install node@22 >/dev/null 2>&1',
      'export VOLTA_HOME="$HOME/.volta"\nexport PATH="$VOLTA_HOME/bin:$PATH"',
    ),
  }),
  desktop(
    'darwin',
    'mac-no-node',
    'macOS with no Node',
    {
      shell: 'bash',
      script: `echo "PATH=/usr/bin:/bin:/usr/sbin:/sbin" >> "$BENCH_ENV_FILE"`,
    },
    ['node'],
  ),
]

export function benchEnvironment(key: string): BenchEnvironment {
  const env = BENCH_ENVIRONMENTS.find((e) => e.key === key)
  if (!env) throw new Error(`No bench environment ${key}.`)
  return env
}

/** The case a surface and OS run when nothing else is asked for. */
export function benchDefaultEnvironment(
  surface: BenchSurface,
  os: BenchOs,
): BenchEnvironment {
  const key =
    surface === 'lab'
      ? 'lab:default'
      : os === 'win32'
        ? 'desktop:win-default'
        : os === 'darwin'
          ? 'desktop:mac-homebrew'
          : 'desktop:linux-default'
  return benchEnvironment(key)
}
