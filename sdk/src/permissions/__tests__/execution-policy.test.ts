/**
 * Adversarial regression tests for the execution-permission policy (issue #1450).
 *
 * These encode the security properties the policy must hold. They test the
 * policy module directly (no network, no real processes), including the
 * cross-run isolation property that a process-global policy would violate.
 */

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from 'fs'
import { realpath as fsRealpath } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { toolNames } from '@codebuff/common/tools/constants'
import { toolParams } from '@codebuff/common/tools/list'

import {
  BUILT_IN_TOOL_CAPABILITIES,
  createExecutionPolicy,
  authorizeToolCall,
  classifyTool,
  guardFileSystem,
  canonicalizePath,
  isPathWithinRoot,
  isContainedPath,
} from '../execution-policy'

import type { CodebuffFileSystem } from '@codebuff/common/types/filesystem'

function policy(overrides: Partial<Parameters<typeof createExecutionPolicy>[0]> = {}) {
  return createExecutionPolicy({ projectRoot: '/tmp/project', ...overrides })
}

describe('classifyTool', () => {
  test('has a policy classification for every registered built-in', () => {
    const registeredNames = [...toolNames].sort()

    expect(Object.keys(toolParams).sort()).toEqual(registeredNames)
    expect(Object.keys(BUILT_IN_TOOL_CAPABILITIES).sort()).toEqual(
      registeredNames,
    )
  })

  test('classifies shell, fs, network, and unknown tools', () => {
    expect(classifyTool('run_terminal_command')).toBe('shell')
    expect(classifyTool('write_file')).toBe('fs-write')
    expect(classifyTool('apply_patch')).toBe('fs-write')
    expect(classifyTool('read_files')).toBe('fs-read')
    expect(classifyTool('read_url')).toBe('network')
    expect(classifyTool('browser_logs')).toBe('network')
    expect(classifyTool('run_file_change_hooks')).toBe('external')
    // Unknown names (MCP, custom tools) are external, never assumed safe.
    expect(classifyTool('mcp__github__create_issue')).toBe('external')
    expect(classifyTool('my_custom_tool')).toBe('external')
    expect(classifyTool('__proto__')).toBe('external')
    expect(classifyTool('constructor')).toBe('external')
  })
})

describe('per-run isolation (no process-global policy)', () => {
  test('a permissive run does not leak permissions into a restricted run', () => {
    const restricted = createExecutionPolicy({
      projectRoot: '/tmp/a',
      readOnly: true,
      noShell: true,
    })
    const permissive = createExecutionPolicy({ projectRoot: '/tmp/b' })

    // Building the permissive policy must not affect the restricted one.
    expect(
      authorizeToolCall(restricted, {
        toolName: 'run_terminal_command',
        capability: 'shell',
        command: 'rm -rf /',
        cwd: '/tmp/a',
      }).allowed,
    ).toBe(false)
    expect(
      authorizeToolCall(restricted, {
        toolName: 'write_file',
        capability: 'fs-write',
        targetPath: '/tmp/a/x.ts',
      }).allowed,
    ).toBe(false)
    // The permissive policy is independent.
    expect(
      authorizeToolCall(permissive, {
        toolName: 'write_file',
        capability: 'fs-write',
        targetPath: '/tmp/b/x.ts',
      }).allowed,
    ).toBe(true)
  })
})

describe('shell policy', () => {
  test('--no-shell denies unconditionally', () => {
    const p = policy({ noShell: true })
    const d = authorizeToolCall(p, { toolName: 'run_terminal_command', capability: 'shell', command: 'echo hi', cwd: '/tmp/project' })
    expect(d.allowed).toBe(false)
  })

  test('--read-only denies shell (unrestricted shell can write)', () => {
    const p = policy({ readOnly: true })
    const d = authorizeToolCall(p, { toolName: 'run_terminal_command', capability: 'shell', command: 'echo hi > /etc/passwd', cwd: '/tmp/project' })
    expect(d.allowed).toBe(false)
  })

  test('--project-only denies shell (unrestricted shell can escape)', () => {
    const p = policy({ projectOnly: true })
    const d = authorizeToolCall(p, { toolName: 'run_terminal_command', capability: 'shell', command: 'cat ~/.ssh/id_rsa', cwd: '/tmp/project' })
    expect(d.allowed).toBe(false)
  })

  test('--ask-shell with no handler is denied', () => {
    const p = policy({ askShell: true })
    const d = authorizeToolCall(p, { toolName: 'run_terminal_command', capability: 'shell', command: 'echo hi', cwd: '/tmp/project' })
    expect(d.allowed).toBe(false)
    expect(d.approvalRequired).toBe(true)
  })

  test('--ask-shell with handler requires approval (not auto-allow)', () => {
    const p = policy({ askShell: true, shellApproval: async () => 'deny' })
    const d = authorizeToolCall(p, { toolName: 'run_terminal_command', capability: 'shell', command: 'echo hi', cwd: '/tmp/project' })
    expect(d.allowed).toBe(false)
    expect(d.approvalRequired).toBe(true)
  })

  test('background commands are gated identically to sync (approval before spawn)', () => {
    const p = policy({ askShell: true, shellApproval: async () => 'deny' })
    const d = authorizeToolCall(p, {
      toolName: 'run_terminal_command',
      capability: 'shell',
      command: 'npm run dev',
      cwd: '/tmp/project',
      processType: 'BACKGROUND',
    })
    expect(d.allowed).toBe(false)
    expect(d.approvalRequired).toBe(true)
  })

  test('background commands denied under read-only/no-shell', () => {
    for (const flag of [{ readOnly: true }, { noShell: true }, { projectOnly: true }] as const) {
      const p = policy(flag)
      const d = authorizeToolCall(p, {
        toolName: 'run_terminal_command',
        capability: 'shell',
        command: 'npm run dev',
        cwd: '/tmp/project',
        processType: 'BACKGROUND',
      })
      expect(d.allowed).toBe(false)
    }
  })
})

describe('filesystem write policy', () => {
  test('--read-only denies writes regardless of target', () => {
    const p = policy({ readOnly: true })
    expect(authorizeToolCall(p, { toolName: 'write_file', capability: 'fs-write', targetPath: '/tmp/project/a.ts' }).allowed).toBe(false)
    expect(authorizeToolCall(p, { toolName: 'apply_patch', capability: 'fs-write', targetPath: '/tmp/project/b.ts' }).allowed).toBe(false)
  })

  test('--project-only denies writes outside the root', () => {
    const p = policy({ projectOnly: true })
    expect(authorizeToolCall(p, { toolName: 'write_file', capability: 'fs-write', targetPath: '/tmp/project/a.ts' }).allowed).toBe(true)
    expect(authorizeToolCall(p, { toolName: 'write_file', capability: 'fs-write', targetPath: '/tmp/elsewhere/a.ts' }).allowed).toBe(false)
    // Prefix that merely starts with the root string is not containment.
    expect(authorizeToolCall(p, { toolName: 'write_file', capability: 'fs-write', targetPath: '/tmp/project-evil/a.ts' }).allowed).toBe(false)
  })

  test('--project-only denies reads outside the root', () => {
    const p = policy({ projectOnly: true })
    expect(authorizeToolCall(p, { toolName: 'read_files', capability: 'fs-read', targetPath: '/tmp/project/a.ts' }).allowed).toBe(true)
    expect(authorizeToolCall(p, { toolName: 'read_files', capability: 'fs-read', targetPath: '/etc/passwd' }).allowed).toBe(false)
  })
})

describe('platform-correct containment (Windows branch)', () => {
  const win = { caseInsensitive: true, sep: '\\' }
  test('case-insensitive match on Windows accepts a same-path different-case child', () => {
    expect(isContainedPath('C:\\Proj\\a.ts', 'C:\\proj', win)).toBe(true)
    expect(isContainedPath('C:\\PROJ', 'C:\\proj', win)).toBe(true)
  })
  test('a case-variant sibling outside the root is still rejected', () => {
    expect(isContainedPath('C:\\proj-evil\\a.ts', 'C:\\proj', win)).toBe(false)
  })
  test('Windows separator prevents the prefix-sibling false positive', () => {
    // Without the trailing separator, C:\project would match root C:\proj.
    expect(isContainedPath('C:\\project\\a.ts', 'C:\\proj', win)).toBe(false)
  })
  test('POSIX is case-sensitive', () => {
    const posix = { caseInsensitive: false, sep: '/' }
    expect(isContainedPath('/tmp/Proj/a.ts', '/tmp/proj', posix)).toBe(false)
    expect(isContainedPath('/tmp/proj/a.ts', '/tmp/proj', posix)).toBe(true)
  })
})

describe('external tools under strict policies', () => {
  test('denied when any restriction is active and not trusted', () => {
    for (const flag of [{ noShell: true }, { askShell: true }, { projectOnly: true }, { readOnly: true }] as const) {
      const p = policy(flag)
      expect(authorizeToolCall(p, { toolName: 'mcp__x__y', capability: 'external' }).allowed).toBe(false)
    }
  })

  test('allowed when the host explicitly trusts external tools', () => {
    const p = policy({ readOnly: true, allowExternalTools: true })
    expect(authorizeToolCall(p, { toolName: 'mcp__x__y', capability: 'external' }).allowed).toBe(true)
  })

  test('allowed when no restriction is active', () => {
    const p = policy()
    expect(authorizeToolCall(p, { toolName: 'mcp__x__y', capability: 'external' }).allowed).toBe(true)
  })
})

describe('symlink-aware containment', () => {
  test('a symlink inside the root that points outside is not contained', async () => {
    const base = mkdtempSync(join(tmpdir(), 'policy-test-'))
    try {
      const root = join(base, 'project')
      const outside = join(base, 'outside')
      mkdirSync(root)
      mkdirSync(outside)
      writeFileSync(join(outside, 'secret.txt'), 'top secret')
      // root/link -> outside
      symlinkSync(outside, join(root, 'link'))

      // Lexically it looks inside the root...
      const lexicalTarget = join(root, 'link', 'secret.txt')
      // ...but canonicalization resolves the symlink out of the root.
      const contained = await isPathWithinRoot(lexicalTarget, root)
      expect(contained).toBe(false)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  test('a real file inside the root is contained', async () => {
    const base = mkdtempSync(join(tmpdir(), 'policy-test-'))
    try {
      const root = join(base, 'project')
      mkdirSync(root)
      writeFileSync(join(root, 'a.ts'), 'x')
      expect(await isPathWithinRoot(join(root, 'a.ts'), root)).toBe(true)
      expect(await isPathWithinRoot(root, root)).toBe(true)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  test('canonicalizePath resolves a symlinked ancestor', async () => {
    const base = mkdtempSync(join(tmpdir(), 'policy-test-'))
    try {
      const real = join(base, 'real')
      mkdirSync(real)
      const link = join(base, 'link')
      symlinkSync(real, link)
      // A not-yet-existing file under the link canonicalizes under `real`.
      const canonical = await canonicalizePath(join(link, 'new.txt'))
      expect(canonical.startsWith(real)).toBe(true)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})

describe('canonicalizePath failure handling', () => {
  const errno = (code: string): NodeJS.ErrnoException => {
    const error = new Error(code) as NodeJS.ErrnoException
    error.code = code
    return error
  }

  test('reappends the nearest existing ancestor without dropping a root-level character', async () => {
    // Only the filesystem root exists; every other component is missing. The
    // old `slice(parent.length + 1)` dropped the leading char of a root child.
    const realpath = async (p: string) => {
      if (p === '/') return '/'
      throw errno('ENOENT')
    }
    expect(await canonicalizePath('/policy-root-test/child', realpath)).toBe(
      '/policy-root-test/child',
    )
  })

  test('fails closed on a permission error instead of walking up', async () => {
    const realpath = async () => {
      throw errno('EACCES')
    }
    await expect(canonicalizePath('/protected/child', realpath)).rejects.toThrow(
      'EACCES',
    )
  })

  test('fails closed on a symlink loop instead of walking up', async () => {
    const realpath = async () => {
      throw errno('ELOOP')
    }
    await expect(canonicalizePath('/loop/child', realpath)).rejects.toThrow(
      'ELOOP',
    )
  })
})

describe('guardFileSystem (defense in depth)', () => {
  function mockFs(seen: { reads: string[]; writes: string[] }): CodebuffFileSystem {
    return {
      readFile: async (p: any) => {
        seen.reads.push(String(p))
        return 'data'
      },
      writeFile: async (p: any) => {
        seen.writes.push(String(p))
        return undefined
      },
      readdir: async (p: any) => {
        seen.reads.push(String(p))
        return []
      },
      stat: async (p: any) => {
        seen.reads.push(String(p))
        return {} as any
      },
      mkdir: async (p: any) => {
        seen.writes.push(String(p))
        return undefined
      },
      unlink: async (p: any) => {
        seen.writes.push(String(p))
        return undefined
      },
    } as unknown as CodebuffFileSystem
  }

  test('read-only blocks every write through the adapter', async () => {
    const seen = { reads: [] as string[], writes: [] as string[] }
    const guarded = guardFileSystem(mockFs(seen), policy({ readOnly: true }))
    await expect(guarded.writeFile('/tmp/project/a.ts', 'x')).rejects.toThrow()
    expect(seen.writes.length).toBe(0)
  })

  test('project-only blocks writes and reads outside the root', async () => {
    const base = mkdtempSync(join(tmpdir(), 'policy-fs-'))
    try {
      const root = join(base, 'project')
      mkdirSync(root)
      const seen = { reads: [] as string[], writes: [] as string[] }
      const guarded = guardFileSystem(mockFs(seen), policy({ projectOnly: true, projectRoot: root, canonicalize: fsRealpath }))
      await expect(guarded.writeFile(join(base, 'outside.ts'), 'x')).rejects.toThrow()
      await expect(guarded.readFile('/etc/passwd')).rejects.toThrow()
      // Inside the root is allowed.
      await guarded.writeFile(join(root, 'a.ts'), 'x')
      expect(seen.writes).toEqual([join(root, 'a.ts')])
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  test('unrestricted policy passes the adapter through untouched', () => {
    const seen = { reads: [] as string[], writes: [] as string[] }
    const raw = mockFs(seen)
    const guarded = guardFileSystem(raw, policy())
    expect(guarded).toBe(raw)
  })

  test('project-only refuses strict confinement for a custom adapter with no canonicalizer', () => {
    const seen = { reads: [] as string[], writes: [] as string[] }
    const customAdapter = mockFs(seen)
    // A custom adapter is not the Node default, so Node's realpath says nothing
    // about it. Refuse rather than silently mis-check containment.
    expect(() =>
      guardFileSystem(customAdapter, policy({ projectOnly: true })),
    ).toThrow(/canonicalizer/i)
  })

  test('project-only accepts a policy-supplied canonicalizer for a custom adapter', async () => {
    const seen = { reads: [] as string[], writes: [] as string[] }
    const canonicalize = async (p: string) => p
    const guarded = guardFileSystem(
      mockFs(seen),
      policy({ projectOnly: true, projectRoot: '/project', canonicalize }),
    )
    await expect(guarded.writeFile('/outside.ts', 'x')).rejects.toThrow(
      'outside project root',
    )
    await guarded.writeFile('/project/a.ts', 'x')
    expect(seen.writes).toEqual(['/project/a.ts'])
  })
})
