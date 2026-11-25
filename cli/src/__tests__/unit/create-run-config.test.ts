import { describe, test, expect, mock } from 'bun:test'

import { buildAdAuctionRequest } from '../../ads/ad-request'
import { createStreamController } from '../../hooks/stream-state'
import { useChatStore } from '../../state/chat-store'
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

describe('every run carries the ad session and UA for gravity_index', () => {
  const run = (extraCodebuffMetadata?: Record<string, string>) =>
    createRunConfig({
      agent: 'custom',
      prompt: 'hi',
      content: undefined,
      previousRunState: null,
      agentDefinitions: [],
      signal: new AbortController().signal,
      ...(extraCodebuffMetadata ? { extraCodebuffMetadata } : {}),
    } as unknown as CreateRunConfigParams)

  // The values Gravity sees on this chat's ad requests: body `sessionId` and
  // the `User-Agent` header (resolveGravityUserAgent prefers the header).
  const adRequestIdentity = async () => {
    const saved = process.env.CODEBUFF_API_KEY
    process.env.CODEBUFF_API_KEY = saved || 'test-key'
    try {
      const built = await buildAdAuctionRequest({
        provider: 'gravity',
        surface: 'cli_chat',
        placementId: 'Above-Input-CLI',
      })
      expect(built).not.toBeNull()
      return {
        sessionId: JSON.parse(String(built!.init.body)).sessionId as string,
        userAgent: (built!.init.headers as Record<string, string>)[
          'User-Agent'
        ],
      }
    } finally {
      if (saved === undefined) delete process.env.CODEBUFF_API_KEY
      else process.env.CODEBUFF_API_KEY = saved
    }
  }

  test('equal to the ad request, with no caller metadata (Codebuff, BYOK)', async () => {
    const ad = await adRequestIdentity()
    expect(ad.sessionId).toBeString()
    expect(run().extraCodebuffMetadata).toEqual({
      gravity_ad_session_id: ad.sessionId,
      gravity_end_user_agent: ad.userAgent,
    })
  })

  test('follows a new chat, as the ad request does', async () => {
    const before = run().extraCodebuffMetadata.gravity_ad_session_id
    useChatStore.getState().reset()
    const ad = await adRequestIdentity()
    expect(ad.sessionId).not.toBe(before)
    expect(run().extraCodebuffMetadata.gravity_ad_session_id).toBe(ad.sessionId)
  })

  test("merged under the caller's metadata, which is kept", async () => {
    const ad = await adRequestIdentity()
    expect(run({ freebuff_instance_id: 'inst-1' }).extraCodebuffMetadata).toEqual({
      gravity_ad_session_id: ad.sessionId,
      gravity_end_user_agent: ad.userAgent,
      freebuff_instance_id: 'inst-1',
    })
  })
})
