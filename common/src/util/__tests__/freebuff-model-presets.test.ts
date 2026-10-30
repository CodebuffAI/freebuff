import { describe, expect, test } from 'bun:test'
import {
  FREEBUFF_DEEPSEEK_V4_FLASH_FAST_MODEL_ID as fast,
  FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID as flash,
  FREEBUFF_GPT_6_LUNA_MODEL_ID as luna,
  FREEBUFF_MIMO_V25_MODEL_ID as mimo,
  FREEBUFF_MUSE_SPARK_13_CONTRIBUTOR_MODEL_ID as muse,
} from '../../constants/freebuff-models'
import {
  FREEBUFF_MIMO_SLOW_CATALOG_KEY as slowKey,
  getFreebuffModelPresets,
  matchingFreebuffModelPreset,
} from '../freebuff-model-presets'

const choices = (input: Parameters<typeof getFreebuffModelPresets>[0] = {}) =>
  getFreebuffModelPresets(input)
const ids = (input: Parameters<typeof getFreebuffModelPresets>[0] = {}) =>
  choices(input).map((preset) => preset.modelId)

describe('model picker presets', () => {
  test('full access gets Flash low, high and max, labelled Fast, Balanced and Powerful', () => {
    // Signed-out preview and a full-access account of any country, plan or
    // balance all read the same three stops.
    for (const input of [
      {},
      { accessTier: 'full' as const },
      { accessTier: 'full' as const, balance: 100 },
      { accessTier: 'full' as const, isSubscriber: true },
    ])
      expect(ids(input)).toEqual([flash, flash, flash])
    expect(choices().map((preset) => preset.reasoningEffort)).toEqual([
      'low',
      'high',
      'max',
    ])
    expect(choices().map((preset) => preset.label)).toEqual([
      'Fast',
      'Balanced',
      'Powerful',
    ])
    expect(choices().map((preset) => preset.id)).toEqual([
      'efficient',
      'balanced',
      'powerful',
    ])
  })

  test('limited subscribers and limited accounts with at least 100 Freebucks get MiMo, Flash at high and Muse Spark', () => {
    expect(ids({ accessTier: 'limited', isSubscriber: true })).toEqual([
      mimo,
      flash,
      muse,
    ])
    expect(
      choices({ accessTier: 'limited', isSubscriber: true }).map(
        (preset) => [preset.label, preset.reasoningEffort],
      ),
    ).toEqual([
      ['Efficient', null],
      ['Balanced', 'high'],
      ['Powerful', 'high'],
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
          models[1]!,
        ],
      })[0]?.reasoningEffort,
    ).toBe('high')
  })

  test('the limited premium ladder leads with MiMo v2.6 Flash Slow where it is listed and open', () => {
    const slow = { id: slowKey, displayName: 'MiMo v2.6 Flash Slow' }
    const input = { accessTier: 'limited' as const, isSubscriber: true }
    expect(ids({ ...input, models: [slow] })).toEqual([slowKey, flash, muse])
    expect(choices({ ...input, models: [slow] })[0]?.reasoningEffort).toBeNull()
    // Locked or unlisted (Web, a withdrawn row): MiMo, as before.
    expect(ids({ ...input, models: [{ ...slow, available: false }] })[0]).toBe(
      mimo,
    )
    expect(ids({ ...input, models: [] })[0]).toBe(mimo)
    // Full access never reads it.
    expect(ids({ accessTier: 'full', models: [slow] })[0]).not.toBe(slowKey)
  })

  test('a planless limited account builds its ladder on the server’s recommendation (MiMo v2.6 Flash Slow)', () => {
    const slow = { id: 'm-slow', displayName: 'MiMo v2.6 Flash Slow' }
    const glyph = { id: 'm-glyph', displayName: 'Glyph Cluster', price: 0 }
    // No free promotion: the recommendation fills both lower stops, and a new
    // chat (Balanced) starts on it.
    expect(
      ids({ accessTier: 'limited', models: [slow], recommendedModelId: 'm-slow' }),
    ).toEqual(['m-slow', 'm-slow', flash])
    expect(
      matchingFreebuffModelPreset(
        choices({ accessTier: 'limited', models: [slow], recommendedModelId: 'm-slow' }),
        'm-slow',
        null,
      )?.id,
    ).toBe('balanced')
    // A free promotion keeps Efficient.
    expect(
      ids({ accessTier: 'limited', models: [glyph, slow], recommendedModelId: 'm-slow' }),
    ).toEqual(['m-glyph', 'm-slow', flash])
    // Unlisted or unavailable: MiMo, as before.
    expect(
      ids({ accessTier: 'limited', models: [glyph], recommendedModelId: 'm-slow' }),
    ).toEqual(['m-glyph', mimo, flash])
    expect(
      ids({
        accessTier: 'limited',
        models: [{ ...slow, available: false }],
        recommendedModelId: 'm-slow',
      }),
    ).toEqual([mimo, mimo, flash])
    // With no rows to check against (the CLI), the server's pick is taken as is.
    expect(ids({ accessTier: 'limited', recommendedModelId: 'm-slow' })).toEqual([
      'm-slow',
      'm-slow',
      flash,
    ])
    // Premium ladders never read it.
    for (const input of [
      { accessTier: 'limited' as const, isSubscriber: true },
      { accessTier: 'limited' as const, balance: 100 },
    ])
      expect(ids({ ...input, recommendedModelId: 'm-slow' })).toEqual([mimo, flash, muse])
    expect(
      ids({ accessTier: 'full', recommendedModelId: 'm-slow' }),
    ).toEqual([flash, flash, flash])
  })

  test('uses catalog keys for compiled models, and falls back to Flash when a stop is withdrawn', () => {
    const models = [
      { id: 'm-mimo', compiledId: mimo, displayName: 'MiMo' },
      { id: 'm-flash', compiledId: flash, displayName: 'DeepSeek Flash' },
      { id: 'm-luna', compiledId: luna, displayName: 'GPT-6 Luna' },
      { id: 'm-muse', compiledId: muse, displayName: 'Muse Spark 1.3' },
    ]
    expect(ids({ models })).toEqual(['m-flash', 'm-flash', 'm-flash'])
    const limited = { accessTier: 'limited' as const, isSubscriber: true }
    expect(ids({ ...limited, models })).toEqual(['m-mimo', 'm-flash', 'm-muse'])
    const noMuse = models.filter((row) => row.compiledId !== muse)
    expect(ids({ ...limited, models: noMuse })).toEqual([
      'm-mimo',
      'm-flash',
      'm-flash',
    ])
  })

  test('a catalog listing one model gets its thinking levels, Balanced on its default', () => {
    const one = {
      id: 'm-flash',
      compiledId: flash,
      displayName: 'DeepSeek V4.1 Flash',
      efforts: ['low', 'high', 'max'] as const,
      defaultEffort: 'high' as const,
    }
    for (const input of [
      { accessTier: 'full' as const },
      { accessTier: 'full' as const, isSubscriber: true },
      { accessTier: 'limited' as const },
    ]) {
      const presets = choices({ ...input, models: [one] })
      expect(
        presets.map((preset) => [
          preset.id,
          preset.label,
          preset.modelId,
          preset.reasoningEffort,
          preset.thinkingLevel,
        ]),
      ).toEqual([
        ['efficient', 'Fast', 'm-flash', 'low', true],
        ['balanced', 'Default', 'm-flash', 'high', true],
        ['powerful', 'Max', 'm-flash', 'max', true],
      ])
    }
    const presets = choices({ models: [one] })
    expect(matchingFreebuffModelPreset(presets, 'm-flash', 'low')?.id).toBe(
      'efficient',
    )
    expect(matchingFreebuffModelPreset(presets, 'm-flash', null)).toBeUndefined()
    // Every other ladder: its ends and its default.
    expect(
      choices({
        models: [{ ...one, efforts: ['low', 'high'], defaultEffort: 'high' }],
      }).map((preset) => [preset.id, preset.reasoningEffort]),
    ).toEqual([
      ['efficient', 'low'],
      ['balanced', 'high'],
    ])
    // No ladder, or a second row: the usual stops.
    expect(
      choices({ models: [{ ...one, efforts: undefined }] }).some(
        (preset) => preset.thinkingLevel,
      ),
    ).toBe(false)
    expect(
      choices({
        models: [one, { id: 'm-luna', compiledId: luna, displayName: 'GPT-6 Luna' }],
      }).map((preset) => preset.label),
    ).toEqual(['Fast', 'Balanced', 'Powerful'])
  })

  test('custom models and effort overrides keep their detailed trigger labels', () => {
    const presets = choices()
    expect(matchingFreebuffModelPreset(presets, flash, 'low')?.id).toBe(
      'efficient',
    )
    expect(matchingFreebuffModelPreset(presets, flash, 'high')?.id).toBe(
      'balanced',
    )
    expect(matchingFreebuffModelPreset(presets, flash, 'max')?.id).toBe(
      'powerful',
    )
    // Any other effort on a stop's model is a custom pick.
    expect(matchingFreebuffModelPreset(presets, flash, 'xhigh')).toBeUndefined()
    expect(matchingFreebuffModelPreset(presets, luna, 'low')).toBeUndefined()
    // Flash's fast mode and Muse Spark are not full-access stops.
    expect(matchingFreebuffModelPreset(presets, fast, 'high')).toBeUndefined()
    expect(matchingFreebuffModelPreset(presets, muse, 'high')).toBeUndefined()
    expect(
      matchingFreebuffModelPreset(presets, 'byok/provider', null),
    ).toBeUndefined()
    expect(
      matchingFreebuffModelPreset(
        choices({ accessTier: 'limited', isSubscriber: true }),
        muse,
        'high',
      )?.id,
    ).toBe('powerful')
    expect(
      matchingFreebuffModelPreset(
        choices({ accessTier: 'limited' }),
        mimo,
        null,
      )?.id,
    ).toBe('balanced')
  })
})
