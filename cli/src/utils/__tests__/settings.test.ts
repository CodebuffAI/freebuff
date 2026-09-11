import fs from 'fs'
import os from 'os'
import path from 'path'

import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import {
  DEFAULT_FREEBUFF_MODEL_ID,
  FALLBACK_FREEBUFF_MODEL_ID,
  FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID,
  FREEBUFF_GLM_V52_MODEL_ID,
  FREEBUFF_MIMO_V25_MODEL_ID,
  FREEBUFF_DEEPSEEK_V4_PRO_MODEL_ID,
  FREEBUFF_GLM_V53_FLASH_MODEL_ID,
  PREVIOUS_DEFAULT_FREEBUFF_MODEL_ID,
} from '@codebuff/common/constants/freebuff-models'

import * as auth from '../auth'
import {
  getSettingsPath,
  hasSeenFreebucksIntro,
  loadSettings,
  markFreebucksIntroSeen,
  loadFreebuffModelPreference,
  saveSettings,
  saveFreebuffModelPreference,
} from '../settings'

let testConfigDir: string | undefined
let getConfigDirSpy: ReturnType<typeof spyOn> | undefined

afterEach(() => {
  getConfigDirSpy?.mockRestore()
  getConfigDirSpy = undefined
  if (testConfigDir) {
    fs.rmSync(testConfigDir, { recursive: true, force: true })
    testConfigDir = undefined
  }
})

describe('BYOK connection selection', () => {
  test('persists only an opaque connection id and revision', () => {
    testConfigDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'freebuff-settings-test-'),
    )
    getConfigDirSpy = spyOn(auth, 'getConfigDir').mockReturnValue(testConfigDir)

    saveSettings({ byokConnection: { id: 'connection-id', revision: 3 } })

    expect(loadSettings().byokConnection).toEqual({
      id: 'connection-id',
      revision: 3,
    })
    expect(fs.readFileSync(getSettingsPath(), 'utf8')).not.toContain('apiKey')
  })

  test('drops malformed or stale selection shapes', () => {
    testConfigDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'freebuff-settings-test-'),
    )
    getConfigDirSpy = spyOn(auth, 'getConfigDir').mockReturnValue(testConfigDir)
    fs.writeFileSync(
      getSettingsPath(),
      JSON.stringify({ byokConnection: { id: 'connection-id', revision: 0 } }),
    )

    expect(loadSettings().byokConnection).toBeUndefined()
  })
})

describe('freebuff model preference', () => {
  test('referral-only GLM does not replace the remembered picker model', () => {
    testConfigDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'freebuff-settings-test-'),
    )
    getConfigDirSpy = spyOn(auth, 'getConfigDir').mockReturnValue(testConfigDir)

    saveFreebuffModelPreference(FALLBACK_FREEBUFF_MODEL_ID)
    saveFreebuffModelPreference(FREEBUFF_GLM_V52_MODEL_ID)

    expect(loadFreebuffModelPreference()).toBe(FALLBACK_FREEBUFF_MODEL_ID)
  })

  test('keeps a saved pick exactly as chosen, for every catalog row', () => {
    testConfigDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'freebuff-settings-test-'),
    )
    getConfigDirSpy = spyOn(auth, 'getConfigDir').mockReturnValue(testConfigDir)

    // Written directly, with no migration marker, exactly like a real
    // pre-upgrade settings file. GLM was the default until 2026-09-02, so this
    // first load is the one-time move onto the current default; from here on
    // the file is stamped and every pick below is the user's.
    fs.writeFileSync(
      path.join(testConfigDir, 'settings.json'),
      JSON.stringify({ freebuffModel: FREEBUFF_GLM_V53_FLASH_MODEL_ID }),
    )
    expect(loadFreebuffModelPreference()).toBe(DEFAULT_FREEBUFF_MODEL_ID)

    // And a round-trip through save/load leaves every selectable row alone. The
    // property is "the picker is the user's decision, not ours" — asserted
    // across the catalog rather than on one row, because the failure mode is a
    // notice added for ONE model quietly acquiring this behaviour.
    for (const id of [
      FREEBUFF_GLM_V53_FLASH_MODEL_ID,
      FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID,
      FREEBUFF_MIMO_V25_MODEL_ID,
    ]) {
      saveFreebuffModelPreference(id)
      expect(loadFreebuffModelPreference()).toBe(id)
    }
  })

  test('a withdrawn pick is DROPPED, not carried or rewritten', () => {
    testConfigDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'freebuff-settings-test-'),
    )
    getConfigDirSpy = spyOn(auth, 'getConfigDir').mockReturnValue(testConfigDir)

    // DeepSeek V4 Pro was withdrawn from free mode on 2026-08-26. A saved
    // preference is the longest-lived way to hold a dead id: it survives every
    // deploy and outlives the release that dropped the row, so this is the
    // client half of the withdrawal.
    //
    // Written directly, because that is the only way it can arrive — an updated
    // client cannot SAVE the id, and the file predates the update.
    fs.writeFileSync(
      path.join(testConfigDir, 'settings.json'),
      JSON.stringify({ freebuffModel: FREEBUFF_DEEPSEEK_V4_PRO_MODEL_ID }),
    )
    // Undefined, not a substitute. The catalog validation drops it and the
    // landing screen falls to its own default — which is a decision that
    // belongs there, not to a rewrite here. A migration would silently move the
    // user onto a specific model on every launch, which is exactly what the
    // supersedes machinery was removed for.
    expect(loadFreebuffModelPreference()).toBeUndefined()

    // And the updated client refuses to write it back, so the drop is durable
    // rather than re-inflicted from the picker.
    saveFreebuffModelPreference(FREEBUFF_DEEPSEEK_V4_PRO_MODEL_ID)
    expect(loadFreebuffModelPreference()).toBeUndefined()
  })
})

describe('one-time default migration', () => {
  // The choreography is tested in common (migrateSavedDefaultModel); this is
  // the wiring onto the settings file.
  const useTempConfigDir = () => {
    testConfigDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'freebuff-settings-test-'),
    )
    getConfigDirSpy = spyOn(auth, 'getConfigDir').mockReturnValue(testConfigDir)
  }

  test('a saved previous default moves; any other pick survives', () => {
    useTempConfigDir()
    fs.writeFileSync(
      getSettingsPath(),
      JSON.stringify({ freebuffModel: PREVIOUS_DEFAULT_FREEBUFF_MODEL_ID }),
    )
    expect(loadFreebuffModelPreference()).toBe(DEFAULT_FREEBUFF_MODEL_ID)
    saveFreebuffModelPreference(FREEBUFF_MIMO_V25_MODEL_ID)
    expect(loadFreebuffModelPreference()).toBe(FREEBUFF_MIMO_V25_MODEL_ID)
  })

  test('an empty file is stamped on first read, so a later pick of the old default sticks', () => {
    useTempConfigDir()
    expect(loadFreebuffModelPreference()).toBeUndefined()
    saveFreebuffModelPreference(PREVIOUS_DEFAULT_FREEBUFF_MODEL_ID)
    expect(loadFreebuffModelPreference()).toBe(
      PREVIOUS_DEFAULT_FREEBUFF_MODEL_ID,
    )
  })
})

describe('the one-time Freebucks introduction mark', () => {
  // The loader is an allowlist, so a key it does not copy is dropped on every
  // load and rewritten on the next save — which showed the intro on every
  // launch until this was pinned.
  test('survives a round trip through the settings file', () => {
    testConfigDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'freebuff-settings-test-'),
    )
    getConfigDirSpy = spyOn(auth, 'getConfigDir').mockReturnValue(testConfigDir)

    expect(hasSeenFreebucksIntro()).toBe(false)
    markFreebucksIntroSeen()
    expect(hasSeenFreebucksIntro()).toBe(true)
    const raw = JSON.parse(
      fs.readFileSync(path.join(testConfigDir, 'settings.json'), 'utf8'),
    ) as { freebucksIntroSeenAt?: string }
    expect(typeof raw.freebucksIntroSeenAt).toBe('string')
  })
})
