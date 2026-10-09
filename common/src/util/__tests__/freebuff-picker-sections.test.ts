import { describe, expect, test } from 'bun:test'

import {
  FREEBUFF_DEEPSEEK_V4_FLASH_FAST_MODEL_ID,
  FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID,
} from '../../constants/freebuff-model-ids'
import {
  FREEBUFF_GEMINI_38_FLASH_MODEL_ID,
  FREEBUFF_GLM_V53_FLASH_MODEL_ID,
  FREEBUFF_GPT_61_SOL_MODEL_ID,
  FREEBUFF_GPT_6_LUNA_MODEL_ID,
  FREEBUFF_MIMO_V25_MODEL_ID,
  FREEBUFF_MIMO_V26_PRO_MODEL_ID,
  FREEBUFF_MODELS,
  FREEBUFF_MUSE_SPARK_13_CONTRIBUTOR_MODEL_ID,
  FREEBUFF_SOLAR_MINI_4_MODEL_ID,
  FREEBUFF_SOLAR_PRO_4_MODEL_ID,
  FREEBUFF_SPACE_BUNNY_ALPHA_MODEL_ID,
} from '../../constants/freebuff-models'
import {
  FREEBUFF_PICKER_PLACED_IDS,
  FREEBUFF_PICKER_SECTIONS,
  freebuffPickerPlacement,
  freebuffPickerSections,
  freebuffRowPlacement,
} from '../freebuff-picker-sections'

const none = { premium: false, locked: false, price: undefined }

describe('freebuffPickerPlacement', () => {
  test('literal ids are the catalog constants', () => {
    const at = (id: string) => freebuffPickerPlacement([id], none)
    expect(at(FREEBUFF_SOLAR_PRO_4_MODEL_ID)).toEqual({ section: 'unlimited', order: expect.any(Number) })
    expect(at(FREEBUFF_SOLAR_MINI_4_MODEL_ID).section).toBe('unlimited')
    expect(at(FREEBUFF_MIMO_V25_MODEL_ID)).toMatchObject({ section: 'optimized', recommended: true })
    expect(at(FREEBUFF_GLM_V53_FLASH_MODEL_ID).section).toBe('optimized')
    expect(at(FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID).section).toBe('optimized')
    for (const id of [
      FREEBUFF_MUSE_SPARK_13_CONTRIBUTOR_MODEL_ID,
      FREEBUFF_GPT_6_LUNA_MODEL_ID,
      FREEBUFF_MIMO_V26_PRO_MODEL_ID,
      FREEBUFF_GPT_61_SOL_MODEL_ID,
    ]) {
      expect(at(id)).toEqual({ section: 'powerful', order: expect.any(Number) })
    }
    expect(at(FREEBUFF_GEMINI_38_FLASH_MODEL_ID)).toMatchObject({ section: 'powerful', more: true })
    // Not badged Recommended since 2026-10-07: Optimized's MiMo is the one pick.
    expect(at(FREEBUFF_DEEPSEEK_V4_FLASH_FAST_MODEL_ID)).toEqual({ section: 'powerful', order: 5 })
  })

  test('every listed compiled model has an explicit place', () => {
    const placed = new Set(FREEBUFF_PICKER_PLACED_IDS)
    expect(FREEBUFF_MODELS.map((m) => m.id).filter((id) => !placed.has(id))).toEqual([])
  })

  test('the first placed name wins', () => {
    expect(
      freebuffPickerPlacement(['m-unknown', FREEBUFF_GPT_6_LUNA_MODEL_ID], none).section,
    ).toBe('powerful')
  })

  test('an unplaced row is inferred and tucked under More', () => {
    expect(freebuffPickerPlacement(['x'], { ...none, premium: true })).toMatchObject({ section: 'powerful', more: true })
    expect(freebuffPickerPlacement(['x'], { ...none, locked: true }).section).toBe('powerful')
    expect(freebuffPickerPlacement(['x'], { ...none, price: 0 })).toMatchObject({ section: 'unlimited', more: true })
    expect(freebuffPickerPlacement(['x'], { ...none, price: 10 }).section).toBe('optimized')
  })
})

describe('freebuffPickerSections', () => {
  test('groups in section order by placement order, More rows last, empty sections dropped', () => {
    const rows = [
      FREEBUFF_GEMINI_38_FLASH_MODEL_ID,
      'unplaced-cheap',
      FREEBUFF_GPT_6_LUNA_MODEL_ID,
      FREEBUFF_DEEPSEEK_V4_FLASH_FAST_MODEL_ID,
      FREEBUFF_GLM_V53_FLASH_MODEL_ID,
      FREEBUFF_MIMO_V25_MODEL_ID,
    ]
    const sections = freebuffPickerSections(rows, (id) =>
      freebuffPickerPlacement([id], { ...none, price: 10 }),
    )
    expect(sections.map(({ section, models }) => [section.id, models])).toEqual([
      [
        'optimized',
        [FREEBUFF_MIMO_V25_MODEL_ID, FREEBUFF_GLM_V53_FLASH_MODEL_ID, 'unplaced-cheap'],
      ],
      [
        'powerful',
        [
          FREEBUFF_DEEPSEEK_V4_FLASH_FAST_MODEL_ID,
          FREEBUFF_GPT_6_LUNA_MODEL_ID,
          FREEBUFF_GEMINI_38_FLASH_MODEL_ID,
        ],
      ],
    ])
  })
})

describe('freebuffRowPlacement', () => {
  test('the server’s place wins for a section the picker draws', () => {
    expect(
      freebuffRowPlacement(
        { section: 'powerful', order: 0, recommended: true },
        FREEBUFF_PICKER_SECTIONS,
        [FREEBUFF_MIMO_V25_MODEL_ID],
        none,
      ),
    ).toEqual({ section: 'powerful', order: 0, recommended: true })
  })

  test('no server place, or a section the picker does not have: the compiled place', () => {
    const compiled = freebuffPickerPlacement([FREEBUFF_MIMO_V25_MODEL_ID], none)
    expect(
      freebuffRowPlacement(undefined, FREEBUFF_PICKER_SECTIONS, [FREEBUFF_MIMO_V25_MODEL_ID], none),
    ).toEqual(compiled)
    expect(
      freebuffRowPlacement(
        { section: 'gone', order: 0 },
        FREEBUFF_PICKER_SECTIONS,
        [FREEBUFF_MIMO_V25_MODEL_ID],
        none,
      ),
    ).toEqual(compiled)
  })

  test('sections are drawn in the order the server sends them', () => {
    const sections = [
      { id: 'b', label: 'B', tooltip: '' },
      { id: 'a', label: 'A', tooltip: '' },
    ]
    const grouped = freebuffPickerSections(
      ['x', 'y'],
      (id) => ({ section: id === 'x' ? 'a' : 'b', order: 0 }),
      sections,
    )
    expect(grouped.map(({ section, models }) => [section.id, models])).toEqual([
      ['b', ['y']],
      ['a', ['x']],
    ])
  })
})
