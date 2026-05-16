import { describe, test, expect } from 'bun:test'

import { getFingerprintType, generateFingerprintIdSync } from '../fingerprint'

describe('fingerprint utilities', () => {
  describe('getFingerprintType', () => {
    describe('enhanced fingerprints', () => {
      test('should detect enhanced- prefix as enhanced_cli', () => {
        expect(getFingerprintType('enhanced-abc123')).toBe('enhanced_cli')
      })

      test('should detect enhanced fingerprint with full hash', () => {
        const fullHash = 'enhanced-Ks7mN2pQxR3vW5yZ8aB4cD6eF9gH1iJ2kL4mN5oP7qR8sT0uV1wX3yZ'
        expect(getFingerprintType(fullHash)).toBe('enhanced_cli')
      })

      test('should detect enhanced- prefix with empty suffix', () => {
        expect(getFingerprintType('enhanced-')).toBe('enhanced_cli')
      })
    })

    describe('legacy fingerprints', () => {
      test('should detect codebuff-cli- prefix as legacy', () => {
        expect(getFingerprintType('codebuff-cli-abc12345')).toBe('legacy')
      })

      test('should detect legacy- prefix as legacy', () => {
        expect(getFingerprintType('legacy-abc123-xyz789')).toBe('legacy')
      })

      test('should detect codebuff-cli- prefix with any suffix', () => {
        expect(getFingerprintType('codebuff-cli-')).toBe('legacy')
        expect(getFingerprintType('codebuff-cli-randomsuffix')).toBe('legacy')
        expect(getFingerprintType('codebuff-cli-12345678')).toBe('legacy')
      })

      test('should detect legacy- prefix with any suffix', () => {
        expect(getFingerprintType('legacy-')).toBe('legacy')
        expect(getFingerprintType('legacy-hash-suffix')).toBe('legacy')
      })
    })

    describe('unknown fingerprints', () => {
      test('should return unknown for empty string', () => {
        expect(getFingerprintType('')).toBe('unknown')
      })

      test('should return unknown for unrecognized prefix', () => {
        expect(getFingerprintType('unknown-prefix-123')).toBe('unknown')
      })

      test('should return unknown for partial matches', () => {
        // Should not match if prefix is incomplete
        expect(getFingerprintType('enhance-abc123')).toBe('unknown')
        expect(getFingerprintType('codebuff-abc123')).toBe('unknown')
        expect(getFingerprintType('lega-abc123')).toBe('unknown')
      })

      test('should return unknown for SDK fingerprints', () => {
        expect(getFingerprintType('codebuff-sdk-abc123')).toBe('unknown')
      })

      test('should return unknown for random strings', () => {
        expect(getFingerprintType('random-string')).toBe('unknown')
        expect(getFingerprintType('abc123')).toBe('unknown')
        expect(getFingerprintType('fingerprint')).toBe('unknown')
      })

      test('should be case-sensitive', () => {
        expect(getFingerprintType('Enhanced-abc123')).toBe('unknown')
        expect(getFingerprintType('ENHANCED-abc123')).toBe('unknown')
        expect(getFingerprintType('Codebuff-cli-abc123')).toBe('unknown')
        expect(getFingerprintType('LEGACY-abc123')).toBe('unknown')
      })
    })
  })

  describe('generateFingerprintIdSync', () => {
    describe('format validation', () => {
      test('should return string starting with codebuff-cli-', () => {
        const fingerprint = generateFingerprintIdSync()
        expect(fingerprint.startsWith('codebuff-cli-')).toBe(true)
      })

      test('should return fingerprint of expected length', () => {
        const fingerprint = generateFingerprintIdSync()
        // Format: codebuff-cli- (13 chars) + 8 random chars = 21 chars
        expect(fingerprint.length).toBe(21)
      })

      test('should contain only valid base64url characters in suffix', () => {
        const fingerprint = generateFingerprintIdSync()
        const suffix = fingerprint.replace('codebuff-cli-', '')
        // base64url alphabet: A-Z, a-z, 0-9, -, _
        const base64urlPattern = /^[A-Za-z0-9_-]+$/
        expect(base64urlPattern.test(suffix)).toBe(true)
      })

      test('should have exactly 8 characters in the random suffix', () => {
        const fingerprint = generateFingerprintIdSync()
        const suffix = fingerprint.replace('codebuff-cli-', '')
        expect(suffix.length).toBe(8)
      })
    })

    describe('uniqueness', () => {
      test('should generate unique fingerprints across multiple calls', () => {
        const fingerprints = new Set<string>()
        const iterations = 100

        for (let i = 0; i < iterations; i++) {
          fingerprints.add(generateFingerprintIdSync())
        }

        // All fingerprints should be unique
        expect(fingerprints.size).toBe(iterations)
      })

      test('should generate different fingerprints on consecutive calls', () => {
        const first = generateFingerprintIdSync()
        const second = generateFingerprintIdSync()
        const third = generateFingerprintIdSync()

        expect(first).not.toBe(second)
        expect(second).not.toBe(third)
        expect(first).not.toBe(third)
      })
    })

    describe('type detection integration', () => {
      test('should be detected as legacy by getFingerprintType', () => {
        const fingerprint = generateFingerprintIdSync()
        expect(getFingerprintType(fingerprint)).toBe('legacy')
      })

      test('multiple generated fingerprints should all be detected as legacy', () => {
        for (let i = 0; i < 10; i++) {
          const fingerprint = generateFingerprintIdSync()
          expect(getFingerprintType(fingerprint)).toBe('legacy')
        }
      })
    })
  })

})
