import fs from 'fs'
import os from 'os'
import path from 'path'

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'

import { setProjectRoot } from '../../project-files'
import * as authModule from '../auth'
import {
  clearUserCredentials,
  getAuthToken,
  getUserCredentials,
  loadStoredAuthToken,
  moveTokenToKeychain,
  saveUserCredentials,
} from '../auth'
import { setSecretStoreForTests, type SecretStore } from '../auth-token-store'

import type { User } from '../auth'

const TEST_USER: User = {
  id: 'test-user-123',
  name: 'Test User',
  email: 'test@example.com',
  authToken: 'test-session-token-abc',
}

/** Let the move `saveUserCredentials` starts in the background finish. */
const settle = () => new Promise((r) => setTimeout(r, 10))

function memoryStore(opts: { failSet?: boolean; failGet?: boolean } = {}) {
  let value: string | null = null
  const store: SecretStore = {
    async get() {
      if (opts.failGet) throw new Error('keychain locked')
      return value
    },
    async set(v) {
      if (opts.failSet) throw new Error('no secret service')
      value = v
    },
    async delete() {
      value = null
    },
  }
  return { store, peek: () => value }
}

describe('Freebuff auth token in the OS keychain', () => {
  let tempRoot: string
  let credentialsPath: string

  const fileJson = () => JSON.parse(fs.readFileSync(credentialsPath, 'utf8'))

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuff-keychain-'))
    const configDir = path.join(tempRoot, 'config')
    credentialsPath = path.join(configDir, 'credentials.json')
    setProjectRoot(tempRoot)
    spyOn(authModule, 'getConfigDir').mockReturnValue(configDir)
    spyOn(authModule, 'getCredentialsPath').mockReturnValue(credentialsPath)
  })

  afterEach(() => {
    setSecretStoreForTests(undefined)
    fs.rmSync(tempRoot, { recursive: true, force: true })
  })

  test('login moves the token out of the file; the profile stays readable', async () => {
    const { store, peek } = memoryStore()
    setSecretStoreForTests(store)
    saveUserCredentials(TEST_USER)
    await settle()

    expect(peek()).toBe(TEST_USER.authToken)
    const file = fileJson()
    expect(file.default.authToken).toBeUndefined()
    expect(file.default.tokenStore).toBe('keychain')
    expect(file.default.email).toBe(TEST_USER.email)
    expect(fs.readFileSync(credentialsPath, 'utf8')).not.toContain(
      TEST_USER.authToken,
    )
    expect(getUserCredentials()?.authToken).toBe(TEST_USER.authToken)
  })

  test('a later launch loads the token from the keychain before anything reads it', async () => {
    const { store } = memoryStore()
    setSecretStoreForTests(store)
    saveUserCredentials(TEST_USER)
    await settle()

    // A fresh process: nothing cached yet.
    setSecretStoreForTests(store)
    expect(getAuthToken()).toBeUndefined()
    await loadStoredAuthToken()
    expect(getAuthToken()).toBe(TEST_USER.authToken)
  })

  test('an existing install is migrated at startup', async () => {
    setSecretStoreForTests(null)
    saveUserCredentials(TEST_USER)
    expect(fileJson().default.authToken).toBe(TEST_USER.authToken)

    const { store, peek } = memoryStore()
    setSecretStoreForTests(store)
    await loadStoredAuthToken()
    expect(peek()).toBe(TEST_USER.authToken)
    expect(fileJson().default.authToken).toBeUndefined()
    expect(getAuthToken()).toBe(TEST_USER.authToken)
  })

  test('no usable keychain: the token stays in the file and nobody is logged out', async () => {
    const { store } = memoryStore({ failSet: true })
    setSecretStoreForTests(store)
    saveUserCredentials(TEST_USER)
    await settle()
    expect(await moveTokenToKeychain()).toBe(false)
    expect(fileJson().default.authToken).toBe(TEST_USER.authToken)
    expect(getAuthToken()).toBe(TEST_USER.authToken)
  })

  test('a keychain that cannot be read reads as signed out, never throws', async () => {
    const good = memoryStore()
    setSecretStoreForTests(good.store)
    saveUserCredentials(TEST_USER)
    await settle()

    setSecretStoreForTests(memoryStore({ failGet: true }).store)
    await loadStoredAuthToken()
    expect(getUserCredentials()).toBeNull()
  })

  test('logout removes the keychain item too', async () => {
    const { store, peek } = memoryStore()
    setSecretStoreForTests(store)
    saveUserCredentials(TEST_USER)
    await settle()
    clearUserCredentials()
    await settle()
    expect(peek()).toBeNull()
    expect(getUserCredentials()).toBeNull()
  })
})
