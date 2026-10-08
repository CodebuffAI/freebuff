import { describe, expect, test } from 'bun:test'
import {
  FREEBUFF_DEEPSEEK_V4_FLASH_FAST_MODEL_ID as fast,
  FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID as flash,
  FREEBUFF_GPT_6_LUNA_MODEL_ID as luna,
  FREEBUFF_MIMO_V25_MODEL_ID as mimo,
} from '../../constants/freebuff-models'
import {
  getFreebuffModelPresets,
  matchingFreebuffModelPreset,
} from '../freebuff-model-presets'

const offPeak = Date.parse('2026-10-08T18:00:00Z')
const peak = Date.parse('2026-10-08T05:00:00Z')
const choices = (input: Parameters<typeof getFreebuffModelPresets>[0] = {}) =>
  getFreebuffModelPresets({ now: offPeak, ...input })
const ids = (input: Parameters<typeof getFreebuffModelPresets>[0] = {}) =>
  choices(input).map((preset) => preset.modelId)

describe('model picker presets', () => {
  test('signed-out preview and US full access use Fast only off peak', () => {
    expect(ids()).toEqual([mimo, fast, luna])
    expect(ids({ accessTier: 'full', countryCode: 'US' })).toEqual([
      mimo,
      fast,
      luna,
    ])
    expect(ids({ accessTier: 'full', countryCode: 'US', now: peak })).toEqual([
      mimo,
      flash,
      luna,
    ])
    expect(choices().map((preset) => preset.reasoningEffort)).toEqual([
      null,
      'high',
      'xhigh',
    ])
  })

  test('subscription and available balance split non-US full-access accounts', () => {
    expect(ids({ accessTier: 'full', countryCode: 'FR', balance: 99 })).toEqual(
      [mimo, flash, luna],
    )
    expect(
      ids({ accessTier: 'full', countryCode: 'FR', balance: 100 }),
    ).toEqual([mimo, fast, luna])
    expect(
      ids({ accessTier: 'full', countryCode: 'FR', isSubscriber: true }),
    ).toEqual([mimo, fast, luna])
    expect(ids({ accessTier: 'full' })).toEqual([mimo, flash, luna])
  })

  test('limited subscribers use Flash unless they have at least 100 Freebucks', () => {
    expect(
      ids({ accessTier: 'limited', isSubscriber: true, balance: 99 }),
    ).toEqual([mimo, flash, luna])
    expect(
      ids({ accessTier: 'limited', isSubscriber: true, balance: 100 }),
    ).toEqual([mimo, fast, luna])
    expect(ids({ accessTier: 'limited', balance: 100 })).toEqual([
      mimo,
      fast,
      luna,
    ])
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

  test('uses catalog keys for compiled models and their server-owned off-peak schedule', () => {
    const models = [
      { id: 'm-fast', compiledId: fast, displayName: 'DeepSeek Flash Fast' },
      { id: 'm-luna', compiledId: luna, displayName: 'GPT-6 Luna' },
    ]
    const pricing = {
      prices: { 'm-fast': 50 },
      offPeak: {
        'm-fast': {
          startHourUtc: 12,
          endHourUtc: 20,
          price: 25,
          regularPrice: 50,
        },
      },
    }
    expect(ids({ models, pricing })).toEqual([mimo, 'm-fast', 'm-luna'])
    expect(
      ids({ models, pricing, now: Date.parse('2026-10-08T10:00:00Z') })[1],
    ).toBe(flash)
  })

  test('off-peak boundaries follow the admission window, including weekends', () => {
    expect(ids({ now: Date.parse('2026-10-08T09:59:59Z') })[1]).toBe(flash)
    expect(ids({ now: Date.parse('2026-10-08T10:00:00Z') })[1]).toBe(fast)
    expect(ids({ now: Date.parse('2026-10-10T05:00:00Z') })[1]).toBe(fast)
  })

  test('custom models and effort overrides keep their detailed trigger labels', () => {
    const presets = choices()
    expect(matchingFreebuffModelPreset(presets, fast, 'high')?.id).toBe(
      'balanced',
    )
    expect(matchingFreebuffModelPreset(presets, fast, 'low')).toBeUndefined()
    expect(matchingFreebuffModelPreset(presets, luna, 'high')).toBeUndefined()
    expect(matchingFreebuffModelPreset(presets, luna, 'xhigh')?.id).toBe(
      'powerful',
    )
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
