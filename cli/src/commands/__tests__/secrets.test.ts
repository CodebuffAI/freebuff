import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { SECRETS_USAGE, handleSecretsCommand } from '../secrets'

import type { RouterParams } from '../command-registry'

const originalConfigDir = process.env.FREEBUFF_CONFIG_DIR
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuff-secrets-cli-'))

beforeAll(() => {
  process.env.FREEBUFF_CONFIG_DIR = configDir
})

afterAll(() => {
  if (originalConfigDir === undefined) {
    delete process.env.FREEBUFF_CONFIG_DIR
  } else {
    process.env.FREEBUFF_CONFIG_DIR = originalConfigDir
  }
  fs.rmSync(configDir, { recursive: true, force: true })
})

function makeParams(): { params: RouterParams; messages: unknown[] } {
  const messages: unknown[] = []
  const params = {
    inputValue: '/secrets',
    setMessages: (
      value: unknown[] | ((prev: unknown[]) => unknown[]),
    ): void => {
      const next = typeof value === 'function' ? value(messages) : value
      messages.splice(0, messages.length, ...next)
    },
    clearMessages: (): void => {
      messages.length = 0
    },
    saveToHistory: (): void => {},
    setInputValue: (): void => {},
  } as unknown as RouterParams
  return { params, messages }
}

function transcript(messages: unknown[]): string {
  return JSON.stringify(messages)
}

describe('handleSecretsCommand', () => {
  test('shows usage with no arguments', async () => {
    const { params, messages } = makeParams()
    await handleSecretsCommand(params, '')
    expect(transcript(messages)).toContain(
      'Device-local secrets. The model sees the name, never the value.',
    )
    expect(transcript(messages)).toContain(SECRETS_USAGE.split('\n')[0]!)
  })

  test('rejects unknown options', async () => {
    const { params, messages } = makeParams()
    await handleSecretsCommand(params, 'list --verbose')
    expect(transcript(messages)).toContain('Unknown option: --verbose')
  })

  test('rejects --from-env without a value', async () => {
    const { params, messages } = makeParams()
    await handleSecretsCommand(params, 'add ACME_API_KEY --from-env')
    expect(transcript(messages)).toContain('Use --from-env=VARIABLE (one token).')
  })

  test('rejects an invalid environment-variable name', async () => {
    const { params, messages } = makeParams()
    await handleSecretsCommand(params, 'add ACME_API_KEY --from-env=lower-case')
    expect(transcript(messages)).toContain(
      'Invalid environment variable name: lower-case',
    )
  })

  test('refuses a secret whose name is missing or invalid', async () => {
    const missing = makeParams()
    await handleSecretsCommand(missing.params, 'add')
    expect(transcript(missing.messages)).toContain(
      'Name the secret with an environment-variable name',
    )

    const invalid = makeParams()
    await handleSecretsCommand(invalid.params, 'add lower-case-name')
    expect(transcript(invalid.messages)).toContain(
      'Name the secret with an environment-variable name',
    )
  })

  test('refuses to accept a value typed into the chat', async () => {
    const { params, messages } = makeParams()
    await handleSecretsCommand(params, 'add ACME_API_KEY')
    expect(transcript(messages)).toContain(
      'A value cannot be typed here: it would enter the chat transcript.',
    )
  })

  test('reports an environment variable that is not set', async () => {
    const { params, messages } = makeParams()
    await handleSecretsCommand(
      params,
      'add ACME_API_KEY --from-env=FREEBUFF_TEST_MISSING_VALUE',
    )
    expect(transcript(messages)).toContain(
      'FREEBUFF_TEST_MISSING_VALUE is not set in this process.',
    )
  })

  test('rejects a value too short to redact safely', async () => {
    process.env.FREEBUFF_TEST_SHORT_VALUE = 'short'
    const { params, messages } = makeParams()
    await handleSecretsCommand(
      params,
      'add ACME_API_KEY --from-env=FREEBUFF_TEST_SHORT_VALUE',
    )
    expect(transcript(messages)).toContain(
      'The value in FREEBUFF_TEST_SHORT_VALUE is too short to redact safely.',
    )
    delete process.env.FREEBUFF_TEST_SHORT_VALUE
  })

  test('adds, lists, rotates and removes without ever showing the value', async () => {
    const value = 'correct-horse-battery-staple'
    process.env.FREEBUFF_TEST_REAL_VALUE = value

    const added = makeParams()
    await handleSecretsCommand(
      added.params,
      'add ACME_API_KEY --from-env=FREEBUFF_TEST_REAL_VALUE',
    )
    expect(transcript(added.messages)).toContain(
      'Saved ACME_API_KEY (revision 1).',
    )
    expect(transcript(added.messages)).not.toContain(value)

    const listed = makeParams()
    await handleSecretsCommand(listed.params, 'list')
    expect(transcript(listed.messages)).toContain('ACME_API_KEY')
    expect(transcript(listed.messages)).toContain('revision 1')
    expect(transcript(listed.messages)).not.toContain(value)

    const rotated = makeParams()
    await handleSecretsCommand(
      rotated.params,
      'rotate ACME_API_KEY --from-env=FREEBUFF_TEST_REAL_VALUE',
    )
    expect(transcript(rotated.messages)).toContain(
      'Rotated ACME_API_KEY (revision 2).',
    )

    const removed = makeParams()
    await handleSecretsCommand(removed.params, 'remove ACME_API_KEY')
    expect(transcript(removed.messages)).toContain('Removed ACME_API_KEY.')

    const missing = makeParams()
    await handleSecretsCommand(missing.params, 'remove ACME_API_KEY')
    expect(transcript(missing.messages)).toContain(
      'No secret named ACME_API_KEY.',
    )

    delete process.env.FREEBUFF_TEST_REAL_VALUE
  })
})
