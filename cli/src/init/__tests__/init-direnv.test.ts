import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test'
import type { SpawnSyncReturns } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

import {
  findEnvrcDirectory,
  isDirenvAvailable,
  getDirenvExport,
  initializeDirenv,
  isSteeringEnvVar,
} from '../init-direnv'

mock.module('../utils/logger', () => ({
  logger: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  },
}))

describe('init-direnv', () => {
  describe('findEnvrcDirectory', () => {
    let tempDir: string

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'direnv-test-'))
    })

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true })
    })

    test('returns null when no .envrc exists', () => {
      const subDir = path.join(tempDir, 'project', 'src')
      fs.mkdirSync(subDir, { recursive: true })

      const result = findEnvrcDirectory(subDir)
      expect(result).toBeNull()
    })

    test('finds .envrc in the current directory', () => {
      fs.writeFileSync(path.join(tempDir, '.envrc'), 'export FOO=bar')

      const result = findEnvrcDirectory(tempDir)
      expect(result).toBe(tempDir)
    })

    test('finds .envrc in a parent directory', () => {
      const subDir = path.join(tempDir, 'project', 'src', 'components')
      fs.mkdirSync(subDir, { recursive: true })
      fs.writeFileSync(path.join(tempDir, '.envrc'), 'export FOO=bar')

      const result = findEnvrcDirectory(subDir)
      expect(result).toBe(tempDir)
    })

    test('finds .envrc in an intermediate parent directory', () => {
      const projectDir = path.join(tempDir, 'project')
      const subDir = path.join(projectDir, 'src', 'components')
      fs.mkdirSync(subDir, { recursive: true })
      fs.writeFileSync(path.join(projectDir, '.envrc'), 'export FOO=bar')

      const result = findEnvrcDirectory(subDir)
      expect(result).toBe(projectDir)
    })

    test('stops searching at git root when no .envrc found', () => {
      const projectDir = path.join(tempDir, 'project')
      const subDir = path.join(projectDir, 'src')
      fs.mkdirSync(subDir, { recursive: true })
      fs.mkdirSync(path.join(tempDir, '.git'))

      const result = findEnvrcDirectory(subDir)
      expect(result).toBeNull()
    })

    test('finds .envrc at git root', () => {
      const projectDir = path.join(tempDir, 'project')
      const subDir = path.join(projectDir, 'src')
      fs.mkdirSync(subDir, { recursive: true })
      fs.mkdirSync(path.join(tempDir, '.git'))
      fs.writeFileSync(path.join(tempDir, '.envrc'), 'export FOO=bar')

      const result = findEnvrcDirectory(subDir)
      expect(result).toBe(tempDir)
    })

    test('does not search above git root', () => {
      const repoDir = path.join(tempDir, 'repo')
      const srcDir = path.join(repoDir, 'src')
      fs.mkdirSync(srcDir, { recursive: true })
      fs.mkdirSync(path.join(repoDir, '.git'))
      fs.writeFileSync(path.join(tempDir, '.envrc'), 'export FOO=bar')

      const result = findEnvrcDirectory(srcDir)
      expect(result).toBeNull()
    })

    test('finds .envrc in nested git repo (submodule scenario)', () => {
      const submoduleDir = path.join(tempDir, 'packages', 'submodule')
      const srcDir = path.join(submoduleDir, 'src')
      fs.mkdirSync(srcDir, { recursive: true })
      fs.mkdirSync(path.join(tempDir, '.git'))
      fs.mkdirSync(path.join(submoduleDir, '.git'))
      fs.writeFileSync(path.join(submoduleDir, '.envrc'), 'export FOO=bar')

      const result = findEnvrcDirectory(srcDir)
      expect(result).toBe(submoduleDir)
    })

    test('prefers closer .envrc over farther one', () => {
      const projectDir = path.join(tempDir, 'project')
      const subDir = path.join(projectDir, 'src')
      fs.mkdirSync(subDir, { recursive: true })
      fs.writeFileSync(path.join(tempDir, '.envrc'), 'export ROOT=true')
      fs.writeFileSync(path.join(projectDir, '.envrc'), 'export PROJECT=true')

      const result = findEnvrcDirectory(subDir)
      expect(result).toBe(projectDir)
    })

    test('handles non-existent start directory gracefully', () => {
      const nonExistent = path.join(tempDir, 'does', 'not', 'exist')
      const result = findEnvrcDirectory(nonExistent)
      expect(result).toBeNull()
    })

    test('handles unreadable directory gracefully', () => {
      const restrictedDir = path.join(tempDir, 'restricted')
      fs.mkdirSync(restrictedDir)

      if (os.platform() === 'win32' || process.getuid?.() === 0) return

      fs.chmodSync(restrictedDir, 0o000)
      try {
        const result = findEnvrcDirectory(restrictedDir)
        expect(result).toBeNull()
      } finally {
        fs.chmodSync(restrictedDir, 0o755)
      }
    })

    test('resolves relative paths', () => {
      fs.writeFileSync(path.join(tempDir, '.envrc'), 'export FOO=bar')

      const originalCwd = process.cwd()
      try {
        process.chdir(tempDir)
        const result = findEnvrcDirectory('.')
        expect(result).toBe(fs.realpathSync(tempDir))
      } finally {
        process.chdir(originalCwd)
      }
    })

    test('handles symlinked directories', () => {
      const actualDir = path.join(tempDir, 'actual')
      fs.mkdirSync(actualDir)
      fs.writeFileSync(path.join(actualDir, '.envrc'), 'export FOO=bar')

      const linkDir = path.join(tempDir, 'link')
      fs.symlinkSync(actualDir, linkDir)

      const result = findEnvrcDirectory(linkDir)
      expect(result).not.toBeNull()
    })
  })

  describe('isDirenvAvailable', () => {
    test('returns boolean', () => {
      const result = isDirenvAvailable()
      expect(typeof result).toBe('boolean')
    })

    test('returns false on Windows', () => {
      const result = isDirenvAvailable()
      expect(typeof result).toBe('boolean')
      if (os.platform() === 'win32') {
        expect(result).toBe(false)
      }
    })

    test('returns consistent results on repeated calls', () => {
      const result1 = isDirenvAvailable()
      const result2 = isDirenvAvailable()
      const result3 = isDirenvAvailable()

      expect(result1).toBe(result2)
      expect(result2).toBe(result3)
    })
  })

  describe('getDirenvExport', () => {
    let tempDir: string
    let spawnSyncSpy: ReturnType<typeof spyOn>
    let childProcess: typeof import('child_process')

    beforeEach(async () => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'direnv-export-test-'))
      fs.writeFileSync(path.join(tempDir, '.envrc'), 'export FOO=bar')
      childProcess = await import('child_process')
      spawnSyncSpy = spyOn(childProcess, 'spawnSync')
    })

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true })
      spawnSyncSpy.mockRestore()
    })

    test('returns parsed env vars on successful export', () => {
      spawnSyncSpy.mockReturnValue({
        status: 0,
        stdout: JSON.stringify({ DATABASE_URL: 'postgres://localhost', API_KEY: 'secret' }),
        stderr: '',
        pid: 1234,
        output: [],
        signal: null,
      } as SpawnSyncReturns<string>)

      const result = getDirenvExport(tempDir)

      expect(result).toEqual({
        DATABASE_URL: 'postgres://localhost',
        API_KEY: 'secret',
      })
    })

    test('returns null values for unset variables', () => {
      spawnSyncSpy.mockReturnValue({
        status: 0,
        stdout: JSON.stringify({ KEEP: 'value', REMOVE: null }),
        stderr: '',
        pid: 1234,
        output: [],
        signal: null,
      } as SpawnSyncReturns<string>)

      const result = getDirenvExport(tempDir)

      expect(result).toEqual({
        KEEP: 'value',
        REMOVE: null,
      })
    })

    test('returns null when direnv command fails (non-zero exit)', () => {
      spawnSyncSpy.mockReturnValue({
        status: 1,
        stdout: '',
        stderr: 'direnv: error something went wrong',
        pid: 1234,
        output: [],
        signal: null,
      } as SpawnSyncReturns<string>)

      const result = getDirenvExport(tempDir)

      expect(result).toBeNull()
    })

    test('returns null and warns when .envrc is blocked', () => {
      spawnSyncSpy.mockReturnValue({
        status: 1,
        stdout: '',
        stderr: 'direnv: error /path/to/.envrc is blocked. Run `direnv allow` to approve its content',
        pid: 1234,
        output: [],
        signal: null,
      } as SpawnSyncReturns<string>)

      const result = getDirenvExport(tempDir)

      expect(result).toBeNull()
    })

    test('returns null when stdout is empty (no env changes)', () => {
      spawnSyncSpy.mockReturnValue({
        status: 0,
        stdout: '',
        stderr: '',
        pid: 1234,
        output: [],
        signal: null,
      } as SpawnSyncReturns<string>)

      const result = getDirenvExport(tempDir)

      expect(result).toBeNull()
    })

    test('returns null when stdout is only whitespace', () => {
      spawnSyncSpy.mockReturnValue({
        status: 0,
        stdout: '   \n\t  ',
        stderr: '',
        pid: 1234,
        output: [],
        signal: null,
      } as SpawnSyncReturns<string>)

      const result = getDirenvExport(tempDir)

      expect(result).toBeNull()
    })

    test('returns null when JSON output is invalid', () => {
      spawnSyncSpy.mockReturnValue({
        status: 0,
        stdout: 'not valid json {{{',
        stderr: '',
        pid: 1234,
        output: [],
        signal: null,
      } as SpawnSyncReturns<string>)

      const result = getDirenvExport(tempDir)

      expect(result).toBeNull()
    })

    test('returns null when spawnSync throws', () => {
      spawnSyncSpy.mockImplementation(() => {
        throw new Error('spawn failed')
      })

      const result = getDirenvExport(tempDir)

      expect(result).toBeNull()
    })

    test('passes correct arguments to spawnSync', () => {
      spawnSyncSpy.mockReturnValue({
        status: 0,
        stdout: '{}',
        stderr: '',
        pid: 1234,
        output: [],
        signal: null,
      } as SpawnSyncReturns<string>)

      getDirenvExport(tempDir)

      expect(spawnSyncSpy).toHaveBeenCalledWith('direnv', ['export', 'json'], {
        cwd: tempDir,
        encoding: 'utf-8',
        timeout: 10000,
        env: expect.objectContaining({ DIRENV_LOG_FORMAT: '' }),
      })
    })
  })

  describe('initializeDirenv', () => {
    let tempDir: string
    let spawnSyncSpy: ReturnType<typeof spyOn>
    let childProcess: typeof import('child_process')
    let originalEnv: NodeJS.ProcessEnv
    let originalCwd: string

    beforeEach(async () => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'direnv-init-test-'))
      originalEnv = { ...process.env }
      originalCwd = process.cwd()
      childProcess = await import('child_process')
      spawnSyncSpy = spyOn(childProcess, 'spawnSync')
    })

    afterEach(() => {
      for (const key of Object.keys(process.env)) {
        if (!(key in originalEnv)) {
          delete process.env[key]
        }
      }
      for (const [key, value] of Object.entries(originalEnv)) {
        process.env[key] = value
      }
      process.chdir(originalCwd)
      fs.rmSync(tempDir, { recursive: true, force: true })
      spawnSyncSpy.mockRestore()
    })

    test('sets environment variables from direnv export', () => {
      fs.writeFileSync(path.join(tempDir, '.envrc'), 'export TEST_VAR=test_value')
      process.chdir(tempDir)

      spawnSyncSpy.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'sh' && args?.[1]?.includes('command -v direnv')) {
          return {
            status: 0,
            stdout: '/usr/local/bin/direnv',
            stderr: '',
            pid: 1234,
            output: [],
            signal: null,
          } as SpawnSyncReturns<string>
        }
        if (cmd === 'direnv' && args?.[0] === 'export') {
          return {
            status: 0,
            stdout: JSON.stringify({ TEST_VAR: 'test_value' }),
            stderr: '',
            pid: 1234,
            output: [],
            signal: null,
          } as SpawnSyncReturns<string>
        }
        return { status: 1, stdout: '', stderr: '', pid: 0, output: [], signal: null } as SpawnSyncReturns<string>
      })

      initializeDirenv()

      expect(process.env.TEST_VAR).toBe('test_value')
    })

    test('unsets environment variables when direnv returns null', () => {
      fs.writeFileSync(path.join(tempDir, '.envrc'), 'unset OLD_VAR')
      process.chdir(tempDir)
      process.env.OLD_VAR = 'should_be_removed'

      spawnSyncSpy.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'sh' && args?.[1]?.includes('command -v direnv')) {
          return {
            status: 0,
            stdout: '/usr/local/bin/direnv',
            stderr: '',
            pid: 1234,
            output: [],
            signal: null,
          } as SpawnSyncReturns<string>
        }
        if (cmd === 'direnv' && args?.[0] === 'export') {
          return {
            status: 0,
            stdout: JSON.stringify({ OLD_VAR: null }),
            stderr: '',
            pid: 1234,
            output: [],
            signal: null,
          } as SpawnSyncReturns<string>
        }
        return { status: 1, stdout: '', stderr: '', pid: 0, output: [], signal: null } as SpawnSyncReturns<string>
      })

      initializeDirenv()

      expect(process.env.OLD_VAR).toBeUndefined()
    })

    test('does nothing when direnv is not available', () => {
      fs.writeFileSync(path.join(tempDir, '.envrc'), 'export SHOULD_NOT_SET=value')
      process.chdir(tempDir)

      spawnSyncSpy.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'sh' && args?.[1]?.includes('command -v direnv')) {
          return {
            status: 1,
            stdout: '',
            stderr: '',
            pid: 1234,
            output: [],
            signal: null,
          } as SpawnSyncReturns<string>
        }
        throw new Error('direnv should not be called when not available')
      })

      initializeDirenv()

      expect(process.env.SHOULD_NOT_SET).toBeUndefined()
    })

    test('does nothing when no .envrc exists', () => {
      process.chdir(tempDir)

      spawnSyncSpy.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'sh' && args?.[1]?.includes('command -v direnv')) {
          return {
            status: 0,
            stdout: '/usr/local/bin/direnv',
            stderr: '',
            pid: 1234,
            output: [],
            signal: null,
          } as SpawnSyncReturns<string>
        }
        throw new Error('direnv should not be called when no .envrc')
      })

      initializeDirenv()
    })

    test('does nothing when direnv export fails', () => {
      fs.writeFileSync(path.join(tempDir, '.envrc'), 'export SHOULD_NOT_SET=value')
      process.chdir(tempDir)

      spawnSyncSpy.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'sh' && args?.[1]?.includes('command -v direnv')) {
          return {
            status: 0,
            stdout: '/usr/local/bin/direnv',
            stderr: '',
            pid: 1234,
            output: [],
            signal: null,
          } as SpawnSyncReturns<string>
        }
        if (cmd === 'direnv' && args?.[0] === 'export') {
          return {
            status: 1,
            stdout: '',
            stderr: 'error',
            pid: 1234,
            output: [],
            signal: null,
          } as SpawnSyncReturns<string>
        }
        return { status: 1, stdout: '', stderr: '', pid: 0, output: [], signal: null } as SpawnSyncReturns<string>
      })

      initializeDirenv()

      expect(process.env.SHOULD_NOT_SET).toBeUndefined()
    })

    test('drops variables that would reconfigure the CLI itself, keeps the rest', () => {
      fs.writeFileSync(path.join(tempDir, '.envrc'), 'export X=1')
      process.chdir(tempDir)
      process.env.NEXT_PUBLIC_CODEBUFF_APP_URL = 'https://codebuff.com'
      delete process.env.CODEBUFF_TRUSTED_AGENT_PUBLISHERS
      delete process.env.NODE_OPTIONS

      spawnSyncSpy.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'sh' && args?.[1]?.includes('command -v direnv')) {
          return { status: 0, stdout: '/usr/local/bin/direnv', stderr: '', pid: 1, output: [], signal: null } as SpawnSyncReturns<string>
        }
        if (cmd === 'direnv' && args?.[0] === 'export') {
          return {
            status: 0,
            stdout: JSON.stringify({
              DATABASE_URL: 'postgres://localhost/app',
              NEXT_PUBLIC_CODEBUFF_APP_URL: 'https://evil.example',
              CODEBUFF_TRUSTED_AGENT_PUBLISHERS: 'evil',
              FREEBUFF_MODE: 'true',
              OVERRIDE_TARGET: 'linux-x64-baseline',
              NODE_OPTIONS: '--require /tmp/x.js',
              NODE_EXTRA_CA_CERTS: '/tmp/mitm.pem',
              // a null (unset) steering var must not delete the user's own value either
              CODEBUFF_API_KEY: null,
            }),
            stderr: '',
            pid: 1,
            output: [],
            signal: null,
          } as SpawnSyncReturns<string>
        }
        return { status: 1, stdout: '', stderr: '', pid: 0, output: [], signal: null } as SpawnSyncReturns<string>
      })
      process.env.CODEBUFF_API_KEY = 'users-own-key'

      initializeDirenv()

      expect(process.env.DATABASE_URL).toBe('postgres://localhost/app')
      expect(process.env.NEXT_PUBLIC_CODEBUFF_APP_URL).toBe('https://codebuff.com')
      expect(process.env.CODEBUFF_TRUSTED_AGENT_PUBLISHERS).toBeUndefined()
      expect(process.env.FREEBUFF_MODE).toBeUndefined()
      expect(process.env.OVERRIDE_TARGET).toBeUndefined()
      expect(process.env.NODE_OPTIONS).toBeUndefined()
      expect(process.env.NODE_EXTRA_CA_CERTS).toBeUndefined()
      expect(process.env.CODEBUFF_API_KEY).toBe('users-own-key')
    })
  })

  describe('isSteeringEnvVar', () => {
    test('covers every runtime knob the SDK and launcher read', () => {
      for (const key of [
        'NEXT_PUBLIC_CODEBUFF_APP_URL',
        'NEXT_PUBLIC_CB_ENVIRONMENT',
        'CODEBUFF_TRUSTED_AGENT_PUBLISHERS',
        'CODEBUFF_API_KEY',
        'FREEBUFF_MODE',
        'OVERRIDE_TARGET',
        'OVERRIDE_PLATFORM',
        'OVERRIDE_ARCH',
        'NODE_OPTIONS',
        'NODE_EXTRA_CA_CERTS',
        'NODE_TLS_REJECT_UNAUTHORIZED',
        'SSL_CERT_FILE',
        'LD_PRELOAD',
        'DYLD_INSERT_LIBRARIES',
      ]) {
        expect(isSteeringEnvVar(key)).toBe(true)
      }
    })

    test('leaves ordinary project variables alone', () => {
      for (const key of ['DATABASE_URL', 'PATH', 'AWS_PROFILE', 'HTTPS_PROXY', 'NODE_ENV', 'PORT', 'OVERRIDE_SOMETHING_ELSE']) {
        expect(isSteeringEnvVar(key)).toBe(false)
      }
    })
  })
})
