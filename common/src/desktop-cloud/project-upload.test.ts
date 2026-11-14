import { expect, test } from 'bun:test'
import {
  PROJECT_UPLOAD_BYTES,
  PROJECT_UPLOAD_FILES,
  projectUploadFiles,
  validateProjectUpload,
} from './project-upload'

test('folder contents preserve nesting and Unicode, excluding local metadata and dependencies', () => {
  const files = [
    'site/src/日本語.ts',
    'site/.env.example',
    'site/.git/config',
    'site/node_modules/a/index.js',
    'site/.freebuff/state',
  ].map((path) => {
    const file = new File(['hello'], path.split('/').at(-1)!)
    Object.defineProperty(file, 'webkitRelativePath', { value: path })
    return file
  })
  expect(projectUploadFiles(files).map(({ path }) => path)).toEqual([
    'src/日本語.ts',
    '.env.example',
  ])
  expect(projectUploadFiles([new File([], 'empty.txt')])[0]?.path).toBe(
    'empty.txt',
  )
})

test.each([
  '../escape',
  '/absolute',
  'a/../b',
  'a//b',
  'a\\b',
  'C:/file',
  '.git/config',
  'a/.FREEBUFF/state',
  'x\u0000y',
  '',
])('rejects unsafe path %j', (path) => {
  expect(() => validateProjectUpload([{ path, size: 0 }])).toThrow(
    'Unsupported file path',
  )
})

test('checks total size, file count, duplicates, and file/directory conflicts', () => {
  expect(() => validateProjectUpload([])).toThrow('at least one')
  expect(() =>
    validateProjectUpload([{ path: 'large', size: PROJECT_UPLOAD_BYTES + 1 }]),
  ).toThrow('100 MB')
  expect(() =>
    validateProjectUpload(
      Array.from({ length: PROJECT_UPLOAD_FILES + 1 }, (_, i) => ({
        path: `${i}`,
        size: 0,
      })),
    ),
  ).toThrow('4,000')
  expect(() =>
    validateProjectUpload([
      { path: 'a', size: 1 },
      { path: 'a', size: 0 },
    ]),
  ).toThrow('More than one')
  expect(() =>
    validateProjectUpload([
      { path: 'a/b', size: 1 },
      { path: 'a', size: 0 },
    ]),
  ).toThrow('file and folder')
  validateProjectUpload([
    { path: 'a/empty', size: 0 },
    { path: 'b', size: PROJECT_UPLOAD_BYTES },
  ])
})

test('accepts exactly 4,000 files and rejects 4,001', () => {
  const files = Array.from({ length: 4000 }, (_, index) => ({
    path: `src/file-${index}.txt`,
    size: 1,
  }))
  expect(() => validateProjectUpload(files)).not.toThrow()
  expect(() =>
    validateProjectUpload([...files, { path: 'extra.txt', size: 1 }]),
  ).toThrow('4,000')
})
