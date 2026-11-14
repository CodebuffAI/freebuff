import { afterEach, beforeEach, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { FILE_READ_STATUS } from '@codebuff/common/old-constants'
import {
  getAllFilePaths,
  getProjectFileTree,
} from '@codebuff/common/project-file-tree'

import { getFiles, getImageFile } from '../tools/read-files'

let cwd: string
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5VQAAAAASUVORK5CYII=',
  'base64',
)

beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'explicit-file-reads-'))
  const files = {
    '.gitignore': 'sandbox/\nartifacts/\n.env.example\n',
    '.codebuffignore': 'private/\n',
    '.manicodeignore': 'legacy-private/\n',
    'sandbox/note.txt': 'requested artifact',
    'artifacts/render.png': png,
    'node_modules/example/index.js': 'dependency source',
    'private/note.txt': 'excluded text',
    'private/render.png': png,
    'legacy-private/note.txt': 'legacy excluded text',
    '.env': 'sensitive fixture',
    '.env.example': 'ignored template fixture',
    '.env.sample': 'public template fixture',
    '.env.png': png,
  }
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(cwd, name)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, content)
  }
})

afterEach(async () => {
  await fs.rm(cwd, { recursive: true, force: true })
})

test('explicit text and image reads succeed while discovery still excludes ignored artifacts', async () => {
  for (const absolute of [false, true]) {
    const input = (name: string) => (absolute ? path.join(cwd, name) : name)
    expect(
      await getFiles({
        cwd,
        fs,
        filePaths: [
          input('sandbox/note.txt'),
          input('node_modules/example/index.js'),
        ],
      }),
    ).toEqual({
      'sandbox/note.txt': 'requested artifact',
      'node_modules/example/index.js': 'dependency source',
    })
    expect(
      await getImageFile({ cwd, fs, filePath: input('artifacts/render.png') }),
    ).toEqual({
      path: 'artifacts/render.png',
      data: png.toString('base64'),
      mediaType: 'image/png',
      bytes: png.length,
    })
  }
  const discovered = getAllFilePaths(
    await getProjectFileTree({ projectRoot: cwd, fs }),
  )
  expect(discovered).not.toContain(path.join('sandbox', 'note.txt'))
  expect(discovered).not.toContain(path.join('artifacts', 'render.png'))
  expect(discovered).not.toContain(path.join('node_modules', 'example', 'index.js'))
})

test('explicit reads retain agent ignore files, including nested rules', async () => {
  await fs.writeFile(path.join(cwd, 'sandbox/.codebuffignore'), 'note.txt\n')
  expect(
    await getFiles({
      cwd,
      fs,
      filePaths: ['sandbox/note.txt', 'private/note.txt', 'legacy-private/note.txt'],
    }),
  ).toEqual({
    'sandbox/note.txt': FILE_READ_STATUS.IGNORED,
    'private/note.txt': FILE_READ_STATUS.IGNORED,
    'legacy-private/note.txt': FILE_READ_STATUS.IGNORED,
  })
  expect(await getImageFile({ cwd, fs, filePath: 'private/render.png' })).toEqual({
    path: 'private/render.png',
    error: FILE_READ_STATUS.IGNORED,
  })
})

test('sensitive env files and ignored env templates stay blocked, including image-shaped env names', async () => {
  expect(
    await getFiles({
      cwd,
      fs,
      filePaths: ['.env', '.env.example', '.env.sample'],
    }),
  ).toEqual({
    '.env': FILE_READ_STATUS.IGNORED,
    '.env.example': FILE_READ_STATUS.IGNORED,
    '.env.sample': `${FILE_READ_STATUS.TEMPLATE}\npublic template fixture`,
  })
  expect(await getImageFile({ cwd, fs, filePath: '.env.png' })).toEqual({
    path: '.env.png',
    error: FILE_READ_STATUS.IGNORED,
  })
})

test('background project understanding still refuses gitignored text', async () => {
  expect(
    await getFiles({
      cwd,
      fs,
      filePaths: ['sandbox/note.txt'],
      refuseNonText: true,
    }),
  ).toEqual({
    'sandbox/note.txt': FILE_READ_STATUS.IGNORED,
  })
})
