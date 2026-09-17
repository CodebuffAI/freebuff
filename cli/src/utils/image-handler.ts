import { readFileSync, statSync } from 'fs'
import { homedir } from 'os'
import path from 'path'

import {
  SUPPORTED_IMAGE_EXTENSIONS,
  MAX_IMAGE_FILE_SIZE,
  MAX_IMAGE_BASE64_SIZE,
  MAX_TOTAL_IMAGE_SIZE,
  IMAGE_EXTENSIONS_PATTERN,
  getImageMimeType,
  isProviderSupportedImageMediaType,
} from '@codebuff/common/constants/images'
import { Jimp } from 'jimp'

import { logger } from './logger'

// Re-export all image constants for backwards compatibility
export * from '@codebuff/common/constants/images'

export interface ImageUploadResult {
  success: boolean
  imagePart?: {
    type: 'image'
    image: string // base64
    mediaType: string
    filename?: string
    size?: number
    width?: number
    height?: number
  }
  error?: string
  wasCompressed?: boolean
}

interface CompressionResult {
  success: boolean
  buffer?: Buffer
  base64?: string
  mediaType?: string
  width?: number
  height?: number
  error?: string
}

// Compression settings for iterative compression
const COMPRESSION_QUALITIES = [85, 70, 50, 30]
const DIMENSION_LIMITS = [1500, 1200, 800, 600]

/**
 * Validates total size of multiple images
 */
export function validateTotalImageSize(imageParts: Array<{ size?: number }>): {
  valid: boolean
  error?: string
} {
  const totalSize = imageParts.reduce((sum, part) => sum + (part.size || 0), 0)

  if (totalSize > MAX_TOTAL_IMAGE_SIZE) {
    const totalMB = (totalSize / (1024 * 1024)).toFixed(1)
    const maxMB = (MAX_TOTAL_IMAGE_SIZE / (1024 * 1024)).toFixed(1)
    return {
      valid: false,
      error: `Total image size too large: ${totalMB}MB (max ${maxMB}MB)`,
    }
  }

  return { valid: true }
}

/**
 * Normalizes a user-provided file path by handling escape sequences.
 */
function normalizeUserProvidedPath(filePath: string): string {
  let normalized = filePath

  // Handle unicode escape sequences (e.g., from terminal copy/paste)
  normalized = normalized.replace(/\\u\{([0-9a-fA-F]+)\}|\\u([0-9a-fA-F]{4})/g, (_, bracedCode, shortCode) => {
    const code = bracedCode || shortCode
    const value = Number.parseInt(code, 16)
    return Number.isNaN(value) ? _ : String.fromCodePoint(value)
  })

  // Handle shell-escaped special characters (e.g., spaces in paths)
  normalized = normalized.replace(/\\([ \t"'(){}\[\]])/g, '$1')

  return normalized
}

/**
 * Validates if a file path is a supported image
 */
export function isImageFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase()
  return SUPPORTED_IMAGE_EXTENSIONS.has(ext)
}

/**
 * Resolves a file path, handling ~, relative paths, etc.
 */
export function resolveFilePath(filePath: string, cwd: string): string {
  const normalized = normalizeUserProvidedPath(filePath)
  if (normalized.startsWith('~')) {
    return path.join(homedir(), normalized.slice(1))
  }
  if (path.isAbsolute(normalized)) {
    return normalized
  }
  return path.resolve(cwd, normalized)
}

/**
 * Attempts to compress an image to fit within the max base64 size.
 * Tries different dimension/quality combinations until one fits.
 */
async function compressImageToFitSize(fileBuffer: Buffer): Promise<CompressionResult> {
  const image = await Jimp.read(fileBuffer)
  const originalWidth = image.bitmap.width
  const originalHeight = image.bitmap.height

  let bestBase64Size = Infinity
  let attemptCount = 0

  for (const maxDimension of DIMENSION_LIMITS) {
    for (const quality of COMPRESSION_QUALITIES) {
      attemptCount++
      
      const testImage = await Jimp.read(fileBuffer)

      // Resize if needed (preserve aspect ratio)
      if (originalWidth > maxDimension || originalHeight > maxDimension) {
        if (originalWidth > originalHeight) {
          testImage.resize({ w: maxDimension })
        } else {
          testImage.resize({ h: maxDimension })
        }
      }

      const testBuffer = await testImage.getBuffer('image/jpeg', { quality })
      const testBase64 = testBuffer.toString('base64')
      const testBase64Size = testBase64.length

      // Track best attempt
      if (testBase64Size < bestBase64Size) {
        bestBase64Size = testBase64Size
      }

      // If this attempt fits, use it
      if (testBase64Size <= MAX_IMAGE_BASE64_SIZE) {
        logger.debug(
          {
            originalSize: fileBuffer.length,
            finalSize: testBuffer.length,
            finalDimensions: `${testImage.bitmap.width}x${testImage.bitmap.height}`,
            quality,
            attempts: attemptCount,
          },
          'Image handler: Successful compression found',
        )

        return {
          success: true,
          buffer: testBuffer,
          base64: testBase64,
          mediaType: 'image/jpeg',
          width: testImage.bitmap.width,
          height: testImage.bitmap.height,
        }
      }
    }
  }

  // No compression attempt succeeded
  const bestSizeKB = (bestBase64Size / 1024).toFixed(1)
  const maxKB = (MAX_IMAGE_BASE64_SIZE / 1024).toFixed(1)
  const originalKB = (fileBuffer.toString('base64').length / 1024).toFixed(1)

  return {
    success: false,
    error: `Image too large even after ${attemptCount} compression attempts. Original: ${originalKB}KB, best compressed: ${bestSizeKB}KB (max ${maxKB}KB). Try using a smaller image.`,
  }
}

/**
 * Processes an image file and converts it to base64 for upload.
 * Includes automatic downsampling for large images.
 */
export async function processImageFile(
  filePath: string,
  cwd: string,
): Promise<ImageUploadResult> {
  const resolvedPath = resolveFilePath(filePath, cwd)

  // Validate file exists
  let stats
  try {
    stats = statSync(resolvedPath)
  } catch (error) {
    logger.debug({ resolvedPath, error }, 'Image handler: File not found')
    return { success: false, error: `File not found: ${filePath}` }
  }

  if (!stats.isFile()) {
    return { success: false, error: `Path is not a file: ${filePath}` }
  }

  // Validate file size
  if (stats.size > MAX_IMAGE_FILE_SIZE) {
    const sizeMB = (stats.size / (1024 * 1024)).toFixed(1)
    const maxMB = (MAX_IMAGE_FILE_SIZE / (1024 * 1024)).toFixed(1)
    return { success: false, error: `File too large: ${sizeMB}MB (max ${maxMB}MB): ${filePath}` }
  }

  // Validate image format
  if (!isImageFile(resolvedPath)) {
    return {
      success: false,
      error: `Unsupported image format: ${filePath}. Supported: ${Array.from(SUPPORTED_IMAGE_EXTENSIONS).join(', ')}`,
    }
  }

  // Get MIME type
  const mediaType = getImageMimeType(path.extname(resolvedPath))
  if (!mediaType) {
    return { success: false, error: `Could not determine image type for: ${filePath}` }
  }

  // Read file
  let fileBuffer: Buffer
  try {
    fileBuffer = readFileSync(resolvedPath)
  } catch (error) {
    logger.debug({ resolvedPath, error }, 'Image handler: Failed to read file')
    return { success: false, error: `Could not read file: ${filePath}` }
  }

  // Get initial dimensions
  let width: number | undefined
  let height: number | undefined
  try {
    const image = await Jimp.read(fileBuffer)
    width = image.bitmap.width
    height = image.bitmap.height
  } catch {
    // Continue without dimensions if we can't read them
  }

  let processedBuffer = fileBuffer
  let finalMediaType = mediaType

  // A BMP or TIFF is recognised above but no vision provider decodes it — sent
  // as-is it 400s the turn, and every later turn of the session too, since the
  // history is replayed. Jimp reads both, so transcode to PNG; a file it
  // cannot read was never going to be seen by the model either.
  if (!isProviderSupportedImageMediaType(mediaType)) {
    try {
      const image = await Jimp.read(fileBuffer)
      processedBuffer = Buffer.from(await image.getBuffer('image/png'))
      finalMediaType = 'image/png'
    } catch (error) {
      logger.debug({ resolvedPath, error }, 'Image handler: Failed to transcode to PNG')
      return {
        success: false,
        error: `Unsupported image format: ${filePath}. Convert it to PNG or JPEG and try again.`,
      }
    }
  }

  // Check if compression is needed
  let base64Data = processedBuffer.toString('base64')
  let wasCompressed = false

  if (base64Data.length > MAX_IMAGE_BASE64_SIZE) {
    const compressionResult = await compressImageToFitSize(processedBuffer)
    
    if (!compressionResult.success) {
      return { success: false, error: compressionResult.error }
    }

    base64Data = compressionResult.base64!
    processedBuffer = compressionResult.buffer!
    finalMediaType = compressionResult.mediaType!
    width = compressionResult.width
    height = compressionResult.height
    wasCompressed = true
  }

  logger.debug(
    { resolvedPath, finalSize: processedBuffer.length, wasCompressed },
    'Image handler: Processing complete',
  )

  return {
    success: true,
    imagePart: {
      type: 'image',
      image: base64Data,
      mediaType: finalMediaType,
      filename: path.basename(resolvedPath),
      size: processedBuffer.length,
      width,
      height,
    },
    wasCompressed,
  }
}

/**
 * Extracts image file paths from user input using @path syntax and auto-detection
 */
export function extractImagePaths(input: string): string[] {
  const paths: string[] = []

  // Skip paths inside code blocks
  const cleanInput = input.replace(/```[\s\S]*?```|`[^`]*`/g, ' ')

  const addPath = (p: string) => {
    const cleaned = p.replace(/[.,!?;)\]}>">]+$/, '') // Remove trailing punctuation
    if (isImageFile(cleaned) && !paths.includes(cleaned)) {
      paths.push(cleaned)
    }
  }

  // @path syntax
  for (const match of cleanInput.matchAll(/@([^\s]+)/g)) {
    addPath(match[1])
  }

  // Path patterns to detect
  const patterns = [
    `(?:^|\\s)((?:[~/]|[A-Za-z]:\\\\)[^\\s"']*\\.(?:${IMAGE_EXTENSIONS_PATTERN}))(?=\\s|$|[.,!?;)\\]}>])`, // Absolute paths
    `(?:^|\\s)(\\.\\.?[\\/\\\\][^\\s"']*\\.(?:${IMAGE_EXTENSIONS_PATTERN}))(?=\\s|$|[.,!?;)\\]}>])`, // ./path, ../path
    `(?:^|\\s)((?![^\\s]*:\\/\\/|@)[^\\s"':]*[\\/\\\\][^\\s"']*\\.(?:${IMAGE_EXTENSIONS_PATTERN}))(?=\\s|$|[.,!?;)\\]}>])`, // relative/path
    `["']([^"']*[\\/\\\\][^"']*\\.(?:${IMAGE_EXTENSIONS_PATTERN}))["']`, // Quoted paths
  ]

  for (const pattern of patterns) {
    const regex = new RegExp(pattern, 'gi')
    for (const match of cleanInput.matchAll(regex)) {
      addPath(match[1])
    }
  }

  return paths
}
