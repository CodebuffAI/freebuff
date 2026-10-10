import { describe, expect, test } from 'bun:test'
import {
  FREEBUFF_DEEPSEEK_V4_FLASH_FAST_MODEL_ID as fast,
  FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID as flash,
  FREEBUFF_GPT_6_LUNA_MODEL_ID as luna,
  FREEBUFF_MIMO_V25_MODEL_ID as mimo,
  FREEBUFF_MUSE_SPARK_13_CONTRIBUTOR_MODEL_ID as muse,
} from '../../constants/freebuff-models'
import {
  getFreebuffModelPresets,
  matchingFreebuffModelPreset,
} from '../freebuff-model-presets'

const choices = (input: Parameters<typeof getFreebuffModelPresets>[0] = {}) =>
  getFreebuffModelPresets(input)
const ids = (input: Parameters<typeof getFreebuffModelPresets>[0] = {}) =>
  choices(input).map((preset) => preset.modelId)

describe('model picker presets', () => {
  test('every premium-access account gets MiMo, Flash at high and Muse Spark, whatever its country', () => {
    // Signed-out preview, full access, and a full-access account of any country
    // all read the same three stops. Fast is not on the slider.
    expect(ids()).toEqual([mimo, flash, muse])
    expect(ids({ accessTier: 'full' })).toEqual([mimo, flash, muse])
    expect(ids({ accessTier: 'full', balance: 100 })).toEqual([
      mimo,
      flash,
      muse,
    ])
    expect(ids({ accessTier: 'full', isSubscriber: true })).toEqual([
      mimo,
      flash,
      muse,
    ])
    expect(choices().map((preset) => preset.reasoningEffort)).toEqual([
      null,
      'high',
      'high',
    ])
    expect(choices().map((preset) => preset.id)).toEqual([
      'efficient',
      'balanced',
      'powerful',
    ])
  })

  test('limited subscribers and limited accounts with at least 100 Freebucks get the same three', () => {
    expect(ids({ accessTier: 'limited', isSubscriber: true })).toEqual([
      mimo,
      flash,
      muse,
    ])
    expect(ids({ accessTier: 'limited', balance: 100 })).toEqual([
      mimo,
      flash,
      muse,
    ])
    expect(ids({ accessTier: 'limited', balance: 99 })).not.toContain(muse)
  })

  test('limited access selects only explicitly free and available promotions, retaining opaque keys', () => {
    const models = [
      { id: 'm-glyph', displayName: 'Glyph Cluster', price: 0 },
      { id: 'm-mini', displayName: 'Solar Mini 4', price: 0 },
      { id: 'm-pro', displayName: 'Solar Pro 4', price: 0 },
    ]
    expect(ids({ accessTier: 'limited', models })).toEqual([
      'm-glyph',
      mimo,
      flash,
    ])
    expect(
      ids({
        accessTier: 'limited',
        models: [{ ...models[0]!, available: false }, ...models.slice(1)],
      })[0],
    ).toBe('m-mini')
    expect(
      ids({
        accessTier: 'limited',
        models: models.map((row, i) => ({ ...row, price: i === 2 ? 0 : 5 })),
      })[0],
    ).toBe('m-pro')
    expect(
      ids({
        accessTier: 'limited',
        models: models.map((row) => ({ ...row, price: undefined })),
      })[0],
    ).toBe(mimo)
    expect(
      choices({
        accessTier: 'limited',
        models: [
          { ...models[0]!, efforts: ['low', 'high'], defaultEffort: 'high' },
        ],
      })[0]?.reasoningEffort,
    ).toBe('high')
  })

  test('uses catalog keys for compiled models, and falls back to Flash when Muse Spark is withdrawn', () => {
    const models = [
      { id: 'm-mimo', compiledId: mimo, displayName: 'MiMo' },
      { id: 'm-flash', compiledId: flash, displayName: 'DeepSeek Flash' },
      { id: 'm-muse', compiledId: muse, displayName: 'Muse Spark 1.3' },
    ]
    expect(ids({ models })).toEqual(['m-mimo', 'm-flash', 'm-muse'])
    const withdrawn = models.slice(0, 2)
    expect(ids({ models: withdrawn })).toEqual(['m-mimo', 'm-flash', 'm-flash'])
    expect(
      choices({ models: withdrawn }).map((preset) => preset.reasoningEffort),
    ).toEqual([null, 'high', 'high'])
  })

  test('custom models and effort overrides keep their detailed trigger labels', () => {
    const presets = choices()
    expect(matchingFreebuffModelPreset(presets, flash, 'high')?.id).toBe(
      'balanced',
    )
    expect(matchingFreebuffModelPreset(presets, flash, 'low')).toBeUndefined()
    // Fast and Luna are no longer slider stops: they read as custom picks.
    expect(matchingFreebuffModelPreset(presets, fast, 'high')).toBeUndefined()
    expect(matchingFreebuffModelPreset(presets, luna, 'xhigh')).toBeUndefined()
    expect(matchingFreebuffModelPreset(presets, muse, 'high')?.id).toBe(
      'powerful',
    )
    expect(matchingFreebuffModelPreset(presets, muse, 'low')).toBeUndefined()
    expect(
      matchingFreebuffModelPreset(presets, 'byok/provider', null),
    ).toBeUndefined()
    expect(
      matchingFreebuffModelPreset(
        choices({ accessTier: 'limited' }),
        mimo,
        null,
      )?.id,
    ).toBe('balanced')
  })
})
