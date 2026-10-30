import { describe, test, expect, mock } from 'bun:test'

import { createStreamController } from '../../hooks/stream-state'
import { createMessageUpdater } from '../../utils/message-updater'
import { createRunConfig, isSensitiveFile } from '../../utils/create-run-config'

import type { CreateRunConfigParams } from '../../utils/create-run-config'

describe('createRunConfig', () => {
  const config = (agent: CreateRunConfigParams['agent']) =>
    createRunConfig({
      agent,
      prompt: 'hi',
      content: undefined,
      previousRunState: null,
      agentDefinitions: [],
      signal: new AbortController().signal,
    } as unknown as CreateRunConfigParams)

  test('analytics observers cannot break SDK callbacks and ignore lost chat ownership', () => {
    let active = true
    const observeEvent = mock(() => {
      throw new Error('capture unavailable')
    })
    const observeChunk = mock(() => {
      throw new Error('capture unavailable')
    })
    const run = createRunConfig({
      agent: 'custom',
      prompt: 'hi',
      content: undefined,
      previousRunState: null,
      agentDefinitions: [],
      signal: new AbortController().signal,
      logger: {
        info: () => {},
        debug: () => {},
        warn: () => {},
        error: () => {},
      },
      eventHandlerState: {
        isActive: () => active,
        streaming: {
          streamRefs: createStreamController(),
          setStreamingAgents: () => {},
          setStreamStatus: () => {},
        },
        message: {
          aiMessageId: 'ai-1',
          updater: createMessageUpdater('ai-1', () => {}),
          hasReceivedContentRef: { current: false },
        },
        subagents: {
          addActiveSubagent: () => {},
          removeActiveSubagent: () => {},
        },
        mode: { agentMode: 'DEFAULT', setHasReceivedPlanResponse: () => {} },
        logger: {
          info: () => {},
          debug: () => {},
          warn: () => {},
          error: () => {},
        },
        setIsRetrying: () => {},
      },
      observeEvent,
      observeChunk,
    })
    expect(() =>
      run.handleEvent({ type: 'start', messageHistoryLength: 0 }),
    ).not.toThrow()
    expect(() => run.handleStreamChunk('root text')).not.toThrow()
    expect(observeEvent).toHaveBeenCalledTimes(1)
    expect(observeChunk).toHaveBeenCalledTimes(1)
    active = false
    run.handleEvent({ type: 'start', messageHistoryLength: 0 })
    run.handleStreamChunk('late text')
    expect(observeEvent).toHaveBeenCalledTimes(1)
    expect(observeChunk).toHaveBeenCalledTimes(1)
  })

  test('skips the symbol index only for a base3 root', () => {
    expect(config('base3-free-deepseek-flash').skipSymbolIndex).toBe(true)
    expect(config('base3-fast-free-deepseek-flash').skipSymbolIndex).toBe(true)
    expect(
      config({ id: 'base3-free-catalog' } as CreateRunConfigParams['agent'])
        .skipSymbolIndex,
    ).toBe(true)
    // base2 roots (the kill switch) and custom agents spawn the file-picker.
    expect(config('base2-free-deepseek-flash').skipSymbolIndex).toBe(false)
    expect(config('my-custom-agent').skipSymbolIndex).toBe(false)
  })
})

describe('isSensitiveFile', () => {
  test.each([
    // Env files (blocked)
    ['.env', true],
    ['.ENV', true],
    ['.env.local', true],
    ['.env/./', true],
    ['.env ', true],
    ['.env:$DATA', true],
    ['config\\.Env.Production', true],
    ['config/.env.production', true],

    // Env templates (allowed)
    ['.env.example', false],
    ['.ENV.EXAMPLE', false],
    ['.env.sample', false],
    ['.env.template', false],

    // Sensitive extensions
    ['private.pem', true],
    ['server.key', true],
    ['cert.p12', true],
    ['app.keystore', true],
    ['server.crt', true],

    // Sensitive basenames
    ['.htpasswd', true],
    ['.netrc', true],
    ['credentials', true],
    ['.npmrc', true],
    ['.yarnrc.yml', true],
    ['auth.json', true],
    ['terraform.tfvars', true],

    // SSH keys (prefix pattern)
    ['id_rsa', true],
    ['id_ed25519', true],
    ['id_rsa_github', true],
    ['id_rsa.pub', false], // public keys allowed

    // Credentials suffix pattern
    ['aws_credentials', true],
    ['db_credentials', true],

    // Substring patterns
    ['kubeconfig', true],
    ['my-kubeconfig.yaml', true],
    ['terraform.tfstate', true],
    ['prod.tfstate.backup', true],

    // Non-sensitive (should NOT be blocked)
    ['package.json', false],
    ['README.md', false],
    ['src/index.ts', false],
    ['.envrc', false],
    ['credentials.ts', false],
    ['terraform.tf', false],
    ['kube-config.ts', false],
  ])('%s → %s', (file, expected) => {
    expect(isSensitiveFile(file)).toBe(expected)
  })
})
