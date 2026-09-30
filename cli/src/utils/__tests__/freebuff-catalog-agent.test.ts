import {
  FREEBUFF_CLI_CATALOG_ROOT_AGENT_ID,
  FREEBUFF_ROOT_AGENT_IDS,
} from '@codebuff/common/constants/free-agents'
import { FREEBUFF_MIMO_V25_MODEL_ID } from '@codebuff/common/constants/freebuff-models'
import { afterEach, describe, expect, test } from 'bun:test'

import { bundledAgents } from '../../agents/bundled-agents.generated'
import { setFreebuffCatalog } from '../../state/freebuff-catalog-store'
import { useFreebuffModelStore } from '../../state/freebuff-model-store'
import { IS_FREEBUFF } from '../constants'
import {
  getFreebuffCliAgentIdForModel,
  getFreebuffCliAgentIdForSelection,
} from '../freebuff-agent-selection'
import { freebuffCatalogRootAgent } from '../freebuff-catalog-agent'
import { loadAgentDefinitions } from '../local-agent-registry'
import { catalogFixture, catalogRow, rotateHandles } from './freebuff-catalog-fixtures'

afterEach(() => {
  setFreebuffCatalog(null)
  useFreebuffModelStore.getState().setSelectedModel(FREEBUFF_MIMO_V25_MODEL_ID)
})

const ROW = catalogRow('m-flash', {
  handle: 'fbm1.opaque-handle-for-flash',
  displayName: 'DeepSeek V4.1 Flash',
  compaction: {
    cacheExpiryMs: 15 * 60_000,
    cacheExpiryMinTokens: 40_000,
    maxContextLength: 900_000,
  },
})

describe('freebuffCatalogRootAgent', () => {
  const agent = freebuffCatalogRootAgent(ROW)

  test('is the one registered catalog root, run on the row handle', () => {
    expect(agent.id).toBe(FREEBUFF_CLI_CATALOG_ROOT_AGENT_ID)
    expect(FREEBUFF_ROOT_AGENT_IDS as readonly string[]).toContain(agent.id)
    expect(agent.model).toBe('fbm1.opaque-handle-for-flash')
  })

  test('tells the model its display name, never the handle', () => {
    expect(agent.systemPrompt).toContain(
      'You are running on the DeepSeek V4.1 Flash model.',
    )
    expect(agent.systemPrompt).not.toContain('fbm1.')
    expect(agent.displayName).toBe('Buffy on DeepSeek V4.1 Flash')
  })

  test('carries the row compaction policy, budget included, unchanged', () => {
    expect(agent.compactContext).toEqual(ROW.compaction)
  })

  test('opens exactly like a bundled base3 root (the free-mode gate reads byte 0)', () => {
    const bundled = bundledAgents['base3-free-mimo'] as { systemPrompt?: string }
    const opening = (bundled.systemPrompt ?? '').slice(0, 400)
    expect(opening.length).toBe(400)
    expect((agent.systemPrompt ?? '').slice(0, 400)).toBe(opening)
    expect(agent.toolNames).toEqual(
      (bundledAgents['base3-free-mimo'] as { toolNames?: string[] }).toolNames,
    )
  })
})

describe('agent id for a selection', () => {
  test('a catalog key runs the catalog root; a compiled id keeps its own', () => {
    setFreebuffCatalog(catalogFixture([ROW]))
    expect(getFreebuffCliAgentIdForSelection('m-flash')).toBe(
      FREEBUFF_CLI_CATALOG_ROOT_AGENT_ID,
    )
    expect(getFreebuffCliAgentIdForSelection(FREEBUFF_MIMO_V25_MODEL_ID)).toBe(
      getFreebuffCliAgentIdForModel(FREEBUFF_MIMO_V25_MODEL_ID),
    )
  })

  test('fallback mode is the compiled root, exactly', () => {
    expect(getFreebuffCliAgentIdForSelection(FREEBUFF_MIMO_V25_MODEL_ID)).toBe(
      getFreebuffCliAgentIdForModel(FREEBUFF_MIMO_V25_MODEL_ID),
    )
  })
})

// The registry only builds the root in a Freebuff build.
// Run with: FREEBUFF_MODE=true bun test src/utils/__tests__/freebuff-catalog-agent.test.ts
describe.skipIf(!IS_FREEBUFF)('the runtime catalog root in the definitions', () => {
  const catalogRootIn = () =>
    loadAgentDefinitions().filter(
      (definition) => definition.id === FREEBUFF_CLI_CATALOG_ROOT_AGENT_ID,
    )

  test('is present only while a catalog row is selected', () => {
    expect(catalogRootIn()).toEqual([])
    const catalog = catalogFixture([ROW])
    setFreebuffCatalog(catalog)
    useFreebuffModelStore.getState().setSelectedModel('m-flash')
    expect(catalogRootIn().map((d) => d.model)).toEqual([
      'fbm1.opaque-handle-for-flash',
    ])
  })

  test('is rebuilt with the new handle after a refetch', () => {
    const catalog = catalogFixture([ROW])
    setFreebuffCatalog(catalog)
    useFreebuffModelStore.getState().setSelectedModel('m-flash')
    setFreebuffCatalog(rotateHandles(catalog, 7))
    expect(catalogRootIn().map((d) => d.model)).toEqual(['fbm1.m-flash-h7'])
  })
})
