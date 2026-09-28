import { describe, expect, it } from 'bun:test'
import { applyPatch } from 'diff'

import { processStrReplace } from '../process-str-replace'

import type { Logger } from '@codebuff/common/types/contracts/logger'

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

describe('processStrReplace', () => {
  it('should replace exact string matches', async () => {
    const initialContent = 'const x = 1;\nconst y = 2;\n'
    const oldStr = 'const y = 2;'
    const newStr = 'const y = 3;'

    const result = await processStrReplace({
      path: 'test.ts',
      replacements: [
        { oldString: oldStr, newString: newStr, allowMultiple: false },
      ],
      initialContentPromise: Promise.resolve(initialContent),
      logger,
    })

    expect(result).not.toBeNull()
    expect('content' in result).toBe(true)
    if ('content' in result) {
      expect(result.content).toBe('const x = 1;\nconst y = 3;\n')
      expect(result.path).toBe('test.ts')
      expect(result.tool).toBe('str_replace')
    }
  })

  it('should handle Windows line endings', async () => {
    const initialContent = 'const x = 1;\r\nconst y = 2;\r\n'
    const oldStr = 'const y = 2;\r\n'
    const newStr = 'const y = 3;\r\n'

    const result = await processStrReplace({
      path: 'test.ts',
      replacements: [
        { oldString: oldStr, newString: newStr, allowMultiple: false },
      ],
      initialContentPromise: Promise.resolve(initialContent),
      logger,
    })

    expect(result).not.toBeNull()
    expect('content' in result).toBe(true)
    if ('content' in result) {
      expect(result.content).toBe('const x = 1;\r\nconst y = 3;\r\n')
      expect(result.patch).toContain('\r\n')
    }
  })

  it('should handle indentation differences', async () => {
    const initialContent = '  const x = 1;\n    const y = 2;\n'
    const oldStr = 'const y = 2;'
    const newStr = 'const y = 3;'

    const result = await processStrReplace({
      path: 'test.ts',
      replacements: [
        { oldString: oldStr, newString: newStr, allowMultiple: false },
      ],
      initialContentPromise: Promise.resolve(initialContent),
      logger,
    })

    expect(result).not.toBeNull()
    expect('content' in result).toBe(true)
    if ('content' in result) {
      expect(result.content).toBe('  const x = 1;\n    const y = 3;\n')
    }
  })

  it('should handle whitespace-only differences', async () => {
    const initialContent = 'const x = 1;\nconst  y  =  2;\n'
    const oldStr = 'const  y  =  2;'
    const newStr = 'const y = 3;'

    const result = await processStrReplace({
      path: 'test.ts',
      replacements: [
        { oldString: oldStr, newString: newStr, allowMultiple: false },
      ],
      initialContentPromise: Promise.resolve(initialContent),
      logger,
    })

    expect(result).not.toBeNull()
    expect('content' in result).toBe(true)
    if ('content' in result) {
      expect(result.content).toBe('const x = 1;\nconst y = 3;\n')
    }
  })

  it('should return error if file content is null and oldStr is not empty', async () => {
    const result = await processStrReplace({
      path: 'test.ts',
      replacements: [
        { oldString: 'old', newString: 'new', allowMultiple: false },
      ],
      initialContentPromise: Promise.resolve(null),
      logger,
    })

    expect(result).not.toBeNull()
    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.error).toContain('file does not exist')
    }
  })

  it('should return error if oldStr is empty and file exists', async () => {
    const result = await processStrReplace({
      path: 'test.ts',
      replacements: [{ oldString: '', newString: 'new', allowMultiple: false }],
      initialContentPromise: Promise.resolve('content'),
      logger,
    })

    expect(result).not.toBeNull()
    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.error).toContain('old string was empty')
    }
  })

  it('should return error if no changes were made', async () => {
    const initialContent = 'const x = 1;\nconst y = 2;\n'
    const oldStr = 'const z = 3;' // This string doesn't exist in the content
    const newStr = 'const z = 4;'

    const result = await processStrReplace({
      path: 'test.ts',
      replacements: [
        { oldString: oldStr, newString: newStr, allowMultiple: false },
      ],
      initialContentPromise: Promise.resolve(initialContent),
      logger,
    })

    expect(result).not.toBeNull()
    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.error).toContain(
        'The old string "const z = 3;" was not found',
      )
    }
  })

  it('should handle multiple occurrences of the same string with allowMultiple: true', async () => {
    const initialContent = 'const x = 1;\nconst x = 2;\nconst x = 3;\n'
    const oldStr = 'const x'
    const newStr = 'let x'

    const result = await processStrReplace({
      path: 'test.ts',
      replacements: [
        { oldString: oldStr, newString: newStr, allowMultiple: true },
      ],
      initialContentPromise: Promise.resolve(initialContent),
      logger,
    })

    expect(result).not.toBeNull()
    expect('content' in result).toBe(true)
    if ('content' in result) {
      expect(result.content).toBe('let x = 1;\nlet x = 2;\nlet x = 3;\n')
    }
  })

  it('should generate a valid patch', async () => {
    const initialContent = 'const x = 1;\nconst y = 2;\n'
    const oldStr = 'const y = 2;'
    const newStr = 'const y = 3;'

    const result = await processStrReplace({
      path: 'test.ts',
      replacements: [
        { oldString: oldStr, newString: newStr, allowMultiple: false },
      ],
      initialContentPromise: Promise.resolve(initialContent),
      logger,
    })

    expect(result).not.toBeNull()
    expect('content' in result).toBe(true)
    if ('content' in result) {
      const patch = result.patch
      expect(patch).toBeDefined()
      expect(patch).toContain('-const y = 2;')
      expect(patch).toContain('+const y = 3;')
    }
  })

  it('should handle special characters in strings', async () => {
    const initialContent = 'const x = "hello & world";\nconst y = "<div>";\n'
    const oldStr = 'const y = "<div>";'
    const newStr = 'const y = "<span>";'

    const result = await processStrReplace({
      path: 'test.ts',
      replacements: [
        { oldString: oldStr, newString: newStr, allowMultiple: false },
      ],
      initialContentPromise: Promise.resolve(initialContent),
      logger,
    })

    expect(result).not.toBeNull()
    expect('content' in result).toBe(true)
    if ('content' in result) {
      expect(result.content).toBe(
        'const x = "hello & world";\nconst y = "<span>";\n',
      )
    }
  })

  it('should continue processing other replacements even if one fails', async () => {
    const initialContent = 'const x = 1;\nconst y = 2;\nconst z = 3;\n'
    const replacements = [
      {
        oldString: 'const x = 1;',
        newString: 'const x = 10;',
        allowMultiple: false,
      }, // This exists
      {
        oldString: 'const w = 4;',
        newString: 'const w = 40;',
        allowMultiple: false,
      }, // This doesn't exist
      {
        oldString: 'const z = 3;',
        newString: 'const z = 30;',
        allowMultiple: false,
      }, // This also exists
    ]

    const result = await processStrReplace({
      path: 'test.ts',
      replacements,
      initialContentPromise: Promise.resolve(initialContent),
      logger,
    })

    expect(result).not.toBeNull()
    expect('content' in result).toBe(true)
    if ('content' in result) {
      // Should have applied the successful replacements
      expect(result.content).toBe(
        'const x = 10;\nconst y = 2;\nconst z = 30;\n',
      )
      expect(result.messages).toContain(
        'The old string "const w = 4;" was not found in the file, skipping. Please try again with a different old string that matches the file content exactly.',
      )
    }
  })

  // New comprehensive tests for allowMultiple functionality
  describe('allowMultiple functionality', () => {
    it('should error when multiple occurrences exist and allowMultiple is false', async () => {
      const initialContent = 'const x = 1;\nconst x = 2;\nconst x = 3;\n'
      const oldStr = 'const x'
      const newStr = 'let x'

      const result = await processStrReplace({
        path: 'test.ts',
        replacements: [
          { oldString: oldStr, newString: newStr, allowMultiple: false },
        ],
        initialContentPromise: Promise.resolve(initialContent),
        logger,
      })

      expect(result).not.toBeNull()
      expect('error' in result).toBe(true)
      if ('error' in result) {
        expect(result.error).toContain('Found 3 occurrences')
        expect(result.error).toContain('set allowMultiple to true')
      }
    })

    it('should replace all occurrences when allowMultiple is true', async () => {
      const initialContent = 'foo bar foo baz foo'
      const oldStr = 'foo'
      const newStr = 'FOO'

      const result = await processStrReplace({
        path: 'test.ts',
        replacements: [
          { oldString: oldStr, newString: newStr, allowMultiple: true },
        ],
        initialContentPromise: Promise.resolve(initialContent),
        logger,
      })

      expect(result).not.toBeNull()
      expect('content' in result).toBe(true)
      if ('content' in result) {
        expect(result.content).toBe('FOO bar FOO baz FOO')
      }
    })

    it('should handle single occurrence with allowMultiple: true', async () => {
      const initialContent = 'const x = 1;\nconst y = 2;\n'
      const oldStr = 'const y = 2;'
      const newStr = 'const y = 3;'

      const result = await processStrReplace({
        path: 'test.ts',
        replacements: [
          { oldString: oldStr, newString: newStr, allowMultiple: true },
        ],
        initialContentPromise: Promise.resolve(initialContent),
        logger,
      })

      expect(result).not.toBeNull()
      expect('content' in result).toBe(true)
      if ('content' in result) {
        expect(result.content).toBe('const x = 1;\nconst y = 3;\n')
      }
    })

    it('should handle mixed allowMultiple settings in multiple replacements', async () => {
      const initialContent = 'foo bar foo\nbaz baz baz\nqux qux'
      const replacements = [
        { oldString: 'foo', newString: 'FOO', allowMultiple: true }, // Replace all 'foo'
        { oldString: 'baz', newString: 'BAZ', allowMultiple: false }, // Should error on multiple 'baz'
        { oldString: 'qux qux', newString: 'QUX', allowMultiple: false }, // Single occurrence, should work
      ]

      const result = await processStrReplace({
        path: 'test.ts',
        replacements,
        initialContentPromise: Promise.resolve(initialContent),
        logger,
      })

      expect(result).not.toBeNull()
      expect('content' in result).toBe(true)
      if ('content' in result) {
        // Should have applied foo->FOO and qux qux->QUX, but not baz->BAZ

        expect(result.content).toBe('FOO bar FOO\nbaz baz baz\nQUX')
        expect(result.messages).toHaveLength(1)
        expect(result.messages[0]).toContain('Found 3 occurrences of "baz"')
        expect(result.messages[0]).toContain('set allowMultiple to true')
      }
    })

    it('should replace multiple lines with allowMultiple: true', async () => {
      const initialContent = `function test() {
  console.log('debug');
}
function test2() {
  console.log('debug');
}
function test3() {
  console.log('info');
}`
      const oldStr = "console.log('debug');"
      const newStr = '// removed debug log'

      const result = await processStrReplace({
        path: 'test.ts',
        replacements: [
          { oldString: oldStr, newString: newStr, allowMultiple: true },
        ],
        initialContentPromise: Promise.resolve(initialContent),
        logger,
      })

      expect(result).not.toBeNull()
      expect('content' in result).toBe(true)
      if ('content' in result) {
        expect(result.content).toContain('// removed debug log')
        // Should have replaced both debug logs but not the info log
        expect((result.content.match(/removed debug log/g) || []).length).toBe(
          2,
        )
        expect(result.content).toContain("console.log('info');")
      }
    })

    it('should handle empty new string with allowMultiple: true (deletion)', async () => {
      const initialContent = 'remove this, keep this, remove this, keep this'
      const oldStr = 'remove this, '
      const newStr = ''

      const result = await processStrReplace({
        path: 'test.ts',
        replacements: [
          { oldString: oldStr, newString: newStr, allowMultiple: true },
        ],
        initialContentPromise: Promise.resolve(initialContent),
        logger,
      })

      expect(result).not.toBeNull()
      expect('content' in result).toBe(true)
      if ('content' in result) {
        expect(result.content).toBe('keep this, keep this')
      }
    })

    it('should handle allowMultiple with indentation matching', async () => {
      const initialContent = `  if (condition) {
    doSomething();
  }
  if (condition) {
    doSomething();
  }`
      const oldStr = 'doSomething();'
      const newStr = 'doSomethingElse();'

      const result = await processStrReplace({
        path: 'test.ts',
        replacements: [
          { oldString: oldStr, newString: newStr, allowMultiple: true },
        ],
        initialContentPromise: Promise.resolve(initialContent),
        logger,
      })

      expect(result).not.toBeNull()
      expect('content' in result).toBe(true)
      if ('content' in result) {
        expect(result.content).toContain('doSomethingElse();')
        expect((result.content.match(/doSomethingElse/g) || []).length).toBe(2)
      }
    })

    it('should handle zero occurrences with allowMultiple: true', async () => {
      const initialContent = 'const x = 1;\nconst y = 2;\n'
      const oldStr = 'const z = 3;' // This string doesn't exist
      const newStr = 'const z = 4;'

      const result = await processStrReplace({
        path: 'test.ts',
        replacements: [
          { oldString: oldStr, newString: newStr, allowMultiple: true },
        ],
        initialContentPromise: Promise.resolve(initialContent),
        logger,
      })

      expect(result).not.toBeNull()
      expect('error' in result).toBe(true)
      if ('error' in result) {
        expect(result.error).toContain(
          'The old string "const z = 3;" was not found',
        )
      }
    })
  })

  it('should handle applying multiple replacements on nearby lines', async () => {
    const initialContent = 'line 1\nline 2\nline 3\n'
    const replacements = [
      {
        oldString: 'line 2\n',
        newString: 'this is a new line\n',
        allowMultiple: false,
      },
      {
        oldString: 'line 3\n',
        newString: 'new line 3\n',
        allowMultiple: false,
      },
    ]

    const result = await processStrReplace({
      path: 'test.ts',
      replacements,
      initialContentPromise: Promise.resolve(initialContent),
      logger,
    })

    expect('content' in result).toBe(true)
    const successResult = result as { content: string; patch: string }
    expect(applyPatch(initialContent, successResult.patch)).toBe(
      'line 1\nthis is a new line\nnew line 3\n',
    )
  })

  it('should handle double dollar signs correctly', async () => {
    const initialContent = 'line 1\nhello $world!\nline 2\n'
    const oldStr = 'hello $world!\n'
    const newStr = 'hello $$world!\n'

    const result = await processStrReplace({
      path: 'test.ts',
      replacements: [
        { oldString: oldStr, newString: newStr, allowMultiple: false },
      ],
      initialContentPromise: Promise.resolve(initialContent),
      logger,
    })

    expect(result).not.toBeNull()
    const successResult = result as { content: string }
    expect(successResult.content).toBe('line 1\nhello $$world!\nline 2\n')
  })

  describe('whitespace-only oldString that is absent from the file', () => {
    // Regression: the whitespace-insensitive last-resort match collapsed a
    // whitespace-only oldString to '', and `indexOf('')` vacuously succeeded
    // at position 0. The resulting empty match made replaceAll insert the new
    // string between EVERY character of the file — and the tool reported
    // success. The file must be left untouched with a not-found error instead.
    const cases = [
      { name: 'a space', oldString: ' ' },
      { name: 'tabs', oldString: '\t\t' },
      { name: 'newlines', oldString: '\n\n' },
      { name: 'mixed whitespace', oldString: ' \t\n ' },
    ]

    for (const { name, oldString } of cases) {
      it(`does not corrupt the file for ${name}`, async () => {
        const initialContent = 'a\tb\nc\td\n'

        const result = await processStrReplace({
          path: 'test.ts',
          replacements: [
            { oldString, newString: 'X', allowMultiple: false },
          ],
          initialContentPromise: Promise.resolve(initialContent),
          logger,
        })

        expect('error' in result).toBe(true)
        if ('error' in result) {
          expect(result.error).toContain('was not found')
        }
      })
    }

    it('reports the not-found error even when the file is entirely whitespace', async () => {
      // Whitespace-only file and whitespace-only old string collapse to the
      // same empty search — which must still be a not-found, not a vacuous
      // match. ('\t\t' is absent: the file only has a single tab.)
      const result = await processStrReplace({
        path: 'test.ts',
        replacements: [
          { oldString: '\t\t', newString: 'X', allowMultiple: false },
        ],
        initialContentPromise: Promise.resolve(' \n\t\n'),
        logger,
      })

      expect('error' in result).toBe(true)
      if ('error' in result) {
        expect(result.error).toContain('was not found')
      }
    })

    it('still replaces whitespace-only old strings that exist in the file', async () => {
      // count === 1 exact match: a whitespace-only old string found verbatim
      // must keep working through the exact-match branch, not the fallback.
      const result = await processStrReplace({
        path: 'test.ts',
        replacements: [
          { oldString: ' ', newString: '_', allowMultiple: false },
        ],
        initialContentPromise: Promise.resolve('a b\n'),
        logger,
      })

      expect('content' in result).toBe(true)
      if ('content' in result) {
        expect(result.content).toBe('a_b\n')
      }
    })

    it('still replaces all whitespace occurrences with allowMultiple: true', async () => {
      const result = await processStrReplace({
        path: 'test.ts',
        replacements: [
          { oldString: '\t', newString: '  ', allowMultiple: true },
        ],
        initialContentPromise: Promise.resolve('a\tb\tc\n'),
        logger,
      })

      expect('content' in result).toBe(true)
      if ('content' in result) {
        expect(result.content).toBe('a  b  c\n')
      }
    })

    it('lets later replacements proceed after a failed whitespace-only one', async () => {
      // File deliberately contains no spaces so the whitespace-only pair
      // takes the not-found path instead of matching anything.
      const initialContent = 'aaa\nbbb\n'
      const result = await processStrReplace({
        path: 'test.ts',
        replacements: [
          { oldString: ' ', newString: 'X', allowMultiple: false },
          { oldString: 'aaa', newString: 'ccc', allowMultiple: false },
        ],
        initialContentPromise: Promise.resolve(initialContent),
        logger,
      })

      expect('content' in result).toBe(true)
      if ('content' in result) {
        expect(result.content).toBe('ccc\nbbb\n')
      }
      expect('messages' in result && result.messages).toContain(
        'The old string " " was not found in the file, skipping. Please try again with a different old string that matches the file content exactly.',
      )
    })

    it('keeps whitespace-insensitive matching working for non-empty anchors', async () => {
      // Guard the fix from over-correcting: the fallback must still fire when
      // the old string genuinely has non-whitespace content whose whitespace
      // differs from the file.
      const initialContent = 'function foo() {\n\treturn 1;\n}\n'
      const result = await processStrReplace({
        path: 'test.ts',
        replacements: [
          {
            oldString: 'function foo() {\n  return 1;\n}',
            newString: 'function foo() {\n\treturn 2;\n}',
            allowMultiple: false,
          },
        ],
        initialContentPromise: Promise.resolve(initialContent),
        logger,
      })

      expect('content' in result).toBe(true)
      if ('content' in result) {
        expect(result.content).toBe('function foo() {\n\treturn 2;\n}\n')
      }
    })
  })
})
