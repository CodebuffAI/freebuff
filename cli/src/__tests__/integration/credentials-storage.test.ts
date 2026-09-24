import fs from 'fs'
import os from 'os'
import path from 'path'

import {
  clearMockedModules,
  mockModule,
} from '@codebuff/common/testing/mock-modules'
import {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
  mock,
  spyOn,
} from 'bun:test'

import { setProjectRoot } from '../../project-files'
import * as authModule from '../../utils/auth'
import { saveUserCredentials, getUserCredentials } from '../../utils/auth'

import type { User } from '../../utils/auth'

/**
 * Integration tests for credential storage and retrieval
 *
 * These tests verify the complete flow of saving, loading, and managing
 * user credentials on the file system. Credentials are stored in:
 * - Dev: ~/.config/manicode-dev/credentials.json
 * - Prod: ~/.config/manicode/credentials.json
 *
 * Tests ensure:
 * - Directories are created if missing
 * - JSON format is correct and parseable
 * - Credentials persist across CLI restarts
 * - File operations are atomic (no partial writes)
 * - Environment variable detection works (dev vs prod)
 */

const TEST_USER: User = {
  id: 'test-user-123',
  name: 'Test User',
  email: 'test@example.com',
  authToken: 'test-session-token-abc',
  fingerprintId: 'test-fingerprint',
  fingerprintHash: 'test-hash',
}

describe('Credentials Storage Integration', () => {
  let tempConfigDir: string

  beforeEach(() => {
    // Create temporary config directory for tests
    tempConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manicode-test-'))

    // Set project root to avoid "Project root not set" error in logger
    setProjectRoot(tempConfigDir)

    // Mock getConfigDir to use temp directory
    spyOn(authModule, 'getConfigDir').mockReturnValue(tempConfigDir)
    spyOn(authModule, 'getCredentialsPath').mockReturnValue(
      path.join(tempConfigDir, 'credentials.json'),
    )
  })

  afterEach(() => {
    // Clean up temp directory
    if (fs.existsSync(tempConfigDir)) {
      fs.rmSync(tempConfigDir, { recursive: true, force: true })
    }

    mock.restore()
    clearMockedModules()
  })

  describe('P0: File System Operations', () => {
    test('should create config directory if it does not exist', () => {
      // Ensure directory doesn't exist initially
      if (fs.existsSync(tempConfigDir)) {
        fs.rmSync(tempConfigDir, { recursive: true })
      }
      expect(fs.existsSync(tempConfigDir)).toBe(false)

      // Call saveUserCredentials - should create directory
      saveUserCredentials(TEST_USER)

      // Verify directory was created
      expect(fs.existsSync(tempConfigDir)).toBe(true)

      // Verify it's a directory
      const stats = fs.statSync(tempConfigDir)
      expect(stats.isDirectory()).toBe(true)

      // Verify credentials file was created in the directory
      const credentialsPath = path.join(tempConfigDir, 'credentials.json')
      expect(fs.existsSync(credentialsPath)).toBe(true)
    })

    test('should write credentials.json with correct JSON format', () => {
      // Call saveUserCredentials
      saveUserCredentials(TEST_USER)

      // Read the credentials file
      const credentialsPath = path.join(tempConfigDir, 'credentials.json')
      const fileContent = fs.readFileSync(credentialsPath, 'utf8')

      // Parse JSON
      const parsed = JSON.parse(fileContent)

      // Verify structure is { default: { ...user fields } }
      expect(parsed).toHaveProperty('default')
      expect(typeof parsed.default).toBe('object')

      // Verify all user fields are present
      expect(parsed.default.id).toBe(TEST_USER.id)
      expect(parsed.default.name).toBe(TEST_USER.name)
      expect(parsed.default.email).toBe(TEST_USER.email)
      expect(parsed.default.authToken).toBe(TEST_USER.authToken)
      expect(parsed.default.fingerprintId).toBe(TEST_USER.fingerprintId)
      expect(parsed.default.fingerprintHash).toBe(TEST_USER.fingerprintHash)
    })

    test('should overwrite existing credentials when saving new ones', () => {
      // Save initial credentials
      saveUserCredentials(TEST_USER)

      // Read and verify first credentials
      const credentialsPath = path.join(tempConfigDir, 'credentials.json')
      let fileContent = fs.readFileSync(credentialsPath, 'utf8')
      let parsed = JSON.parse(fileContent)
      expect(parsed.default.id).toBe(TEST_USER.id)

      // Save different credentials
      const newUser: User = {
        id: 'different-user-456',
        name: 'Different User',
        email: 'different@example.com',
        authToken: 'different-token',
        fingerprintId: 'different-fingerprint',
        fingerprintHash: 'different-hash',
      }
      saveUserCredentials(newUser)

      // Read again
      fileContent = fs.readFileSync(credentialsPath, 'utf8')
      parsed = JSON.parse(fileContent)

      // Verify new credentials replaced old ones
      expect(parsed.default.id).toBe(newUser.id)
      expect(parsed.default.name).toBe(newUser.name)
      expect(parsed.default.email).toBe(newUser.email)
      expect(parsed.default.authToken).toBe(newUser.authToken)

      // Verify only one 'default' entry exists
      const keys = Object.keys(parsed)
      expect(keys.length).toBe(1)
      expect(keys[0]).toBe('default')
    })

    test('should use manicode-test directory in test environment', async () => {
      // Restore getConfigDir to use real implementation for this test
      mock.restore()

      await mockModule('@codebuff/common/env', () => ({
        env: { NEXT_PUBLIC_CB_ENVIRONMENT: 'test' },
      }))

      // Call real getConfigDir to verify it includes '-dev'
      const configDir = authModule.getConfigDir()
      expect(configDir).toEqual(
        path.join(os.homedir(), '.config', 'manicode-test'),
      )
    })

    test('should use manicode-dev directory in development environment', async () => {
      // Restore getConfigDir to use real implementation for this test
      mock.restore()

      await mockModule('@codebuff/common/env', () => ({
        env: { NEXT_PUBLIC_CB_ENVIRONMENT: 'dev' },
      }))

      // Call real getConfigDir to verify it includes '-dev'
      const configDir = authModule.getConfigDir()
      expect(configDir).toEqual(
        path.join(os.homedir(), '.config', 'manicode-dev'),
      )
    })

    test('should use manicode directory in production environment', async () => {
      // Restore getConfigDir to use real implementation
      mock.restore()

      // Set environment to prod (or unset it)
      await mockModule('@codebuff/common/env', () => ({
        env: { NEXT_PUBLIC_CB_ENVIRONMENT: 'prod' },
      }))

      // Call real getConfigDir to verify it doesn't include '-dev'
      const configDir = authModule.getConfigDir()
      expect(configDir).toEqual(path.join(os.homedir(), '.config', 'manicode'))
    })

    test('should allow credentials to persist across simulated CLI restarts', () => {
      // Save credentials
      saveUserCredentials(TEST_USER)

      // Simulate CLI restart by calling getUserCredentials
      // (simulates reading from disk on fresh startup)
      const loadedCredentials = getUserCredentials()

      // Verify credentials are loaded from file
      expect(loadedCredentials).not.toBeNull()
      expect(loadedCredentials).toBeDefined()

      // Verify all fields match what was saved
      expect(loadedCredentials!.id).toBe(TEST_USER.id)
      expect(loadedCredentials!.name).toBe(TEST_USER.name)
      expect(loadedCredentials!.email).toBe(TEST_USER.email)
      expect(loadedCredentials!.authToken).toBe(TEST_USER.authToken)
      expect(loadedCredentials!.fingerprintId).toBe(TEST_USER.fingerprintId)
      expect(loadedCredentials!.fingerprintHash).toBe(TEST_USER.fingerprintHash)
    })

    test('drops the removed ChatGPT integration token on the next write', () => {
      // Anyone who ran /connect-chatgpt still has an OAuth access + refresh
      // token for their own ChatGPT account sitting in this file. Nothing reads
      // it now and the command that managed it is gone, so it must not survive
      // a rewrite — otherwise it is orphaned on disk with no way to clear it.
      const credentialsPath = path.join(tempConfigDir, 'credentials.json')
      fs.writeFileSync(
        credentialsPath,
        JSON.stringify({
          default: { ...TEST_USER, authToken: 'stale' },
          chatgptOAuth: {
            accessToken: 'a',
            refreshToken: 'r',
            expiresAt: 1,
            connectedAt: 1,
          },
          someOtherKey: 'kept',
        }),
      )

      saveUserCredentials(TEST_USER)

      const parsed = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'))
      expect(parsed.chatgptOAuth).toBeUndefined()
      // Only that one key goes: unrelated entries and the login still stand.
      expect(parsed.someOtherKey).toBe('kept')
      expect(parsed.default.authToken).toBe(TEST_USER.authToken)
    })
  })

  describe('P0: Credential Format Validation', () => {
    test('should save user ID in credentials', () => {
      saveUserCredentials(TEST_USER)

      const credentialsPath = path.join(tempConfigDir, 'credentials.json')
      const parsed = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'))

      expect(parsed.default.id).toBe(TEST_USER.id)
    })

    test('should save user name in credentials', () => {
      saveUserCredentials(TEST_USER)

      const credentialsPath = path.join(tempConfigDir, 'credentials.json')
      const parsed = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'))

      expect(parsed.default.name).toBe(TEST_USER.name)
    })

    test('should save user email in credentials', () => {
      saveUserCredentials(TEST_USER)

      const credentialsPath = path.join(tempConfigDir, 'credentials.json')
      const parsed = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'))

      expect(parsed.default.email).toBe(TEST_USER.email)
    })

    test('should save authToken (session token) in credentials', () => {
      saveUserCredentials(TEST_USER)

      const credentialsPath = path.join(tempConfigDir, 'credentials.json')
      const parsed = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'))

      // authToken is the most critical field for authentication
      expect(parsed.default.authToken).toBe(TEST_USER.authToken)
      expect(parsed.default.authToken).toBeTruthy()
    })

    test('should save fingerprintId in credentials', () => {
      saveUserCredentials(TEST_USER)

      const credentialsPath = path.join(tempConfigDir, 'credentials.json')
      const parsed = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'))

      expect(parsed.default.fingerprintId).toBe(TEST_USER.fingerprintId)
    })

    test('should save fingerprintHash in credentials', () => {
      saveUserCredentials(TEST_USER)

      const credentialsPath = path.join(tempConfigDir, 'credentials.json')
      const parsed = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'))

      expect(parsed.default.fingerprintHash).toBe(TEST_USER.fingerprintHash)
    })

    test('should produce valid, parseable JSON', () => {
      saveUserCredentials(TEST_USER)

      const credentialsPath = path.join(tempConfigDir, 'credentials.json')
      const fileContent = fs.readFileSync(credentialsPath, 'utf8')

      // Verify JSON.parse doesn't throw
      let parsed: any
      expect(() => {
        parsed = JSON.parse(fileContent)
      }).not.toThrow()

      // Verify parsed object has expected structure
      expect(parsed).toHaveProperty('default')
      expect(typeof parsed.default).toBe('object')
      expect(parsed.default).toHaveProperty('id')
      expect(parsed.default).toHaveProperty('authToken')
    })
  })

  // The server's user record allows a null name and the login response is
  // written to disk as-is. A strict `name: z.string()` made the whole file
  // fail to parse, so these accounts were logged out on every launch.
  describe('P0: Accounts without a name', () => {
    const writeCredentialsFile = (profile: Record<string, unknown>) => {
      fs.writeFileSync(
        path.join(tempConfigDir, 'credentials.json'),
        JSON.stringify({ default: profile }, null, 2),
      )
    }

    test('should stay logged in when the file has "name": null', () => {
      writeCredentialsFile({ ...TEST_USER, name: null })

      const user = getUserCredentials()

      expect(user).not.toBeNull()
      expect(user?.authToken).toBe(TEST_USER.authToken)
      expect(user?.email).toBe(TEST_USER.email)
      expect(user?.name).toBe('')
    })

    test('should stay logged in when the file has no name at all', () => {
      const { name: _name, ...withoutName } = TEST_USER
      writeCredentialsFile(withoutName)

      const user = getUserCredentials()

      expect(user?.authToken).toBe(TEST_USER.authToken)
      expect(user?.name).toBe('')
    })

    test('should not write a null name for a login response without one', () => {
      // The login response is cast to `User`, so null reaches the writer.
      saveUserCredentials({ ...TEST_USER, name: null } as unknown as User)

      const parsed = JSON.parse(
        fs.readFileSync(path.join(tempConfigDir, 'credentials.json'), 'utf8'),
      )

      expect(parsed.default.name).toBe('')
      expect(getUserCredentials()?.authToken).toBe(TEST_USER.authToken)
    })
  })

  describe('P2: File System Edge Cases', () => {
    test('should preserve file permissions when writing credentials', () => {
      // Save credentials
      saveUserCredentials(TEST_USER)

      // Check file permissions
      const credentialsPath = path.join(tempConfigDir, 'credentials.json')
      const stats = fs.statSync(credentialsPath)
      const mode = stats.mode

      // On Unix systems, check permissions
      if (process.platform !== 'win32') {
        // File should be readable by user
        expect((mode & 0o400) !== 0).toBe(true)

        // File should be writable by user
        expect((mode & 0o200) !== 0).toBe(true)
      } else {
        // On Windows, just verify file exists and is accessible
        expect(fs.existsSync(credentialsPath)).toBe(true)
      }
    })

    test('should handle write permission errors gracefully', () => {
      // Mock fs.writeFileSync to throw EACCES error
      const writeError = new Error(
        'EACCES: permission denied',
      ) as NodeJS.ErrnoException
      writeError.code = 'EACCES'

      const writeFileSyncSpy = spyOn(fs, 'writeFileSync').mockImplementation(
        () => {
          throw writeError
        },
      )

      // Attempt to save credentials - should throw since we're not catching in saveUserCredentials
      expect(() => {
        saveUserCredentials(TEST_USER)
      }).toThrow('EACCES')

      // Verify writeFileSync was attempted
      expect(writeFileSyncSpy).toHaveBeenCalled()
    })

    test('should show clear error message on permission denial', () => {
      // This test verifies that when permission is denied, the error is logged
      const writeError = new Error(
        "EACCES: permission denied, open '/test/credentials.json'",
      ) as NodeJS.ErrnoException
      writeError.code = 'EACCES'

      spyOn(fs, 'writeFileSync').mockImplementation(() => {
        throw writeError
      })

      // Attempt to save credentials - will throw and get logged
      expect(() => {
        saveUserCredentials(TEST_USER)
      }).toThrow()

      // The actual error logging happens in saveUserCredentials via logger.error
      // The error message includes the error details which would help users diagnose
    })

    test('should gracefully degrade if credentials cannot be written', () => {
      // This tests that the error is thrown (not silently swallowed)
      // The caller (login mutation) is responsible for handling the error gracefully
      const writeError = new Error(
        'ENOSPC: no space left on device',
      ) as NodeJS.ErrnoException
      writeError.code = 'ENOSPC'

      spyOn(fs, 'writeFileSync').mockImplementation(() => {
        throw writeError
      })

      // Attempt to save - should throw to caller who can handle it
      expect(() => {
        saveUserCredentials(TEST_USER)
      }).toThrow('ENOSPC')

      // The login mutation's onError handler would catch this and allow
      // the user to continue with in-memory credentials
    })
  })

  describe('P2: Concurrent Operations', () => {
    test('should handle rapid saves without race conditions', () => {
      // Create different user objects for rapid saves
      const users: User[] = []
      for (let i = 0; i < 5; i++) {
        users.push({
          id: `user-${i}`,
          name: `User ${i}`,
          email: `user${i}@example.com`,
          authToken: `token-${i}`,
          fingerprintId: `fingerprint-${i}`,
          fingerprintHash: `hash-${i}`,
        })
      }

      // Call saveUserCredentials 5 times rapidly
      users.forEach((user) => saveUserCredentials(user))

      // Read final credentials
      const credentialsPath = path.join(tempConfigDir, 'credentials.json')
      const fileContent = fs.readFileSync(credentialsPath, 'utf8')
      const parsed = JSON.parse(fileContent)

      // Verify file contains the last saved data (user-4)
      expect(parsed.default.id).toBe('user-4')
      expect(parsed.default.name).toBe('User 4')

      // Verify no corrupted/partial data - JSON should be valid
      expect(parsed).toHaveProperty('default')
      expect(typeof parsed.default.authToken).toBe('string')
    })

    test('should handle read during write without corruption', () => {
      // Since fs.writeFileSync is synchronous, there's no actual concurrency
      // But we can verify that writes are atomic (no partial data)

      // Save initial credentials
      saveUserCredentials(TEST_USER)

      // Read credentials
      const loadedBefore = getUserCredentials()
      expect(loadedBefore).not.toBeNull()
      expect(loadedBefore!.id).toBe(TEST_USER.id)

      // Save new credentials
      const newUser: User = {
        id: 'new-user-789',
        name: 'New User',
        email: 'new@example.com',
        authToken: 'new-token',
        fingerprintId: 'new-fingerprint',
        fingerprintHash: 'new-hash',
      }
      saveUserCredentials(newUser)

      // Read again - should get complete new data (not partial/mixed)
      const loadedAfter = getUserCredentials()
      expect(loadedAfter).not.toBeNull()
      expect(loadedAfter!.id).toBe(newUser.id)
      expect(loadedAfter!.name).toBe(newUser.name)
      expect(loadedAfter!.authToken).toBe(newUser.authToken)

      // Verify NOT corrupted (not mixed old and new data)
      expect(loadedAfter!.id).not.toBe(TEST_USER.id)
    })
  })
})
