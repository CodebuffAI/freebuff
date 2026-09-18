import { afterEach, describe, expect, mock, test } from 'bun:test'

import {
  TRUSTED_AGENT_PUBLISHERS_ENV_VAR,
  UntrustedAgentPublisherError,
  parseTrustedAgentPublishers,
  resolveTrustedAgentPublishers,
} from '../../agent-publisher-trust'
import { getAgentRuntimeImpl } from '../agent-runtime'
import { fetchAgentFromDatabase } from '../database'

import type { Logger } from '@codebuff/common/types/contracts/logger'

/**
 * A registry template's handleSteps is a SOURCE STRING that the runtime evals
 * in this process, so a template from an untrusted publisher must never be
 * handed back to the caller. Data-only templates are not code and load as
 * before.
 */

const EXECUTABLE_HANDLE_STEPS =
  "function* () { yield { toolName: 'run_terminal_command', input: { command: 'echo pwned' } } }"

const makeRegistryTemplate = (overrides: Record<string, unknown> = {}) => ({
  id: 'deployer',
  displayName: 'Deployer',
  model: 'anthropic/claude-sonnet-4',
  systemPrompt: 'You deploy things.',
  instructionsPrompt: '',
  stepPrompt: '',
  ...overrides,
})

const createLogger = (): Logger =>
  ({
    debug: mock(() => {}),
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  }) as unknown as Logger

/** Serves one registry row from GET /api/v1/agents/:publisher/:agent/:version */
const serveRegistry = (version: string, data: Record<string, unknown>) => {
  const fetchMock = mock(async (input: RequestInfo | URL) => {
    const url = new URL(
      input instanceof URL
        ? input.toString()
        : input instanceof Request
          ? input.url
          : String(input),
    )
    expect(url.pathname).toMatch(/^\/api\/v1\/agents\//)
    return new Response(JSON.stringify({ version, data }), { status: 200 })
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch
  return fetchMock
}

describe('fetchAgentFromDatabase publisher trust', () => {
  const originalFetch = globalThis.fetch
  const originalEnvValue = process.env[TRUSTED_AGENT_PUBLISHERS_ENV_VAR]

  afterEach(() => {
    globalThis.fetch = originalFetch
    if (originalEnvValue === undefined) {
      delete process.env[TRUSTED_AGENT_PUBLISHERS_ENV_VAR]
    } else {
      process.env[TRUSTED_AGENT_PUBLISHERS_ENV_VAR] = originalEnvValue
    }
    mock.restore()
  })

  const fetchAs = (
    publisherId: string,
    extra: Parameters<typeof fetchAgentFromDatabase>[0] extends infer P
      ? Partial<P>
      : never = {},
  ) =>
    fetchAgentFromDatabase({
      apiKey: 'test-api-key',
      parsedAgentId: { publisherId, agentId: 'deployer', version: '1.2.0' },
      logger: createLogger(),
      // the seam: no ambient env unless a test says so
      readTrustedAgentPublishersEnv: () => undefined,
      ...extra,
    })

  test('untrusted publisher + executable handleSteps is refused with an actionable error', async () => {
    serveRegistry(
      '1.2.0',
      makeRegistryTemplate({ handleSteps: EXECUTABLE_HANDLE_STEPS }),
    )
    const logger = createLogger()

    const attempt = fetchAs('acme', { logger })
    await expect(attempt).rejects.toBeInstanceOf(UntrustedAgentPublisherError)

    const error = await attempt.then(
      () => {
        throw new Error('expected a refusal')
      },
      (e: unknown) => e as UntrustedAgentPublisherError,
    )
    expect(error.publisherId).toBe('acme')
    expect(error.agentId).toBe('deployer')
    expect(error.version).toBe('1.2.0')
    expect(error.message).toContain('acme/deployer@1.2.0')
    expect(error.message).toContain('executable handleSteps')
    expect(error.message).toContain(
      `${TRUSTED_AGENT_PUBLISHERS_ENV_VAR}=acme`,
    )
    expect(error.message).toContain("trustedAgentPublishers: ['acme']")

    // and it is loud in the log, naming the agent, not swallowed as "not found"
    const errorCalls = (logger.error as ReturnType<typeof mock>).mock.calls
    expect(errorCalls.length).toBe(1)
    expect(JSON.stringify(errorCalls[0])).toContain('acme/deployer@1.2.0')
    expect(JSON.stringify(errorCalls[0])).toContain('untrusted publisher')
  })

  test('the refusal names the RESOLVED version when the caller asked for latest', async () => {
    serveRegistry(
      '3.0.1',
      makeRegistryTemplate({ handleSteps: EXECUTABLE_HANDLE_STEPS }),
    )

    const attempt = fetchAgentFromDatabase({
      apiKey: 'test-api-key',
      parsedAgentId: { publisherId: 'acme', agentId: 'deployer' },
      logger: createLogger(),
      readTrustedAgentPublishersEnv: () => undefined,
    })
    await expect(attempt).rejects.toThrow('acme/deployer@3.0.1')
  })

  test('untrusted publisher + data-only template (no handleSteps) loads', async () => {
    serveRegistry('1.2.0', makeRegistryTemplate())

    const template = await fetchAs('acme')
    expect(template).not.toBeNull()
    expect(template!.id).toBe('acme/deployer@1.2.0')
    expect(template!.handleSteps).toBeUndefined()
  })

  test('trusted via CODEBUFF_TRUSTED_AGENT_PUBLISHERS (the real env read) loads', async () => {
    serveRegistry(
      '1.2.0',
      makeRegistryTemplate({ handleSteps: EXECUTABLE_HANDLE_STEPS }),
    )
    process.env[TRUSTED_AGENT_PUBLISHERS_ENV_VAR] = ' other-co , acme '

    // no seam: exercise the default env getter
    const template = await fetchAgentFromDatabase({
      apiKey: 'test-api-key',
      parsedAgentId: { publisherId: 'acme', agentId: 'deployer', version: '1.2.0' },
      logger: createLogger(),
    })
    expect(template).not.toBeNull()
    expect(template!.id).toBe('acme/deployer@1.2.0')
    expect(typeof template!.handleSteps).toBe('string')
  })

  test('a publisher in the env var that is NOT this one does not help', async () => {
    serveRegistry(
      '1.2.0',
      makeRegistryTemplate({ handleSteps: EXECUTABLE_HANDLE_STEPS }),
    )
    await expect(
      fetchAs('acme', { readTrustedAgentPublishersEnv: () => 'other-co' }),
    ).rejects.toBeInstanceOf(UntrustedAgentPublisherError)
  })

  test('trusted via the trustedAgentPublishers option loads', async () => {
    serveRegistry(
      '1.2.0',
      makeRegistryTemplate({ handleSteps: EXECUTABLE_HANDLE_STEPS }),
    )

    const template = await fetchAs('acme', {
      trustedAgentPublishers: ['acme'],
    })
    expect(template).not.toBeNull()
    expect(template!.id).toBe('acme/deployer@1.2.0')
  })

  test('the codebuff publisher is always trusted', async () => {
    serveRegistry(
      '1.2.0',
      makeRegistryTemplate({ handleSteps: EXECUTABLE_HANDLE_STEPS }),
    )

    const template = await fetchAs('codebuff')
    expect(template).not.toBeNull()
    expect(template!.id).toBe('codebuff/deployer@1.2.0')
  })

  test('publisher ids are matched exactly, not by case or substring', async () => {
    serveRegistry(
      '1.2.0',
      makeRegistryTemplate({ handleSteps: EXECUTABLE_HANDLE_STEPS }),
    )
    await expect(
      fetchAs('acme', { trustedAgentPublishers: ['Acme', 'acme-corp', 'ac'] }),
    ).rejects.toBeInstanceOf(UntrustedAgentPublisherError)
  })

  test('getAgentRuntimeImpl threads the option into the registry fetch', async () => {
    serveRegistry(
      '1.2.0',
      makeRegistryTemplate({ handleSteps: EXECUTABLE_HANDLE_STEPS }),
    )
    // the impl reads the real env; a developer shell must not decide this test
    delete process.env[TRUSTED_AGENT_PUBLISHERS_ENV_VAR]
    const noop = async () => {
      throw new Error('not used')
    }
    const scoped = {
      handleStepsLogChunk: () => {},
      requestToolCall: noop as any,
      requestMcpToolData: noop as any,
      requestFiles: noop as any,
      requestImageFile: noop as any,
      requestOptionalFile: noop as any,
      sendAction: () => {},
      sendSubagentChunk: () => {},
    }
    const parsedAgentId = {
      publisherId: 'acme',
      agentId: 'deployer',
      version: '1.2.0',
    }

    const untrusted = getAgentRuntimeImpl({ apiKey: 'k', ...scoped })
    await expect(
      untrusted.fetchAgentFromDatabase({
        apiKey: 'k',
        parsedAgentId,
        logger: createLogger(),
      }),
    ).rejects.toBeInstanceOf(UntrustedAgentPublisherError)

    const trusted = getAgentRuntimeImpl({
      apiKey: 'k',
      trustedAgentPublishers: ['acme'],
      ...scoped,
    })
    const template = await trusted.fetchAgentFromDatabase({
      apiKey: 'k',
      parsedAgentId,
      logger: createLogger(),
    })
    expect(template?.id).toBe('acme/deployer@1.2.0')
  })

  test('disableAgentRegistry refuses every registry fetch, even a trusted publisher', async () => {
    // The embedded Freebuff Web runner bundles every agent it runs; a missing
    // spawnable id must be "not found", never a fetch of codebuff/<id>@latest.
    let fetched = 0
    globalThis.fetch = (async () => {
      fetched++
      throw new Error('registry must not be reached')
    }) as unknown as typeof fetch
    const noop = async () => {
      throw new Error('not used')
    }
    const impl = getAgentRuntimeImpl({
      apiKey: 'k',
      disableAgentRegistry: true,
      trustedAgentPublishers: ['acme'],
      handleStepsLogChunk: () => {},
      requestToolCall: noop as any,
      requestMcpToolData: noop as any,
      requestFiles: noop as any,
      requestImageFile: noop as any,
      requestOptionalFile: noop as any,
      sendAction: () => {},
      sendSubagentChunk: () => {},
    })
    for (const publisherId of ['codebuff', 'acme']) {
      const template = await impl.fetchAgentFromDatabase({
        apiKey: 'k',
        parsedAgentId: { publisherId, agentId: 'deployer', version: undefined },
        logger: createLogger(),
      })
      expect(template).toBeNull()
    }
    expect(fetched).toBe(0)
  })
})

describe('trusted publisher list parsing', () => {
  test('parseTrustedAgentPublishers splits on commas and drops blanks', () => {
    expect(parseTrustedAgentPublishers(undefined)).toEqual([])
    expect(parseTrustedAgentPublishers('')).toEqual([])
    expect(parseTrustedAgentPublishers(' , ,')).toEqual([])
    expect(parseTrustedAgentPublishers('acme')).toEqual(['acme'])
    expect(parseTrustedAgentPublishers(' acme, other-co ,,')).toEqual([
      'acme',
      'other-co',
    ])
  })

  test('resolveTrustedAgentPublishers is codebuff ∪ env ∪ option', () => {
    expect([...resolveTrustedAgentPublishers({})]).toEqual(['codebuff'])
    const resolved = resolveTrustedAgentPublishers({
      envValue: 'env-co, both',
      trustedAgentPublishers: ['opt-co', ' both ', ''],
    })
    expect([...resolved].sort()).toEqual(
      ['both', 'codebuff', 'env-co', 'opt-co'].sort(),
    )
  })
})
