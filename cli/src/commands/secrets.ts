import path from 'node:path'

import {
  SECRET_VALUE_MIN,
  SecretNameError,
  SecretsVault,
  isSecretName,
} from '@codebuff/common/secrets'

import { getConfigDir } from '../utils/auth'
import { getSystemMessage } from '../utils/message-history'

import type { RouterParams } from './command-registry'

export const SECRETS_USAGE = [
  'Device-local secrets. The model sees the name, never the value.',
  '',
  'Secrets are encrypted on this computer and substituted only at the tool boundary: into a command\'s environment, or into a request to a loopback endpoint. A reference is refused for a remote host.',
  '',
  '**Add a secret from an environment variable**',
  'Export it first (never paste it into the chat), then:',
  '`/secrets add ACME_API_KEY --from-env=ACME_API_KEY`',
  '',
  '**Use it in a task**',
  'Tell the agent to use `$ACME_API_KEY` in a command, or `${secret:ACME_API_KEY}` in a local endpoint\'s header. It never sees the value.',
  '',
  '**Commands**',
  '`/secrets list`',
  '`/secrets add <NAME> --from-env=<ENV_VAR>`',
  '`/secrets rotate <NAME> --from-env=<ENV_VAR>`',
  '`/secrets remove <NAME>`',
  '',
  'Nothing expires: a secret stays usable until you rotate or remove it. Values are never accepted as command arguments, so they cannot land in chat history.',
].join('\n')

function post(params: RouterParams, message: string): void {
  params.setMessages((messages) => [...messages, getSystemMessage(message)])
  params.saveToHistory(params.inputValue.trim())
  params.setInputValue({ text: '', cursorPosition: 0, lastEditDueToNav: false })
}

async function openVault(): Promise<SecretsVault> {
  return SecretsVault.open({ directory: path.join(getConfigDir(), 'secrets') })
}

type ParsedFlag = { positional: string[]; fromEnv?: string; error?: string }

function parseArguments(tokens: string[]): ParsedFlag {
  const positional: string[] = []
  let fromEnv: string | undefined
  for (const token of tokens) {
    const match = /^--from-env=(.+)$/.exec(token)
    if (match) {
      if (!isSecretName(match[1]!)) {
        return { positional, error: `Invalid environment variable name: ${match[1]}` }
      }
      fromEnv = match[1]!
      continue
    }
    if (token === '--from-env') {
      return { positional, error: 'Use --from-env=VARIABLE (one token).' }
    }
    if (token.startsWith('--')) {
      return { positional, error: `Unknown option: ${token}` }
    }
    positional.push(token)
  }
  return { positional, ...(fromEnv ? { fromEnv } : {}) }
}

function readEnvironment(name: string): string | undefined {
  return process.env[name]
}

export async function handleSecretsCommand(
  params: RouterParams,
  rawArgs: string,
): Promise<void> {
  const tokens = rawArgs.trim().split(/\s+/).filter(Boolean)
  const action = tokens.shift()
  if (!action || action === 'help') {
    post(params, SECRETS_USAGE)
    return
  }

  const parsed = parseArguments(tokens)
  if (parsed.error) {
    post(params, parsed.error)
    return
  }

  try {
    const vault = await openVault()

    if (action === 'list' || action === 'ls') {
      const records = await vault.list()
      post(
        params,
        records.length === 0
          ? 'No secrets stored on this device.\n\n' + SECRETS_USAGE
          : records
              .map(
                (record) =>
                  `${record.name}  ·  revision ${record.revision}  ·  updated ${record.updatedAt}${
                    record.lastUsedAt ? `  ·  last used ${record.lastUsedAt}` : ''
                  }`,
              )
              .join('\n') +
              '\n\nValues stay on this computer. Nothing expires; rotate or remove when you want to.',
      )
      return
    }

    if (action === 'add' || action === 'rotate') {
      const name = parsed.positional[0]
      if (!name || !isSecretName(name)) {
        post(params, `Name the secret with an environment-variable name, e.g. ACME_API_KEY.\n\n${SECRETS_USAGE}`)
        return
      }
      if (!parsed.fromEnv) {
        post(
          params,
          'A value cannot be typed here: it would enter the chat transcript. Export it in your shell, then use --from-env=VARIABLE.',
        )
        return
      }
      const value = readEnvironment(parsed.fromEnv)
      if (value === undefined) {
        post(
          params,
          `${parsed.fromEnv} is not set in this process. Export it in the terminal that launched Freebuff, then retry.`,
        )
        return
      }
      if (value.length < SECRET_VALUE_MIN) {
        post(params, `The value in ${parsed.fromEnv} is too short to redact safely.`)
        return
      }
      const record =
        action === 'add'
          ? await vault.add({ name, value })
          : await vault.rotate({ name, value })
      post(
        params,
        `${action === 'add' ? 'Saved' : 'Rotated'} ${record.name} (revision ${record.revision}). The model can reference it as \`${
          record.name
        }\` or \`\${secret:${record.name}}\`, and never sees the value.`,
      )
      return
    }

    if (action === 'remove' || action === 'rm' || action === 'delete') {
      const name = parsed.positional[0]
      if (!name || !isSecretName(name)) {
        post(params, `Name the secret to remove, e.g. /secrets remove ACME_API_KEY.`)
        return
      }
      const removed = await vault.remove(name)
      post(params, removed ? `Removed ${name}.` : `No secret named ${name}.`)
      return
    }

    post(params, SECRETS_USAGE)
  } catch (error) {
    post(
      params,
      error instanceof SecretNameError || error instanceof Error
        ? `Secrets error: ${error.message}`
        : 'Secrets error.',
    )
  }
}
