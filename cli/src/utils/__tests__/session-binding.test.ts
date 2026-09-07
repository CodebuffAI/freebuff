import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import fs from 'fs'

import { getConfigDir } from '../auth'
import {
  persistSessionBinding,
  readSessionBinding,
  clearSessionBinding,
} from '../session-binding'

const getBindingPath = () =>
  require('path').join(getConfigDir(), 'session-binding.json')

describe('session-binding persistence', () => {
  const bindingPath = getBindingPath()

  beforeEach(() => {
    try {
      fs.mkdirSync(getConfigDir(), { recursive: true })
    } catch {
      // ignore
    }
    try {
      fs.unlinkSync(bindingPath)
    } catch {
      // ignore
    }
  })

  afterEach(() => {
    try {
      fs.unlinkSync(bindingPath)
    } catch {
      // ignore
    }
  })

  it('readSessionBinding returns null when no file exists', () => {
    expect(readSessionBinding()).toBeNull()
  })

  it('persistSessionBinding writes a JSON file with userId', () => {
    persistSessionBinding('user-abc')

    const raw = fs.readFileSync(bindingPath, 'utf8')
    const parsed = JSON.parse(raw)
    expect(parsed.userId).toBe('user-abc')
  })

  it('readSessionBinding reads back the persisted userId', () => {
    persistSessionBinding('user-abc')
    expect(readSessionBinding()).toBe('user-abc')
  })

  it('persistSessionBinding overwrites previous binding', () => {
    persistSessionBinding('user-abc')
    persistSessionBinding('user-xyz')

    expect(readSessionBinding()).toBe('user-xyz')
  })

  it('clearSessionBinding removes the file', () => {
    persistSessionBinding('user-abc')
    clearSessionBinding()

    expect(fs.existsSync(bindingPath)).toBe(false)
    expect(readSessionBinding()).toBeNull()
  })

  it('clearSessionBinding is idempotent', () => {
    persistSessionBinding('user-abc')
    clearSessionBinding()
    clearSessionBinding() // second call should not throw

    expect(readSessionBinding()).toBeNull()
  })

  it('readSessionBinding returns null for malformed JSON', () => {
    fs.writeFileSync(bindingPath, 'not-json')
    expect(readSessionBinding()).toBeNull()
  })

  it('readSessionBinding returns null when userId is missing', () => {
    fs.writeFileSync(bindingPath, JSON.stringify({ other: 'data' }))
    expect(readSessionBinding()).toBeNull()
  })
})
