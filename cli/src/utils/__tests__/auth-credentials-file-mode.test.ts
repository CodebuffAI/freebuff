import fs from 'fs'
import os from 'os'
import path from 'path'

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test'

import { setProjectRoot } from '../../project-files'
import * as authModule from '../auth'
import {
  clearUserCredentials,
  getUserCredentials,
  saveUserCredentials,
} from '../auth'

import type { User } from '../auth'

/**
 * `credentials.json` holds the bearer token for every API call. It must be
 * owner-only on disk, and an install that already has a umask-wide file must
 * be tightened the next time the CLI reads it. POSIX mode bits do not apply
 * on Windows, so every assertion here is skipped there.
 */

const TEST_USER: User = {
  id: 'test-user-123',
  name: 'Test User',
  email: 'test@example.com',
  authToken: 'test-session-token-abc',
}

const isWindows = process.platform === 'win32'

const modeOf = (p: string): number => fs.statSync(p).mode & 0o777

describe('credentials file permissions', () => {
  let tempRoot: string
  let configDir: string
  let credentialsPath: string
  let originalUmask: number

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuff-cred-mode-'))
    // A nested, not-yet-existing dir so saveUserCredentials creates it.
    configDir = path.join(tempRoot, 'config')
    credentialsPath = path.join(configDir, 'credentials.json')
    setProjectRoot(tempRoot)
    spyOn(authModule, 'getConfigDir').mockReturnValue(configDir)
    spyOn(authModule, 'getCredentialsPath').mockReturnValue(credentialsPath)
    // A permissive umask so a bare write would come out group/other-readable;
    // the explicit mode must win regardless of the process umask.
    originalUmask = process.umask(0o002)
  })

  afterEach(() => {
    process.umask(originalUmask)
    fs.rmSync(tempRoot, { recursive: true, force: true })
    mock.restore()
  })

  test.skipIf(isWindows)('creates credentials.json owner-only (0600)', () => {
    saveUserCredentials(TEST_USER)

    expect(modeOf(credentialsPath)).toBe(0o600)
  })

  test.skipIf(isWindows)(
    'creates the config directory owner-only (0700)',
    () => {
      saveUserCredentials(TEST_USER)

      expect(modeOf(configDir)).toBe(0o700)
    },
  )

  test.skipIf(isWindows)(
    'tightens a pre-existing group/other-readable file on save',
    () => {
      fs.mkdirSync(configDir, { recursive: true })
      fs.writeFileSync(credentialsPath, JSON.stringify({ other: 'kept' }), {
        mode: 0o644,
      })
      expect(modeOf(credentialsPath)).toBe(0o644)

      // writeFileSync's `mode` only applies on create, so this is the chmod.
      saveUserCredentials(TEST_USER)

      expect(modeOf(credentialsPath)).toBe(0o600)
      const parsed = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'))
      expect(parsed.other).toBe('kept')
      expect(parsed.default.authToken).toBe(TEST_USER.authToken)
    },
  )

  test.skipIf(isWindows)(
    'tightens a pre-existing group/other-readable file on read',
    () => {
      fs.mkdirSync(configDir, { recursive: true })
      fs.writeFileSync(
        credentialsPath,
        JSON.stringify({ default: TEST_USER }),
        {
          mode: 0o644,
        },
      )
      expect(modeOf(credentialsPath)).toBe(0o644)

      // Startup reads credentials before anything is written, so the heal
      // for existing installs has to happen here.
      const user = getUserCredentials()

      expect(user?.authToken).toBe(TEST_USER.authToken)
      expect(modeOf(credentialsPath)).toBe(0o600)
    },
  )

  test.skipIf(isWindows)(
    'keeps the file owner-only when clearing leaves other profiles behind',
    () => {
      fs.mkdirSync(configDir, { recursive: true })
      fs.writeFileSync(
        credentialsPath,
        JSON.stringify({ default: TEST_USER, other: 'kept' }),
        { mode: 0o644 },
      )

      clearUserCredentials()

      expect(fs.existsSync(credentialsPath)).toBe(true)
      expect(modeOf(credentialsPath)).toBe(0o600)
      expect(JSON.parse(fs.readFileSync(credentialsPath, 'utf8'))).toEqual({
        other: 'kept',
      })
    },
  )

  test('a failed chmod does not cost the user their login', () => {
    fs.mkdirSync(configDir, { recursive: true })
    fs.writeFileSync(credentialsPath, JSON.stringify({ default: TEST_USER }))
    spyOn(fs, 'chmodSync').mockImplementation(() => {
      throw new Error('EPERM: operation not permitted')
    })

    expect(getUserCredentials()?.authToken).toBe(TEST_USER.authToken)
    expect(() => saveUserCredentials(TEST_USER)).not.toThrow()
  })
})
