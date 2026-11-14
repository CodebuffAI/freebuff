import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { Jimp } from 'jimp'

import { setProjectRoot } from '../../project-files'
import { calculateDisplaySize } from '../image-display'
import {
  MAX_IMAGE_BASE64_SIZE,
  MAX_IMAGE_FILE_SIZE,
  processImageFile,
} from '../image-handler'

// Mock the logger to prevent analytics initialization errors in tests
mock.module('../logger', () => ({
  logger: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    fatal: () => {},
  },
}))

/** A directory this run owns. It was a fixed `__dirname/temp-test-images`,
 *  which `afterEach` deletes recursively — so a second, overlapping run wiped
 *  the images this one was still reading (6 of 10 overlapped runs failed; solo
 *  always passed), and a crashed run left debris in the working tree. See
 *  docs/testing.md. */
let TEST_DIR: string

beforeEach(async () => {
  TEST_DIR = mkdtempSync(path.join(os.tmpdir(), 'cli-image-dimensions-'))
  // Create debug directory for logger
  mkdirSync(path.join(TEST_DIR, 'debug'), { recursive: true })

  // Set project root so logger doesn't throw
  setProjectRoot(TEST_DIR)

  // Create test images with known dimensions using Jimp
  // Wide image: 200x100 (2:1 aspect ratio)
  const wideImage = new Jimp({ width: 200, height: 100, color: 0xff0000ff })
  await wideImage.write(
    path.join(TEST_DIR, 'wide-200x100.png') as `${string}.${string}`,
  )

  // Tall image: 100x200 (1:2 aspect ratio)
  const tallImage = new Jimp({ width: 100, height: 200, color: 0x00ff00ff })
  await tallImage.write(
    path.join(TEST_DIR, 'tall-100x200.png') as `${string}.${string}`,
  )

  // Square image: 150x150 (1:1 aspect ratio)
  const squareImage = new Jimp({ width: 150, height: 150, color: 0x0000ffff })
  await squareImage.write(
    path.join(TEST_DIR, 'square-150x150.png') as `${string}.${string}`,
  )
})

afterEach(() => {
  try {
    rmSync(TEST_DIR, { recursive: true, force: true })
  } catch {
    // Ignore cleanup errors
  }
})

describe('Image Dimensions', () => {
  describe('processImageFile returns dimensions', () => {
    test('should return width and height for a wide image', async () => {
      // Use filename only since processImageFile resolves relative to cwd
      const result = await processImageFile('wide-200x100.png', TEST_DIR)

      expect(result.success).toBe(true)
      expect(result.imagePart).toBeDefined()
      expect(result.imagePart!.width).toBe(200)
      expect(result.imagePart!.height).toBe(100)
    })

    test('should return width and height for a tall image', async () => {
      const result = await processImageFile('tall-100x200.png', TEST_DIR)

      expect(result.success).toBe(true)
      expect(result.imagePart).toBeDefined()
      expect(result.imagePart!.width).toBe(100)
      expect(result.imagePart!.height).toBe(200)
    })

    test('should return width and height for a square image', async () => {
      const result = await processImageFile('square-150x150.png', TEST_DIR)

      expect(result.success).toBe(true)
      expect(result.imagePart).toBeDefined()
      expect(result.imagePart!.width).toBe(150)
      expect(result.imagePart!.height).toBe(150)
    })

    test('should return compressed dimensions when image is compressed', async () => {
      // Create a large image that will be compressed
      const largeImage = new Jimp({
        width: 2000,
        height: 1000,
        color: 0xff00ffff,
      })

      // Fill with varied data to make it less compressible (using unsigned values)
      for (let y = 0; y < 1000; y++) {
        for (let x = 0; x < 2000; x++) {
          const r = (x * y) % 256
          const g = (x + y) % 256
          const b = x % 256
          const a = 255
          // Jimp uses RGBA format as unsigned 32-bit: 0xRRGGBBAA
          const color = ((r << 24) | (g << 16) | (b << 8) | a) >>> 0
          largeImage.setPixelColor(color, x, y)
        }
      }
      await largeImage.write(
        path.join(TEST_DIR, 'large-2000x1000.png') as `${string}.${string}`,
      )

      const result = await processImageFile('large-2000x1000.png', TEST_DIR)

      expect(result.success).toBe(true)
      expect(result.imagePart).toBeDefined()
      // Dimensions should be defined even after compression
      expect(result.imagePart!.width).toBeDefined()
      expect(result.imagePart!.height).toBeDefined()
      // After compression, dimensions should be reduced
      if (result.wasCompressed) {
        expect(result.imagePart!.width).toBeLessThanOrEqual(1500) // Max dimension limit
        expect(result.imagePart!.height).toBeLessThanOrEqual(1500)
      }
    })
  })

  test('returns a clear error when an oversized image cannot be decoded for compression', async () => {
    const fileBuffer = Buffer.alloc(
      Math.ceil((MAX_IMAGE_BASE64_SIZE * 3) / 4) + 3,
      0xff,
    )
    fileBuffer.write('RIFF', 0)
    fileBuffer.write('WEBP', 8)
    writeFileSync(path.join(TEST_DIR, 'large.webp'), fileBuffer)

    expect(fileBuffer.toString('base64').length).toBeGreaterThan(
      MAX_IMAGE_BASE64_SIZE,
    )
    expect(fileBuffer.length).toBeLessThan(MAX_IMAGE_FILE_SIZE)

    const result = await processImageFile('large.webp', TEST_DIR)

    expect(result.success).toBe(false)
    expect(result.error).toContain('PNG or JPEG')
  })

  describe('calculateDisplaySize', () => {
    const CELL_ASPECT_RATIO = 2 // Terminal cells are ~2:1 height:width

    test('should scale wide image to fit available width while preserving aspect ratio', () => {
      const result = calculateDisplaySize({
        width: 200,
        height: 100,
        availableWidth: 80,
      })

      // With 200x100 image (2:1), scaling to fit 80 width
      // Display width should be reasonable portion of available
      expect(result.width).toBeLessThanOrEqual(80)
      expect(result.width).toBeGreaterThan(0)
      // Height adjusted for terminal cell aspect ratio
      expect(result.height).toBeGreaterThan(0)
    })

    test('should scale tall image appropriately', () => {
      const result = calculateDisplaySize({
        width: 100,
        height: 200,
        availableWidth: 80,
      })

      expect(result.width).toBeLessThanOrEqual(80)
      expect(result.width).toBeGreaterThan(0)
      expect(result.height).toBeGreaterThan(0)
      // Tall images should have larger height relative to width
      expect(result.height).toBeGreaterThanOrEqual(
        result.width / CELL_ASPECT_RATIO,
      )
    })

    test('should handle square images', () => {
      const result = calculateDisplaySize({
        width: 150,
        height: 150,
        availableWidth: 80,
      })

      expect(result.width).toBeLessThanOrEqual(80)
      expect(result.width).toBeGreaterThan(0)
      expect(result.height).toBeGreaterThan(0)
    })

    test('should use fallback when dimensions are not provided', () => {
      const result = calculateDisplaySize({
        availableWidth: 80,
      })

      // Fallback should still return reasonable values
      expect(result.width).toBeLessThanOrEqual(80)
      expect(result.width).toBeGreaterThan(0)
      expect(result.height).toBeGreaterThan(0)
    })

    test('should use fallback when width is 0', () => {
      const result = calculateDisplaySize({
        width: 0,
        height: 100,
        availableWidth: 80,
      })

      expect(result.width).toBeGreaterThan(0)
      expect(result.height).toBeGreaterThan(0)
    })

    test('should use fallback when height is 0', () => {
      const result = calculateDisplaySize({
        width: 100,
        height: 0,
        availableWidth: 80,
      })

      expect(result.width).toBeGreaterThan(0)
      expect(result.height).toBeGreaterThan(0)
    })

    test('should respect minimum display size', () => {
      const result = calculateDisplaySize({
        width: 1,
        height: 1,
        availableWidth: 80,
      })

      // Even tiny images should have at least 1 cell
      expect(result.width).toBeGreaterThanOrEqual(1)
      expect(result.height).toBeGreaterThanOrEqual(1)
    })

    test('should handle very wide available width', () => {
      const result = calculateDisplaySize({
        width: 100,
        height: 100,
        availableWidth: 200,
      })

      // Should not blow up image beyond reasonable size
      expect(result.width).toBeLessThanOrEqual(100) // Don't exceed original
      expect(result.height).toBeGreaterThan(0)
    })

    test('should handle narrow available width', () => {
      const result = calculateDisplaySize({
        width: 1000,
        height: 500,
        availableWidth: 20,
      })

      expect(result.width).toBeLessThanOrEqual(20)
      expect(result.height).toBeGreaterThan(0)
    })
  })
})
