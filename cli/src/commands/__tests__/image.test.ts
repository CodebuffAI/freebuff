import { describe, test, expect } from 'bun:test'

import { parseImageCommandArgs } from '../parse-image-args'

describe('handleImageCommand parsing', () => {
  describe('argument parsing', () => {
    test('parses image path only', () => {
      const result = parseImageCommandArgs('./screenshot.png')
      expect(result.imagePath).toBe('./screenshot.png')
      expect(result.message).toBe('')
    })

    test('parses image path with message', () => {
      const result = parseImageCommandArgs(
        './screenshot.png please analyze this',
      )
      expect(result.imagePath).toBe('./screenshot.png')
      expect(result.message).toBe('please analyze this')
    })

    test('parses image path with multi-word message', () => {
      const result = parseImageCommandArgs(
        './image.jpg what is in this picture?',
      )
      expect(result.imagePath).toBe('./image.jpg')
      expect(result.message).toBe('what is in this picture?')
    })

    test('handles absolute paths with message', () => {
      const result = parseImageCommandArgs('/path/to/file.png describe the UI')
      expect(result.imagePath).toBe('/path/to/file.png')
      expect(result.message).toBe('describe the UI')
    })

    test('trims whitespace from input', () => {
      const result = parseImageCommandArgs('  ./image.png  ')
      expect(result.imagePath).toBe('./image.png')
      expect(result.message).toBe('')
    })

    test('handles multiple spaces between path and message', () => {
      const result = parseImageCommandArgs('./image.png    hello world')
      expect(result.imagePath).toBe('./image.png')
      expect(result.message).toBe('hello world')
    })

    test('handles double-quoted path with spaces and message', () => {
      const result = parseImageCommandArgs(
        '"Screenshot 2026-09-02 at 10.00.00.png" please analyze this',
      )
      expect(result.imagePath).toBe('Screenshot 2026-09-02 at 10.00.00.png')
      expect(result.message).toBe('please analyze this')
    })

    test('handles single-quoted path with spaces and message', () => {
      const result = parseImageCommandArgs(
        "'./Screenshots/My Capture.png' what is in this picture?",
      )
      expect(result.imagePath).toBe('./Screenshots/My Capture.png')
      expect(result.message).toBe('what is in this picture?')
    })

    test('handles quoted path only without message', () => {
      const result = parseImageCommandArgs('"my screenshot.png"')
      expect(result.imagePath).toBe('my screenshot.png')
      expect(result.message).toBe('')
    })

    test('handles backslash-escaped spaces in path', () => {
      const result = parseImageCommandArgs(
        './My\\ Screenshot.png check this out',
      )
      expect(result.imagePath).toBe('./My Screenshot.png')
      expect(result.message).toBe('check this out')
    })
  })

  describe('invalid input handling', () => {
    test('returns null imagePath for empty input', () => {
      const result = parseImageCommandArgs('')
      expect(result.imagePath).toBeNull()
      expect(result.message).toBe('')
    })

    test('returns null imagePath for whitespace-only input', () => {
      const result = parseImageCommandArgs('   ')
      expect(result.imagePath).toBeNull()
      expect(result.message).toBe('')
    })
  })

  describe('edge cases', () => {
    test('handles filenames with extensions', () => {
      const result = parseImageCommandArgs('image.jpeg')
      expect(result.imagePath).toBe('image.jpeg')
    })

    test('handles relative paths', () => {
      const result = parseImageCommandArgs('../screenshots/test.png')
      expect(result.imagePath).toBe('../screenshots/test.png')
    })

    test('handles tilde paths', () => {
      const result = parseImageCommandArgs('~/Downloads/image.png')
      expect(result.imagePath).toBe('~/Downloads/image.png')
    })

    test('handles empty quotes gracefully', () => {
      const result = parseImageCommandArgs('"" please analyze this')
      expect(result.imagePath).toBeNull()
      expect(result.message).toBe('please analyze this')
    })
  })
})
