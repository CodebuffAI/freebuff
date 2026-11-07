import { createMockFs } from '@codebuff/common/testing/mocks/filesystem'
import { describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'fs'
import { realpath as fsRealpath } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { createExecutionPolicy } from '../execution-policy'
import { handleToolCall } from '../../run'

async function dispatchApplyPatch(
  operation: unknown,
  options: { projectRoot: string; cwd: string; canonicalize?: (p: string) => Promise<string> },
) {
  const writeOverride = mock(async () => [
    { type: 'json' as const, value: { message: 'patch dispatched' } },
  ])
  const result = await handleToolCall({
    action: {
      type: 'tool-call-request',
      requestId: crypto.randomUUID(),
      userInputId: 'test-input',
      toolName: 'apply_patch',
      input: { operation },
      timeout: undefined,
    },
    overrides: { write_file: writeOverride },
    customToolDefinitions: {},
    cwd: options.cwd,
    fs: createMockFs(),
    policy: createExecutionPolicy({
      projectRoot: options.projectRoot,
      projectOnly: true,
      allowExternalTools: true,
      ...(options.canonicalize ? { canonicalize: options.canonicalize } : {}),
    }),
  })
  return { result, writeOverride }
}

describe('apply_patch project-only target resolution', () => {
  const withProject = async (
    body: (paths: { base: string; root: string; outside: string }) => Promise<void>,
  ) => {
    const base = mkdtempSync(join(tmpdir(), 'apply-patch-test-'))
    const root = join(base, 'project')
    const outside = join(base, 'outside')
    mkdirSync(root)
    mkdirSync(outside)
    try {
      await body({ base, root, outside })
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  }

  test('dispatches a patch targeting a file inside the project', async () => {
    await withProject(async ({ root }) => {
      const { result, writeOverride } = await dispatchApplyPatch(
        { type: 'create_file', path: 'src/new.ts', diff: '@@\n+content\n' },
        { projectRoot: root, cwd: root, canonicalize: fsRealpath },
      )

      expect(writeOverride).toHaveBeenCalledTimes(1)
      expect(JSON.stringify(result.output)).toContain('patch dispatched')
    })
  })

  test('rejects a patch targeting a file outside the project', async () => {
    await withProject(async ({ root }) => {
      const { result, writeOverride } = await dispatchApplyPatch(
        { type: 'create_file', path: '../outside.txt', diff: '@@\n+content\n' },
        { projectRoot: root, cwd: root, canonicalize: fsRealpath },
      )

      expect(writeOverride).not.toHaveBeenCalled()
      expect(JSON.stringify(result.output)).toContain('outside project root')
    })
  })

  test('rejects a patch whose in-project path is a symlink to outside the project', async () => {
    await withProject(async ({ root, outside }) => {
      symlinkSync(outside, join(root, 'link'))
      const { result, writeOverride } = await dispatchApplyPatch(
        { type: 'create_file', path: 'link/evil.txt', diff: '@@\n+content\n' },
        { projectRoot: root, cwd: root, canonicalize: fsRealpath },
      )

      expect(writeOverride).not.toHaveBeenCalled()
      expect(JSON.stringify(result.output)).toContain('outside project root')
    })
  })

  test('rejects a malformed patch with no target path', async () => {
    await withProject(async ({ root }) => {
      for (const operation of [{ type: 'create_file' }, undefined, { path: '' }]) {
        const { result, writeOverride } = await dispatchApplyPatch(operation, {
          projectRoot: root,
          cwd: root,
          canonicalize: fsRealpath,
        })

        expect(writeOverride).not.toHaveBeenCalled()
        expect(JSON.stringify(result.output)).toContain(
          'apply_patch target could not be verified',
        )
      }
    })
  })
})
