import { describe, expect, test } from 'bun:test'

import {
  FREEBUFF_DEEPSEEK_V4_FLASH_FAST_MODEL_ID,
  FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID,
  FREEBUFF_MIMO_V25_MODEL_ID,
} from '../../constants/freebuff-models'
import {
  freebuffLegacyModelDigest,
  type FreebuffCatalogRow,
  type FreebuffModelCatalog,
} from '../../types/freebuff-model-catalog'
import { getFreebuffModelPresets } from '../freebuff-model-presets'
import {
  pickerFreebuffCatalog,
  showAllModelsSwitch,
} from '../freebuff-show-all-models'

const row = (
  key: string,
  modelId: string | undefined,
  over: Partial<FreebuffCatalogRow> = {},
): FreebuffCatalogRow => ({
  key,
  handle: `fbm1.${key}.h1`,
  displayName: key,
  tagline: 'A tagline',
  badges: [],
  multimodal: false,
  premium: false,
  dataUse: 'service',
  access: 'open',
  sortOrder: 10,
  ...(modelId ? { legacyDigests: [freebuffLegacyModelDigest(modelId)] } : {}),
  ...over,
})

const flash = row('m-flash0001', FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID, {
  displayName: 'DeepSeek V4.1 Flash 10/17',
  efforts: ['low', 'high', 'max'],
  defaultEffort: 'high',
})

const catalog = (rows: FreebuffCatalogRow[]): FreebuffModelCatalog => ({
  protocol: 1,
  version: 'v7.g1.e1.full.0',
  issuedAt: 1,
  refreshAt: 2,
  rows,
  recommendedKey: 'm-mimo00001',
  fallbackKey: 'm-mimo00001',
  plansUrl: 'https://freebuff.com/plans',
  sections: [{ id: 'unlimited', label: 'Unlimited', tooltip: 'Tip' }],
  fetchId: 'fetch-1',
})

/** `catalog` offering Show all models, switched off until the viewer flips it. */
const offeredOff = (catalog: FreebuffModelCatalog): FreebuffModelCatalog => ({
  ...catalog,
  showAllModels: { default: false },
})

describe('the catalog with Show all models off', () => {
  test('lists only DeepSeek V4.1 Flash, as the recommended and fallback row, under a new version', () => {
    const full = offeredOff(
      catalog([
        row('m-mimo00001', FREEBUFF_MIMO_V25_MODEL_ID),
        // fast mode is its own row and its own price: not the one model
        row('m-fast00001', FREEBUFF_DEEPSEEK_V4_FLASH_FAST_MODEL_ID),
        flash,
        row('m-catonly01', undefined),
      ]),
    )
    expect(pickerFreebuffCatalog(full, undefined)).toEqual({
      ...full,
      version: 'v7.g1.e1.full.0.one',
      rows: [flash],
      recommendedKey: flash.key,
      fallbackKey: flash.key,
    })
  })

  test('the row it keeps is drawn as its thinking levels', () => {
    const [only] = pickerFreebuffCatalog(
      offeredOff(
        catalog([row('m-mimo00001', FREEBUFF_MIMO_V25_MODEL_ID), flash]),
      ),
      undefined,
    ).rows
    expect(
      getFreebuffModelPresets({
        accessTier: 'full',
        models: [{ ...only!, id: only!.key }],
      }).map((preset) => [preset.label, preset.reasoningEffort]),
    ).toEqual([
      ['Fast', 'low'],
      ['Default', 'high'],
      ['Max', 'max'],
    ])
  })

  test('a catalog without an open Flash row is listed whole', () => {
    const withoutFlash = offeredOff(
      catalog([row('m-mimo00001', FREEBUFF_MIMO_V25_MODEL_ID)]),
    )
    expect(pickerFreebuffCatalog(withoutFlash, undefined)).toBe(withoutFlash)
    const lockedFlash = offeredOff(
      catalog([
        row('m-mimo00001', FREEBUFF_MIMO_V25_MODEL_ID),
        { ...flash, access: 'locked' },
      ]),
    )
    expect(pickerFreebuffCatalog(lockedFlash, undefined)).toBe(lockedFlash)
  })
})

describe('the Show all models switch', () => {
  const full = catalog([row('m-mimo00001', FREEBUFF_MIMO_V25_MODEL_ID), flash])

  test('a catalog that does not offer it has no switch and is listed whole, whatever was chosen', () => {
    for (const choice of [undefined, true, false]) {
      expect(showAllModelsSwitch(full, choice)).toBeUndefined()
      expect(pickerFreebuffCatalog(full, choice)).toBe(full)
    }
    expect(showAllModelsSwitch(null, false)).toBeUndefined()
  })

  test('the viewer’s choice wins; until they make one the catalog’s default does', () => {
    const offered = (on: boolean) => ({
      ...full,
      showAllModels: { default: on },
    })
    expect(showAllModelsSwitch(offered(true), undefined)).toBe(true)
    expect(showAllModelsSwitch(offered(false), undefined)).toBe(false)
    expect(showAllModelsSwitch(offered(false), true)).toBe(true)
    expect(showAllModelsSwitch(offered(true), false)).toBe(false)
    expect(pickerFreebuffCatalog(offered(true), undefined).rows).toHaveLength(2)
    expect(pickerFreebuffCatalog(offered(true), false).rows).toEqual([flash])
    expect(pickerFreebuffCatalog(offered(false), undefined).rows).toEqual([
      flash,
    ])
  })
})
