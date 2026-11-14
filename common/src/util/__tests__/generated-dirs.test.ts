import { describe, expect, test } from 'bun:test'

import { isUnderGeneratedDir } from '../generated-dirs'

describe('isUnderGeneratedDir', () => {
  test('a path under a dependency or build folder, at any depth or separator', () => {
    for (const path of [
      'node_modules/react/index.js',
      'packages/app/node_modules/x/y.js',
      'dist/main.js',
      'web\\build\\out.css',
      '.next/cache/a',
    ])
      expect(isUnderGeneratedDir(path)).toBe(true)
  })

  test("the user's own files, including ones merely named like a folder", () => {
    for (const path of [
      'src/app.ts',
      'build',
      'scripts/build',
      'src/build-config.ts',
      'distribution/readme.md',
    ])
      expect(isUnderGeneratedDir(path)).toBe(false)
  })
})
