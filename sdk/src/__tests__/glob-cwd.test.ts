import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

import { expect, it } from 'bun:test'

import { glob } from '../tools/glob'

// A false empty glob result hides existing project files from the agent.
// Exercise the real project scan: equivalent relative cwd paths must find them.
it('finds the same files for equivalent relative working directories', async () => {
  const tempRoot = path.resolve(tmpdir())
  const projectPath = await fs.mkdtemp(
    path.join(tempRoot, 'freebuff-glob-cwd-'),
  )
  try {
    const files = ['root.ts', 'src/a.ts', 'src/nested/b.ts', 'src-other/c.ts']
    for (const file of files) {
      const fullPath = path.join(projectPath, file)
      await fs.mkdir(path.dirname(fullPath), { recursive: true })
      await fs.writeFile(fullPath, '')
    }
    const inSrc = ['src/a.ts', 'src/nested/b.ts']
    const cases: [string, string[]][] = [
      ['.', files],
      ['./', files],
      ['./src', inSrc],
      ['src/../src/', inSrc],
      [path.join('src', 'nested', '..'), inSrc],
    ]
    for (const [cwd, expected] of cases) {
      const [output] = await glob({
        pattern: '**/*.ts',
        projectPath,
        cwd,
        fs,
      })
      const value = output.value as { files: string[]; count: number }
      expect(value.count).toBe(expected.length)
      expect(value.files.sort()).toEqual([...expected].sort())
    }
  } finally {
    if (path.dirname(projectPath) !== tempRoot)
      throw new Error('Invalid fixture path')
    await fs.rm(projectPath, { recursive: true, force: true })
  }
})
