import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Command } from 'commander'

import { parseArgs } from '../cli-args'

describe('CLI Argument Parsing', () => {
  let originalArgv: string[]

  beforeEach(() => {
    originalArgv = process.argv
  })

  afterEach(() => {
    process.argv = originalArgv
  })

  function parseTestArgs(args: string[]) {
    process.argv = ['node', 'codecane', ...args]

    const program = new Command()
    program
      .name('codecane')
      .version('1.0.0', '-v, --version', 'Print the CLI version')
      .option('--agent <agent-id>', 'Specify which agent to use')
      .option('--clear-logs', 'Remove any existing CLI log files')
      .argument('[prompt...]', 'Initial prompt to send')
      .allowExcessArguments(true)
      .exitOverride() // Prevent process.exit in tests

    try {
      program.parse(process.argv)
    } catch (error) {
      // Commander throws on --help, --version in exitOverride mode
      if (error instanceof Error && error.message.includes('(outputHelp)')) {
        return { help: true }
      }
      if (
        error instanceof Error &&
        (error.message.includes('(version)') || error.message.includes('1.0.0'))
      ) {
        return { version: true }
      }
      throw error
    }

    const options = program.opts()
    const promptArgs = program.args

    return {
      agent: options.agent,
      clearLogs: options.clearLogs || false,
      initialPrompt: promptArgs.length > 0 ? promptArgs.join(' ') : null,
    }
  }

  test('parses --agent flag correctly', () => {
    const result = parseTestArgs([
      '--agent',
      'file-picker',
      'find all TypeScript files',
    ])
    expect(result.agent).toBe('file-picker')
    expect(result.initialPrompt).toBe('find all TypeScript files')
  })

  test('parses --agent with full agent ID', () => {
    const result = parseTestArgs([
      '--agent',
      'codebuff/base-lite@1.0.0',
      'hello',
    ])
    expect(result.agent).toBe('codebuff/base-lite@1.0.0')
    expect(result.initialPrompt).toBe('hello')
  })

  test('works without --agent flag (defaults to base)', () => {
    const result = parseTestArgs(['create a new component'])
    expect(result.agent).toBeUndefined()
    expect(result.initialPrompt).toBe('create a new component')
  })

  test('parses --clear-logs flag', () => {
    const result = parseTestArgs(['--clear-logs', 'hello'])
    expect(result.clearLogs).toBe(true)
    expect(result.initialPrompt).toBe('hello')
  })

  test('handles multiple flags together', () => {
    const result = parseTestArgs([
      '--agent',
      'reviewer',
      '--clear-logs',
      'review my code',
    ])
    expect(result.agent).toBe('reviewer')
    expect(result.clearLogs).toBe(true)
    expect(result.initialPrompt).toBe('review my code')
  })

  test('handles prompt with no flags', () => {
    const result = parseTestArgs(['this is a test prompt'])
    expect(result.agent).toBeUndefined()
    expect(result.clearLogs).toBe(false)
    expect(result.initialPrompt).toBe('this is a test prompt')
  })

  test('handles empty arguments', () => {
    const result = parseTestArgs([])
    expect(result.agent).toBeUndefined()
    expect(result.clearLogs).toBe(false)
    expect(result.initialPrompt).toBeNull()
  })

  test('handles multi-word prompt', () => {
    const result = parseTestArgs([
      '--agent',
      'base',
      'fix the bug in auth.ts file',
    ])
    expect(result.agent).toBe('base')
    expect(result.initialPrompt).toBe('fix the bug in auth.ts file')
  })

  test('handles --help flag', () => {
    const result = parseTestArgs(['--help'])
    expect(result.help).toBe(true)
  })

  test('handles -h flag', () => {
    const result = parseTestArgs(['-h'])
    expect(result.help).toBe(true)
  })

  test('handles --version flag', () => {
    const result = parseTestArgs(['--version'])
    expect(result.version).toBe(true)
  })

  test('handles -v flag', () => {
    const result = parseTestArgs(['-v'])
    expect(result.version).toBe(true)
  })
})

describe('Freebuff CLI Argument Parsing', () => {
  test('accepts login as a command, not an unexpected argument', () => {
    const result = parseArgs({
      argv: ['node', 'freebuff', 'login'],
      isFreebuff: true,
      version: '1.0.0',
    })

    expect(result.initialPrompt).toBeNull()
    expect(result.command).toBe('login')
    expect(result.initialMode).toBe('LITE')
  })

  test('allows cwd before the login command', () => {
    const result = parseArgs({
      argv: ['node', 'freebuff', '--cwd', '/tmp', 'login'],
      isFreebuff: true,
      version: '1.0.0',
    })

    expect(result.cwd).toBe('/tmp')
    expect(result.command).toBe('login')
    expect(result.initialPrompt).toBeNull()
  })

  test('allows cwd after the login command', () => {
    const result = parseArgs({
      argv: ['node', 'freebuff', 'login', '--cwd', '/tmp'],
      isFreebuff: true,
      version: '1.0.0',
    })

    expect(result.cwd).toBe('/tmp')
    expect(result.command).toBe('login')
    expect(result.initialPrompt).toBeNull()
  })

  test('accepts -c as continue without a conversation id', () => {
    const result = parseArgs({
      argv: ['node', 'freebuff', '-c'],
      isFreebuff: true,
      version: '1.0.0',
    })

    expect(result.continue).toBe(true)
    expect(result.continueId).toBeNull()
  })

  test('accepts --continue as continue without a conversation id', () => {
    const result = parseArgs({
      argv: ['node', 'freebuff', '--continue'],
      isFreebuff: true,
      version: '1.0.0',
    })

    expect(result.continue).toBe(true)
    expect(result.continueId).toBeNull()
  })

  test('accepts -c with an explicit conversation id', () => {
    const result = parseArgs({
      argv: ['node', 'freebuff', '-c', 'abc-123'],
      isFreebuff: true,
      version: '1.0.0',
    })

    expect(result.continue).toBe(true)
    expect(result.continueId).toBe('abc-123')
  })
})
