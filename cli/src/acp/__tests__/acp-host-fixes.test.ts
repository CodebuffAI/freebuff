import { afterEach, describe, expect, mock, test } from 'bun:test'

import {
  FREEBUFF_ACP_MODEL_MODES,
  FreebuffAcpAgent,
  formatFreebuffAcpError,
} from '../acp-agent'
import {
  AcpFreebuffSession,
  AcpSessionError,
  describeRefusal,
} from '../freebuff-session'
import { FreebuffSessionRequestError } from '../../utils/freebuff-session-api'
import { parseArgs } from '../../cli-args'
import {
  AGENT_MODE_TO_COST_MODE,
  AGENT_MODE_TO_ID,
} from '../../utils/constants'
import { getCliAdRequestUserAgent } from '../../utils/ad-client-identity'
import {
  FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID,
  FREEBUFF_MIMO_V25_MODEL_ID,
} from '@codebuff/common/constants/freebuff-models'
import { useFreebuffModelStore } from '../../state/freebuff-model-store'

import type { FreebuffSessionServerResponse } from '@codebuff/common/types/freebuff-session'
import type { ContentBlock } from '@agentclientprotocol/sdk'

afterEach(() => {
  mock.restore()
})

describe('formatFreebuffAcpError', () => {
  test('maps third_party_client to a clear host message', () => {
    const message = formatFreebuffAcpError(
      'refused: third_party_client_warning on completions',
    )
    expect(message).toContain('official')
    expect(message).toContain('third-party')
    expect(message).toContain('Original:')
  })

  test('maps prompt_policy to a clear usage-policy message', () => {
    const message = formatFreebuffAcpError(
      'prompt_policy: scripted or automated traffic',
    )
    expect(message).toContain('usage policy')
    expect(message).toContain('Original:')
  })
})

describe('parseArgs --acp implies trustAgents', () => {
  test('--acp alone sets trustAgents', () => {
    const result = parseArgs({
      argv: ['node', 'freebuff', '--acp'],
      isFreebuff: true,
      version: '1.0.0',
    })
    expect(result.acp).toBe(true)
    expect(result.trustAgents).toBe(true)
  })

  test('without --acp, trustAgents stays false', () => {
    expect(
      parseArgs({
        argv: ['node', 'freebuff'],
        isFreebuff: true,
        version: '1.0.0',
      }).trustAgents,
    ).toBe(false)
  })

  test('--acp early branch runs before OSC / interactive TTY setup', async () => {
    const source = await Bun.file(`${import.meta.dir}/../../index.tsx`).text()
    const early = source.indexOf('const serveAcpEarly')
    // Match the runtime OSC call site (background promise), not the import line.
    const oscRuntime = source.indexOf('? detectTerminalTheme()')
    const trustPrompt = source.indexOf('trustAgents || isTruthyOptIn')
    expect(early).toBeGreaterThan(-1)
    expect(oscRuntime).toBeGreaterThan(-1)
    expect(early).toBeLessThan(oscRuntime)
    // Early return must also precede the interactive trustAgents prompt path.
    expect(trustPrompt).toBeGreaterThan(early)
  })
})

describe('lowercase user-agent on completions', () => {
  test('getCliAdRequestUserAgent returns Freebuff-CLI product token', () => {
    const ua = getCliAdRequestUserAgent()
    expect(ua.startsWith('Freebuff-CLI/') || ua.startsWith('Codebuff-CLI/')).toBe(
      true,
    )
  })

  test('requestHeaders object key is lowercase user-agent', async () => {
    // Read the source contract: the merge key must be lowercase so it
    // overwrites the AI SDK's User-Agent and avoids a 403.
    const sourcePath = `${import.meta.dir}/../../utils/codebuff-client.ts`
    const source = await Bun.file(sourcePath).text()
    expect(source).toContain("'user-agent': getCliAdRequestUserAgent()")
    expect(source).not.toMatch(/'User-Agent': getCliAdRequestUserAgent\(\)/)
  })
})

describe('setSessionMode', () => {
  test('switches Freebuff model and agent/cost mode via the mode maps', async () => {
    const turns: Array<{ mode: string; agent: string; costMode: string }> = []
    const backend = new FreebuffAcpAgent({
      runTurn: async (request) => {
        turns.push({
          mode: request.mode,
          agent: AGENT_MODE_TO_ID[request.mode],
          costMode: AGENT_MODE_TO_COST_MODE[request.mode],
        })
        return { previousRun: null }
      },
    })
    const sessionId = backend.newSession('/tmp/project')
    const modes = backend.sessionModes(sessionId)
    expect(modes.availableModes.some((m) => m.id === FREEBUFF_ACP_MODEL_MODES[0]!.id)).toBe(
      true,
    )

    backend.setSessionMode(sessionId, 'MAX')
    expect(backend.sessionModes(sessionId).currentModeId).toBe('MAX')
    backend.setSessionMode(sessionId, FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID)
    expect(backend.sessionModes(sessionId).currentModeId).toBe(
      FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID,
    )
    expect(useFreebuffModelStore.getState().selectedModel).toBe(
      FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID,
    )

    const cx = { notify: async () => {} }
    const stop = await backend.prompt(
      sessionId,
      [{ type: 'text', text: 'ping' }] as ContentBlock[],
      cx as never,
    )
    expect(stop).toBe('end_turn')
    expect(turns).toHaveLength(1)
    expect(turns[0]).toEqual({
      mode: 'MAX',
      agent: AGENT_MODE_TO_ID.MAX,
      costMode: AGENT_MODE_TO_COST_MODE.MAX,
    })
  })

  test('unknown mode raises an ACP invalid-params error', () => {
    const backend = new FreebuffAcpAgent()
    const sessionId = backend.newSession('/tmp/project')
    expect(() => backend.setSessionMode(sessionId, 'not-a-real-mode')).toThrow(
      /Unknown Freebuff model mode/,
    )
  })
})

describe('refused admission reported exactly once', () => {
  test('notice + stopReason refusal, no thrown error, no duplicate', async () => {
    const updates: Array<Record<string, unknown>> = []
    const backend = new FreebuffAcpAgent({
      runTurn: async () => {
        throw new AcpSessionError(
          describeRefusal({
            status: 'rate_limited',
          } as FreebuffSessionServerResponse),
        )
      },
    })
    const sessionId = backend.newSession('/tmp/project')
    const cx = {
      notify: async (
        _method: string,
        params: { update: Record<string, unknown> },
      ) => {
        updates.push(params.update)
      },
    }

    const stop = await backend.prompt(
      sessionId,
      [{ type: 'text', text: 'hello' }] as ContentBlock[],
      cx as never,
    )

    expect(stop).toBe('refusal')
    // Exactly one standard update: an agent message with a text block.
    expect(updates).toHaveLength(1)
    expect(updates[0]).toEqual({
      sessionUpdate: 'agent_message_chunk',
      content: {
        type: 'text',
        text: expect.stringContaining('session limit'),
      },
    })
    expect(JSON.stringify(updates)).not.toContain('"notice"')
  })

  test('error event is an agent_message_chunk, set apart from streamed text', async () => {
    const texts: string[] = []
    const backend = new FreebuffAcpAgent({
      runTurn: async (request) => {
        await request.onEvent({ type: 'text', text: 'Partial answer.' } as never)
        await request.onEvent({
          type: 'error',
          message: 'session limit reached',
        } as never)
        return { previousRun: null }
      },
    })
    const sessionId = backend.newSession('/tmp/project')
    const cx = {
      notify: async (
        _method: string,
        params: {
          update: { sessionUpdate: string; content?: { text?: string } }
        },
      ) => {
        expect(params.update.sessionUpdate).toBe('agent_message_chunk')
        texts.push(params.update.content?.text ?? '')
      },
    }

    await backend.prompt(
      sessionId,
      [{ type: 'text', text: 'hello' }] as ContentBlock[],
      cx as never,
    )

    expect(texts).toHaveLength(2)
    expect(texts[0]).toBe('Partial answer.')
    // Blank-line separated, so it does not read as the model's last sentence.
    expect(texts[1]).toStartWith('\n\n')
    expect(texts.join('')).toContain('Partial answer.\n\nFreebuff session limit')
  })
})

describe('session/cancel', () => {
  test('abort mid-turn returns stopReason cancelled, not a thrown error', async () => {
    const backend = new FreebuffAcpAgent({
      runTurn: async (request) => {
        await new Promise<void>((_, reject) => {
          request.signal.addEventListener('abort', () => {
            const err = new Error('The operation was aborted.')
            err.name = 'AbortError'
            reject(err)
          })
        })
        return { previousRun: null }
      },
    })
    const sessionId = backend.newSession('/tmp/project')
    const cx = { notify: async () => {} }
    const pending = backend.prompt(
      sessionId,
      [{ type: 'text', text: 'hello' }] as ContentBlock[],
      cx as never,
    )
    await new Promise((r) => setTimeout(r, 10))
    backend.cancel(sessionId)
    expect(await pending).toBe('cancelled')
  })
})

describe('AcpFreebuffSession ensureNow polling', () => {
  test('model_unavailable chooses a fallback model then admits', async () => {
    useFreebuffModelStore
      .getState()
      .setSelectedModel(FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID)

    const calls: Array<{ method: string; model?: string }> = []
    let clock = 0
    const session = new AcpFreebuffSession({
      isFreebuff: true,
      admitDeadlineMs: 90_000,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms
      },
      getToken: () => ({ token: 'test-token' }),
      callSession: async (method, _token, opts) => {
        const model = opts?.model
        calls.push({ method, model })
        if (method === 'POST' && calls.filter((c) => c.method === 'POST').length === 1) {
          return {
            status: 'model_unavailable',
            requestedModel: FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID,
          } as FreebuffSessionServerResponse
        }
        return {
          status: 'active',
          instanceId: 'inst-1',
          model: model ?? 'fallback',
          expiresAt: new Date(clock + 3_600_000).toISOString(),
        } as FreebuffSessionServerResponse
      },
    })

    const admission = await session.ensure()
    expect(admission?.instanceId).toBe('inst-1')
    expect(calls.some((c) => c.method === 'POST' && c.model !== FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID)).toBe(
      true,
    )
    // The retry names the other model explicitly, and that is what is admitted.
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.model)).toEqual([
      FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID,
      FREEBUFF_MIMO_V25_MODEL_ID,
    ])
    expect(admission?.model).toBe(FREEBUFF_MIMO_V25_MODEL_ID)
  })

  test('model_unavailable on MiMo falls back to DeepSeek', async () => {
    useFreebuffModelStore.getState().setSelectedModel(FREEBUFF_MIMO_V25_MODEL_ID)

    const posts: Array<string | undefined> = []
    let clock = 0
    const session = new AcpFreebuffSession({
      isFreebuff: true,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms
      },
      getToken: () => ({ token: 'test-token' }),
      callSession: async (method, _token, opts) => {
        if (method === 'POST') posts.push(opts?.model)
        if (method === 'POST' && posts.length === 1) {
          return {
            status: 'model_unavailable',
            requestedModel: FREEBUFF_MIMO_V25_MODEL_ID,
          } as FreebuffSessionServerResponse
        }
        return {
          status: 'active',
          instanceId: 'inst-2',
          model: opts?.model,
          expiresAt: new Date(clock + 3_600_000).toISOString(),
        } as FreebuffSessionServerResponse
      },
    })

    await session.ensure()
    expect(posts).toEqual([
      FREEBUFF_MIMO_V25_MODEL_ID,
      FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID,
    ])
  })

  test('transient 408/429/503 backoff then give up at deadline with ACP error', async () => {
    let clock = 0
    const statuses: number[] = []
    const session = new AcpFreebuffSession({
      isFreebuff: true,
      admitDeadlineMs: 90_000,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms
      },
      getToken: () => ({ token: 'test-token' }),
      callSession: async () => {
        statuses.push(429)
        throw new FreebuffSessionRequestError('rate limited', 429, 1_000)
      },
    })

    await expect(session.ensure()).rejects.toThrow(/Timed out waiting for a Freebuff session/)
    expect(statuses.length).toBeGreaterThan(1)
    expect(clock).toBeGreaterThanOrEqual(90_000)
  })
})

describe('process lifetime release', () => {
  test('release is invoked for shutdown reasons covering exit paths', async () => {
    const deleted: string[] = []
    const session = new AcpFreebuffSession({
      isFreebuff: true,
      getToken: () => ({ token: 'test-token' }),
      callSession: async (method, _token, opts) => {
        if (method === 'DELETE') {
          deleted.push(opts?.instanceId ?? '')
          return { status: 'ended' } as FreebuffSessionServerResponse
        }
        return {
          status: 'active',
          instanceId: 'inst-lifetime',
          model: 'm',
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        } as FreebuffSessionServerResponse
      },
    })

    session.seedAdmissionForTests({
      instanceId: 'inst-lifetime',
      model: 'm',
      expiresAtMs: Date.now() + 3_600_000,
    })

    // serveAcp wires: normal exit / SIGINT / SIGTERM / stdin close → release
    for (const reason of ['shutdown', 'SIGINT', 'SIGTERM', 'stdin-close']) {
      session.seedAdmissionForTests({
        instanceId: `inst-${reason}`,
        model: 'm',
        expiresAtMs: Date.now() + 3_600_000,
      })
      await session.release(reason)
    }

    expect(deleted).toEqual([
      'inst-shutdown',
      'inst-SIGINT',
      'inst-SIGTERM',
      'inst-stdin-close',
    ])
  })
})
