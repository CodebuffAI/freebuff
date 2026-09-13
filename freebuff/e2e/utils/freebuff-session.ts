import fs from 'fs'
import os from 'os'
import path from 'path'

import { tmuxCapture, tmuxSend, tmuxSendKey, tmuxStart, tmuxStop } from './tmux-helpers'

/** Static strings that prove the CLI reached a post-init boot screen. */
export const FREEBUFF_BOOT_SIGNALS = [
  '█████╗  ██████╔╝', // ASCII logo (full or small variant)
  'Start coding for free',
  'Enter a coding task',
  'Pick a model to start',
  "Free mode isn't available",
  'Press ENTER to login',
  'Open this URL',
  'will run commands on your behalf',
] as const

export class FreebuffSession {
  public readonly name: string
  public readonly workDir: string

  private readonly envDir: string | null

  private constructor(sessionName: string, workDir: string, envDir: string | null) {
    this.name = sessionName
    this.workDir = workDir
    this.envDir = envDir
  }

  /**
   * Start a freebuff binary in a tmux session.
   * Creates a temporary working directory to simulate a real user project.
   */
  static async start(
    binaryPath: string,
    options?: {
      waitSeconds?: number
      width?: number
      height?: number
      initialFiles?: Record<string, string>
      /** Extra environment for the binary (a credential, a config dir). Written
       *  to a 0600 file OUTSIDE the project directory and sourced by the tmux
       *  shell, so a secret never lands in the project the CLI indexes, nor in
       *  the session's recorded command line. */
      env?: Record<string, string>
    },
  ): Promise<FreebuffSession> {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuff-e2e-'))

    // Create a minimal project so freebuff has something to work with
    fs.writeFileSync(
      path.join(tmpDir, 'README.md'),
      '# E2E Test Project\n',
      'utf-8',
    )

    // Write any initial files before starting the binary
    if (options?.initialFiles) {
      for (const [relativePath, content] of Object.entries(options.initialFiles)) {
        const filePath = path.join(tmpDir, relativePath)
        const dir = path.dirname(filePath)
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true })
        }
        fs.writeFileSync(filePath, content, 'utf-8')
      }
    }

    const envDir = writeEnvFile(options?.env)
    const prelude = envDir ? `. '${path.join(envDir, 'env.sh')}' && ` : ''
    const command = `${prelude}cd '${tmpDir}' && '${binaryPath}'`
    const sessionName = tmuxStart({
      command,
      waitSeconds: options?.waitSeconds ?? 4,
      width: options?.width ?? 120,
      height: options?.height ?? 30,
    })

    return new FreebuffSession(sessionName, tmpDir, envDir)
  }

  /** Write a file into the session's working directory. */
  writeFile(relativePath: string, content: string): void {
    const filePath = path.join(this.workDir, relativePath)
    const dir = path.dirname(filePath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    fs.writeFileSync(filePath, content, 'utf-8')
  }

  /** Read a file from the session's working directory. */
  readFile(relativePath: string): string {
    return fs.readFileSync(path.join(this.workDir, relativePath), 'utf-8')
  }

  /** Check if a file exists in the session's working directory. */
  fileExists(relativePath: string): boolean {
    return fs.existsSync(path.join(this.workDir, relativePath))
  }

  /**
   * Poll until a file in the working directory contains the given text.
   * Throws if the timeout is exceeded.
   */
  async waitForFileContent(
    relativePath: string,
    pattern: string,
    timeoutMs = 60_000,
  ): Promise<string> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      try {
        const content = this.readFile(relativePath)
        if (content.includes(pattern)) return content
      } catch {
        // File may not exist yet
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000))
    }
    let finalContent = '(file does not exist)'
    try {
      finalContent = this.readFile(relativePath)
    } catch {
      // ignore
    }
    const terminalOutput = await this.capture()
    throw new Error(
      `Timed out after ${timeoutMs}ms waiting for "${pattern}" in ${relativePath}.\n` +
        `Last content:\n${finalContent}\n` +
        `Terminal output:\n${terminalOutput}`,
    )
  }

  /**
   * Wait for the CLI to be fully initialized and ready for input.
   * Polls terminal output until enough non-empty lines are visible,
   * indicating the TUI has rendered its initial layout.
   */
  async waitForReady(timeoutMs = 30_000, minLines = 5): Promise<void> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const output = await this.capture()
      const nonEmptyLines = output
        .split('\n')
        .filter((line) => line.trim().length > 0)
      if (nonEmptyLines.length >= minLines) return
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    const finalOutput = await this.capture()
    throw new Error(
      `Timed out after ${timeoutMs}ms waiting for CLI to be ready.\n` +
        `Last output:\n${finalOutput}`,
    )
  }

  /** Send text input to the freebuff CLI (presses Enter by default). */
  async send(
    text: string,
    options?: { noEnter?: boolean; waitIdle?: number },
  ): Promise<void> {
    tmuxSend(this.name, text, { ...options, force: true })
  }

  /** Send a special key (e.g. Escape, C-c, Enter). */
  async sendKey(key: string): Promise<void> {
    tmuxSendKey(this.name, key)
  }

  /** Capture current terminal output, optionally waiting first. */
  async capture(waitSeconds?: number): Promise<string> {
    return tmuxCapture(this.name, { waitSeconds, noSave: true })
  }

  /** Capture and auto-save to the session logs directory with a label. */
  async captureLabeled(label: string, waitSeconds?: number): Promise<string> {
    return tmuxCapture(this.name, { waitSeconds, label })
  }

  /**
   * Poll until the terminal shows any known boot-screen marker.
   * More reliable than waiting for a single ASCII logo line — CI runners
   * often land on the model picker wordmark ("Start coding for free") instead
   * of the full ASCII art.
   */
  async waitForBootSignal(timeoutMs = 30_000): Promise<string> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const output = await this.capture()
      if (FREEBUFF_BOOT_SIGNALS.some((signal) => output.includes(signal))) {
        return output
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    const finalOutput = await this.capture()
    throw new Error(
      `Timed out after ${timeoutMs}ms waiting for a boot signal ` +
        `(checked ${FREEBUFF_BOOT_SIGNALS.length} patterns).\n` +
        `Last output:\n${finalOutput}`,
    )
  }

  /**
   * Poll until the terminal output contains the given text.
   * Throws if the timeout is exceeded.
   */
  async waitForText(pattern: string, timeoutMs = 30_000): Promise<string> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const output = await this.capture()
      if (output.includes(pattern)) return output
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    const finalOutput = await this.capture()
    throw new Error(
      `Timed out after ${timeoutMs}ms waiting for "${pattern}".\n` +
        `Last output:\n${finalOutput}`,
    )
  }

  /** Stop the tmux session and clean up the temp directory. */
  async stop(): Promise<void> {
    tmuxStop(this.name)
    for (const dir of [this.workDir, this.envDir]) {
      if (!dir) continue
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {
        // Ignore cleanup errors
      }
    }
  }
}

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`

/** Materialize `env` as a sourceable file in its own temp dir; null when there is nothing to set. */
function writeEnvFile(env: Record<string, string> | undefined): string | null {
  const entries = Object.entries(env ?? {})
  if (entries.length === 0) return null
  const envDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuff-e2e-env-'))
  fs.writeFileSync(
    path.join(envDir, 'env.sh'),
    entries.map(([name, value]) => `export ${name}=${shellQuote(value)}`).join('\n') + '\n',
    { encoding: 'utf-8', mode: 0o600 },
  )
  return envDir
}
