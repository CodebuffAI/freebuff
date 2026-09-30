import fs from 'fs'
import os from 'os'
import path from 'path'

import {
  DEFAULT_FREEBUFF_MODEL_ID,
  FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID,
  FREEBUFF_MIMO_V25_MODEL_ID,
  FREEBUFF_MIMO_V26_PRO_MODEL_ID,
} from '@codebuff/common/constants/freebuff-models'
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'

import {
  getFreebuffCatalog,
  getFreebuffModelDirectory,
  setFreebuffCatalog,
  useFreebuffCatalogStore,
} from '../../state/freebuff-catalog-store'
import { useFreebuffChatStore } from '../../state/freebuff-chat-store'
import {
  getEffectiveFreebuffReasoningEffort,
  getSelectedFreebuffModel,
  persistFreebuffModelPick,
  useFreebuffModelStore,
} from '../../state/freebuff-model-store'
import * as auth from '../auth'
import {
  applyFreebuffCatalog,
  createFreebuffCatalogController,
  fetchFreebuffModelCatalog,
  isFreebuffCatalogStaleError,
  runWithFreebuffCatalogStaleRetry,
  type FreebuffCatalogControllerDeps,
  type FreebuffCatalogFetchResult,
} from '../freebuff-model-catalog'
import {
  resolveFreebuffModelPickForSession,
  resolveFreebuffModelSelectionForSession,
} from '../../hooks/use-freebuff-session'
import {
  getSettingsPath,
  loadSettings,
  saveFreebuffModelPreference,
} from '../settings'
import { catalogFixture, catalogRow, rotateHandles } from './freebuff-catalog-fixtures'

import type { FreebuffModelCatalog } from '@codebuff/common/types/freebuff-model-catalog'

let configDir: string
let configSpy: ReturnType<typeof spyOn>

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuff-catalog-test-'))
  configSpy = spyOn(auth, 'getConfigDir').mockReturnValue(configDir)
})

afterEach(() => {
  setFreebuffCatalog(null)
  useFreebuffCatalogStore.setState({ refreshAfterStale: null })
  useFreebuffChatStore.setState({ nextModel: null })
  useFreebuffModelStore.getState().setSelectedModel(DEFAULT_FREEBUFF_MODEL_ID)
  useFreebuffModelStore.setState({ reasoningEffortByModel: {} })
  configSpy.mockRestore()
  fs.rmSync(configDir, { recursive: true, force: true })
})

const CATALOG = catalogFixture(
  [
    catalogRow('m-mimo', {
      displayName: 'MiMo',
      legacyIds: [FREEBUFF_MIMO_V25_MODEL_ID],
    }),
    catalogRow('m-flash', {
      displayName: 'Flash',
      legacyIds: [FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID],
      efforts: ['low', 'high', 'max'],
      defaultEffort: 'high',
    }),
    catalogRow('m-only-here', { displayName: 'Catalog only' }),
  ],
  { recommendedKey: 'm-only-here', fallbackKey: 'm-mimo' },
)

describe('fetchFreebuffModelCatalog', () => {
  const respond = (response: Response | Error) => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      if (response instanceof Error) throw response
      return response
    }) as unknown as typeof fetch
    return { calls, fetchImpl }
  }

  test('asks with the bearer, the protocol header and the CLI client name', async () => {
    const { calls, fetchImpl } = respond(Response.json(CATALOG))
    const result = await fetchFreebuffModelCatalog('tok', {
      fetchImpl,
      baseUrl: 'https://api.test',
    })
    expect(result).toEqual({ kind: 'ok', catalog: CATALOG })
    expect(calls[0]!.url).toBe('https://api.test/api/v1/freebuff/models')
    const headers = new Headers(calls[0]!.init.headers)
    expect(headers.get('authorization')).toBe('Bearer tok')
    expect(headers.get('x-freebuff-catalog-protocol')).toBe('1')
    expect(headers.get('x-freebuff-client')).toBe('cli')
  })

  test('an older server (404) is a definitive "no catalog"', async () => {
    const { fetchImpl } = respond(new Response('not found', { status: 404 }))
    expect((await fetchFreebuffModelCatalog('tok', { fetchImpl })).kind).toBe(
      'unsupported',
    )
  })

  test('a body this client does not speak is unsupported, not an error', async () => {
    const garbage = respond(Response.json({ protocol: 2, rows: 'nope' }))
    expect(
      (await fetchFreebuffModelCatalog('tok', { fetchImpl: garbage.fetchImpl }))
        .kind,
    ).toBe('unsupported')
    const notJson = respond(new Response('<html>', { status: 200 }))
    expect(
      (await fetchFreebuffModelCatalog('tok', { fetchImpl: notJson.fetchImpl }))
        .kind,
    ).toBe('unsupported')
    const empty = respond(Response.json(catalogFixture([])))
    expect(
      (await fetchFreebuffModelCatalog('tok', { fetchImpl: empty.fetchImpl }))
        .kind,
    ).toBe('unsupported')
  })

  test('network failures and 5xx are transient errors', async () => {
    const down = respond(new Error('fetch failed'))
    expect(
      (await fetchFreebuffModelCatalog('tok', { fetchImpl: down.fetchImpl }))
        .kind,
    ).toBe('error')
    const busy = respond(new Response('', { status: 503 }))
    expect(
      (await fetchFreebuffModelCatalog('tok', { fetchImpl: busy.fetchImpl }))
        .kind,
    ).toBe('error')
  })

  test('strips terminal escape sequences from every row string', async () => {
    const hostile = catalogFixture([
      catalogRow('m-x', { displayName: 'Evil\u001b[2J name' }),
    ])
    const { fetchImpl } = respond(Response.json(hostile))
    const result = await fetchFreebuffModelCatalog('tok', { fetchImpl })
    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') {
      expect(result.catalog.rows[0]!.displayName).not.toContain('\u001b')
    }
  })
})

describe('createFreebuffCatalogController', () => {
  const harness = (results: FreebuffCatalogFetchResult[]) => {
    let now = CATALOG.issuedAt
    let held: FreebuffModelCatalog | null = null
    const timers: Array<{ callback: () => void; ms: number; id: number }> = []
    let nextId = 0
    let fetches = 0
    const deps: FreebuffCatalogControllerDeps = {
      fetchCatalog: async () => {
        fetches++
        return results.shift() ?? { kind: 'error' }
      },
      applyCatalog: (catalog) => {
        held = catalog
      },
      getCatalog: () => held,
      now: () => now,
      setTimer: (callback, ms) => {
        const id = nextId++
        timers.push({ callback, ms, id })
        return id
      },
      clearTimer: (id) => {
        const index = timers.findIndex((timer) => timer.id === id)
        if (index >= 0) timers.splice(index, 1)
      },
    }
    return {
      controller: createFreebuffCatalogController('tok', deps),
      held: () => held,
      timers,
      fetches: () => fetches,
      advance: (ms: number) => {
        now += ms
      },
    }
  }

  test('schedules the next fetch at refreshAt', async () => {
    const h = harness([{ kind: 'ok', catalog: CATALOG }])
    await h.controller.load()
    expect(h.held()).toBe(CATALOG)
    expect(h.timers.map((t) => t.ms)).toEqual([
      CATALOG.refreshAt - CATALOG.issuedAt,
    ])
  })

  test('clamps a refreshAt in the past so it cannot become a tight loop', async () => {
    const h = harness([
      { kind: 'ok', catalog: { ...CATALOG, refreshAt: CATALOG.issuedAt - 1 } },
    ])
    await h.controller.load()
    expect(h.timers[0]!.ms).toBe(30_000)
  })

  test('a transient error keeps the held catalog and backs off', async () => {
    const h = harness([
      { kind: 'ok', catalog: CATALOG },
      { kind: 'error' },
      { kind: 'error' },
    ])
    await h.controller.load()
    await h.controller.refresh()
    expect(h.held()).toBe(CATALOG)
    expect(h.timers.map((t) => t.ms)).toEqual([60_000])
    await h.controller.refresh()
    expect(h.timers.map((t) => t.ms)).toEqual([120_000])
  })

  test('an unsupported answer returns to fallback mode and stops polling', async () => {
    const h = harness([{ kind: 'ok', catalog: CATALOG }, { kind: 'unsupported' }])
    await h.controller.load()
    await h.controller.refresh()
    expect(h.held()).toBeNull()
    expect(h.timers).toEqual([])
  })

  test('the scheduled timer refetches', async () => {
    const h = harness([
      { kind: 'ok', catalog: CATALOG },
      { kind: 'ok', catalog: rotateHandles(CATALOG, 2) },
    ])
    await h.controller.load()
    h.timers[0]!.callback()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(h.fetches()).toBe(2)
    expect(h.held()?.rows[0]!.handle).toBe('fbm1.m-mimo-h2')
  })

  test('refetches when the access tier or plan changes, never on first sight', async () => {
    const h = harness([
      { kind: 'ok', catalog: CATALOG },
      { kind: 'ok', catalog: CATALOG },
      { kind: 'ok', catalog: CATALOG },
    ])
    await h.controller.load()
    h.controller.noteViewer({ accessTier: 'full', subscriptionTierId: null })
    h.controller.noteViewer({ accessTier: 'full' })
    h.controller.noteViewer({})
    expect(h.fetches()).toBe(1)
    h.controller.noteViewer({ accessTier: 'limited' })
    await h.controller.refresh()
    expect(h.fetches()).toBe(2)
    h.controller.noteViewer({ subscriptionTierId: 'starter' })
    await h.controller.refresh()
    expect(h.fetches()).toBe(3)
  })

  test('a stale refresh succeeds once, then cools down instead of looping', async () => {
    const h = harness([
      { kind: 'ok', catalog: CATALOG },
      { kind: 'ok', catalog: rotateHandles(CATALOG, 2) },
      { kind: 'ok', catalog: rotateHandles(CATALOG, 3) },
    ])
    await h.controller.load()
    expect(await h.controller.refreshAfterStale()).toBe(true)
    expect(await h.controller.refreshAfterStale()).toBe(false)
    h.advance(10_000)
    expect(await h.controller.refreshAfterStale()).toBe(true)
    expect(h.fetches()).toBe(3)
  })

  test('concurrent stale refreshes share one fetch', async () => {
    const h = harness([
      { kind: 'ok', catalog: CATALOG },
      { kind: 'ok', catalog: rotateHandles(CATALOG, 2) },
    ])
    await h.controller.load()
    const [a, b] = await Promise.all([
      h.controller.refreshAfterStale(),
      h.controller.refreshAfterStale(),
    ])
    expect([a, b]).toEqual([true, true])
    expect(h.fetches()).toBe(2)
  })

  test('a stale refresh that finds no catalog reports failure', async () => {
    const h = harness([{ kind: 'ok', catalog: CATALOG }, { kind: 'unsupported' }])
    await h.controller.load()
    expect(await h.controller.refreshAfterStale()).toBe(false)
  })
})

describe('applyFreebuffCatalog', () => {
  test('migrates a pre-catalog pick onto its row by legacy digest', () => {
    useFreebuffModelStore
      .getState()
      .setSelectedModel(FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID)
    applyFreebuffCatalog(CATALOG)
    expect(getSelectedFreebuffModel()).toBe('m-flash')
  })

  test('a saved catalog key wins over the compiled pick', () => {
    useFreebuffModelStore
      .getState()
      .setSelectedModel(FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID)
    setFreebuffCatalog(CATALOG)
    persistFreebuffModelPick('m-mimo')
    setFreebuffCatalog(null)
    applyFreebuffCatalog(CATALOG)
    expect(getSelectedFreebuffModel()).toBe('m-mimo')
  })

  test('a compiled pick made after the key clears it, so the newer pick wins', () => {
    setFreebuffCatalog(CATALOG)
    persistFreebuffModelPick('m-mimo')
    expect(loadSettings().freebuffModelKey).toBe('m-mimo')
    setFreebuffCatalog(null)
    saveFreebuffModelPreference(FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID)
    expect(loadSettings().freebuffModelKey).toBeUndefined()
    expect(loadSettings().freebuffModel).toBe(FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID)
    useFreebuffModelStore
      .getState()
      .setSelectedModel(FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID)
    applyFreebuffCatalog(CATALOG)
    expect(getSelectedFreebuffModel()).toBe('m-flash')
  })

  test('an id no row replaces lands on the recommendation', () => {
    // The compiled default: a real selection that CATALOG has no row for.
    useFreebuffModelStore.getState().setSelectedModel(DEFAULT_FREEBUFF_MODEL_ID)
    applyFreebuffCatalog(CATALOG)
    expect(getSelectedFreebuffModel()).toBe('m-only-here')
  })

  test('a row that leaves the catalog falls to the recommendation', () => {
    applyFreebuffCatalog(CATALOG)
    useFreebuffModelStore.getState().setSelectedModel('m-flash')
    applyFreebuffCatalog(
      catalogFixture([CATALOG.rows[0]!, CATALOG.rows[2]!], {
        recommendedKey: 'm-mimo',
      }),
    )
    expect(getSelectedFreebuffModel()).toBe('m-mimo')
  })

  test('leaving catalog mode restores the saved compiled pick', () => {
    saveFreebuffModelPreference(FREEBUFF_MIMO_V26_PRO_MODEL_ID)
    applyFreebuffCatalog(CATALOG)
    useFreebuffModelStore.getState().setSelectedModel('m-only-here')
    useFreebuffChatStore.setState({ nextModel: 'm-mimo' })
    applyFreebuffCatalog(null)
    expect(getFreebuffCatalog()).toBeNull()
    expect(getSelectedFreebuffModel()).toBe(FREEBUFF_MIMO_V26_PRO_MODEL_ID)
    expect(useFreebuffChatStore.getState().nextModel).toBeNull()
  })

  test('re-keys an unsent chat pick', () => {
    useFreebuffChatStore.setState({ nextModel: FREEBUFF_MIMO_V25_MODEL_ID })
    applyFreebuffCatalog(CATALOG)
    expect(useFreebuffChatStore.getState().nextModel).toBe('m-mimo')
  })

  test('never writes a handle to disk', () => {
    applyFreebuffCatalog(CATALOG)
    persistFreebuffModelPick('m-flash')
    useFreebuffModelStore.getState().setReasoningEffort('m-flash', 'max')
    const file = fs.readFileSync(path.join(configDir, 'settings.json'), 'utf8')
    expect(file).not.toContain('fbm1.')
    expect(loadSettings().freebuffCatalogReasoningEfforts).toEqual({
      'm-flash': 'max',
    })
  })
})

describe('settings', () => {
  test('keeps a key-shaped saved key and drops anything else', () => {
    fs.writeFileSync(
      getSettingsPath(),
      JSON.stringify({
        freebuffModelKey: 'm-flash',
        freebuffCatalogReasoningEfforts: {
          'm-flash': 'max',
          'm-bad': 'loud',
          'Not A Key/1': 'low',
        },
      }),
    )
    expect(loadSettings().freebuffModelKey).toBe('m-flash')
    expect(loadSettings().freebuffCatalogReasoningEfforts).toEqual({
      'm-flash': 'max',
    })
    fs.writeFileSync(
      getSettingsPath(),
      JSON.stringify({ freebuffModelKey: 'fbm1.Handle/Not+A+Key' }),
    )
    expect(loadSettings().freebuffModelKey).toBeUndefined()
  })
})

describe('session picks in catalog mode', () => {
  test('an explicit pick keeps a key and maps a stray id onto its row', () => {
    setFreebuffCatalog(CATALOG)
    const none = { status: 'none', accessTier: 'limited' } as const
    expect(resolveFreebuffModelPickForSession('m-only-here', none)).toBe(
      'm-only-here',
    )
    expect(
      resolveFreebuffModelPickForSession(FREEBUFF_MIMO_V25_MODEL_ID, none),
    ).toBe('m-mimo')
    expect(resolveFreebuffModelPickForSession('m-gone', none)).toBe(
      'm-only-here',
    )
  })

  test('an active session re-keyed by the server wins the selection', () => {
    setFreebuffCatalog(CATALOG)
    expect(
      resolveFreebuffModelSelectionForSession('m-mimo', {
        status: 'active',
        model: 'm-flash',
      } as never),
    ).toBe('m-flash')
  })
})

describe('reasoning effort per catalog row', () => {
  test('uses the row ladder and default', () => {
    applyFreebuffCatalog(CATALOG)
    expect(getEffectiveFreebuffReasoningEffort('m-flash')).toBe('high')
    useFreebuffModelStore.getState().setReasoningEffort('m-flash', 'low')
    expect(getEffectiveFreebuffReasoningEffort('m-flash')).toBe('low')
    expect(getEffectiveFreebuffReasoningEffort('m-mimo')).toBeNull()
  })

  test('inherits the effort saved for the compiled model the row replaces', () => {
    useFreebuffModelStore
      .getState()
      .setReasoningEffort(FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID, 'max')
    applyFreebuffCatalog(CATALOG)
    expect(getEffectiveFreebuffReasoningEffort('m-flash')).toBe('max')
    useFreebuffModelStore
      .getState()
      .setReasoningEffort(FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID, undefined)
  })

  test('ignores a saved rung the row no longer offers', () => {
    applyFreebuffCatalog(CATALOG)
    useFreebuffModelStore.getState().setReasoningEffort('m-flash', 'max')
    applyFreebuffCatalog(
      catalogFixture([
        catalogRow('m-flash', { efforts: ['low', 'high'], defaultEffort: 'low' }),
      ]),
    )
    expect(getEffectiveFreebuffReasoningEffort('m-flash')).toBe('low')
  })
})

describe('the directory in catalog mode', () => {
  test('maps the step-down, recommendation and locks from the catalog', () => {
    setFreebuffCatalog(
      catalogFixture([
        ...CATALOG.rows,
        catalogRow('m-locked', { access: 'locked', lockedLabel: 'Pro' }),
      ], { recommendedKey: 'm-only-here', fallbackKey: 'm-mimo' }),
    )
    const directory = getFreebuffModelDirectory()
    expect(directory.recommendedModelId('full')).toBe('m-only-here')
    expect(directory.fallbackModelId).toBe('m-mimo')
    expect(directory.planRequired('m-locked', false, undefined)).toBe(true)
    expect(directory.planRequired('m-mimo', false, undefined)).toBe(false)
    expect(directory.resolveSelection(FREEBUFF_MIMO_V25_MODEL_ID)).toBe('m-mimo')
    expect(directory.resolveSelection('m-gone')).toBe('m-only-here')
    expect(directory.get('m-flash').displayName).toBe('Flash')
    expect(directory.efforts('m-flash')).toEqual(['low', 'high', 'max'])
  })
})

describe('isFreebuffCatalogStaleError', () => {
  test('finds the code wherever a layer put it', () => {
    expect(isFreebuffCatalogStaleError({ error: 'freebuff_catalog_stale' })).toBe(
      true,
    )
    expect(
      isFreebuffCatalogStaleError(
        new Error('409 Conflict: {"error":"freebuff_catalog_stale"}'),
      ),
    ).toBe(true)
    expect(
      isFreebuffCatalogStaleError({
        type: 'error',
        message: 'Request failed',
        responseBody: '{"error":"freebuff_catalog_stale"}',
      }),
    ).toBe(true)
    expect(isFreebuffCatalogStaleError(new Error('session_expired'))).toBe(false)
    expect(isFreebuffCatalogStaleError(undefined)).toBe(false)
  })
})

describe('runWithFreebuffCatalogStaleRetry', () => {
  const stale = { type: 'error', message: '{"error":"freebuff_catalog_stale"}' }

  test('outside catalog mode it runs exactly once, whatever the answer', async () => {
    const attempts: number[] = []
    const result = await runWithFreebuffCatalogStaleRetry({
      run: async (attempt) => {
        attempts.push(attempt)
        return { output: stale }
      },
      canRetry: () => true,
      refreshAfterStale: async () => true,
    })
    expect(attempts).toEqual([0])
    expect(result.output).toBe(stale)
  })

  test('refetches and retries once with a rebuilt agent on a stale output', async () => {
    setFreebuffCatalog(CATALOG)
    const attempts: number[] = []
    let refreshes = 0
    const result = await runWithFreebuffCatalogStaleRetry({
      run: async (attempt) => {
        attempts.push(attempt)
        return attempt === 0 ? { output: stale } : { output: { type: 'lastMessage' } }
      },
      canRetry: () => true,
      refreshAfterStale: async () => {
        refreshes++
        return true
      },
    })
    expect(attempts).toEqual([0, 1])
    expect(refreshes).toBe(1)
    expect(result.output).toEqual({ type: 'lastMessage' })
  })

  test('retries a thrown stale error, and surfaces a second one', async () => {
    setFreebuffCatalog(CATALOG)
    const attempts: number[] = []
    await expect(
      runWithFreebuffCatalogStaleRetry({
        run: async (attempt) => {
          attempts.push(attempt)
          throw Object.assign(new Error('Conflict'), {
            error: 'freebuff_catalog_stale',
          })
        },
        canRetry: () => true,
        refreshAfterStale: async () => true,
      }),
    ).rejects.toThrow('Conflict')
    expect(attempts).toEqual([0, 1])
  })

  test('never retries a turn that already streamed, or when the refetch failed', async () => {
    setFreebuffCatalog(CATALOG)
    const attempts: number[] = []
    await runWithFreebuffCatalogStaleRetry({
      run: async (attempt) => {
        attempts.push(attempt)
        return { output: stale }
      },
      canRetry: () => false,
      refreshAfterStale: async () => true,
    })
    await runWithFreebuffCatalogStaleRetry({
      run: async (attempt) => {
        attempts.push(attempt)
        return { output: stale }
      },
      canRetry: () => true,
      refreshAfterStale: async () => false,
    })
    expect(attempts).toEqual([0, 0])
  })

  test('other errors pass straight through', async () => {
    setFreebuffCatalog(CATALOG)
    let refreshes = 0
    const result = await runWithFreebuffCatalogStaleRetry({
      run: async () => ({ output: { type: 'error', message: 'session_expired' } }),
      canRetry: () => true,
      refreshAfterStale: async () => {
        refreshes++
        return true
      },
    })
    expect(result.output.message).toBe('session_expired')
    expect(refreshes).toBe(0)
  })
})
