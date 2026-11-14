import { describe, expect, test } from 'bun:test'

import {
  FREEBUFF_MODEL_PICKER_RETIRED_SINCE,
  modelPickerRetiredForAccount,
} from '../freebuff-model-picker'

describe('modelPickerRetiredForAccount', () => {
  test('accounts from the cutoff on have no picker', () => {
    expect(modelPickerRetiredForAccount(FREEBUFF_MODEL_PICKER_RETIRED_SINCE)).toBe(true)
    expect(
      modelPickerRetiredForAccount(new Date(FREEBUFF_MODEL_PICKER_RETIRED_SINCE + 1).toISOString()),
    ).toBe(true)
  })

  test('older accounts, and an unknown or unreadable age, keep it', () => {
    expect(modelPickerRetiredForAccount(FREEBUFF_MODEL_PICKER_RETIRED_SINCE - 1)).toBe(false)
    expect(modelPickerRetiredForAccount('2026-11-01T00:00:00Z')).toBe(false)
    expect(modelPickerRetiredForAccount(null)).toBe(false)
    expect(modelPickerRetiredForAccount(undefined)).toBe(false)
    expect(modelPickerRetiredForAccount('not a date')).toBe(false)
  })
})
