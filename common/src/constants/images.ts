/**
 * Image-related constants shared across the codebase
 */

/**
 * Extension to MIME type mapping for supported image formats
 */
export const IMAGE_EXTENSION_TO_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.tiff': 'image/tiff',
  '.tif': 'image/tiff',
}

/**
 * Supported image extensions (derived from IMAGE_EXTENSION_TO_MIME)
 */
export const SUPPORTED_IMAGE_EXTENSIONS = new Set(Object.keys(IMAGE_EXTENSION_TO_MIME))

/**
 * The formats vision providers accept as inline image input. Every image part
 * that reaches a provider has to be one of these; BMP and TIFF above are
 * recognised as images (so a path to one is detected and read as an image, not
 * as text) but no provider decodes them — the request 400s with "You have
 * uploaded an unsupported image ... webp, png, jpeg, and gif", and because
 * clients replay their history, so does every later turn of that thread until
 * the part is converted or dropped. Anything that builds an image part from
 * bytes must transcode to one of these or refuse with a reason the model can act
 * on; the chat completions route strips whatever slips through.
 */
export const PROVIDER_IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
])

/** Whether an inline image with this media type can be sent to a vision provider. */
export function isProviderSupportedImageMediaType(mediaType: string | null | undefined): boolean {
  return !!mediaType && PROVIDER_IMAGE_MEDIA_TYPES.has(mediaType.trim().toLowerCase())
}

/**
 * Check if a file extension is a supported image format
 */
export function isSupportedImageExtension(ext: string): boolean {
  return SUPPORTED_IMAGE_EXTENSIONS.has(ext.toLowerCase())
}

/**
 * Get MIME type for an image extension
 */
export function getImageMimeType(ext: string): string | null {
  return IMAGE_EXTENSION_TO_MIME[ext.toLowerCase()] ?? null
}

/**
 * Image extensions as a regex alternation pattern (without dots)
 * e.g., "jpg|jpeg|png|webp|gif|bmp|tiff|tif"
 */
export const IMAGE_EXTENSIONS_PATTERN = Object.keys(IMAGE_EXTENSION_TO_MIME)
  .map((ext) => ext.slice(1)) // Remove leading dot
  .join('|')

// Size limits for image uploads
// Research shows Claude/GPT-4V support up to 20MB, but we use practical limits
// for good performance and token efficiency
export const MAX_IMAGE_FILE_SIZE = 10 * 1024 * 1024 // 10MB - allow larger files since we can compress
export const MAX_IMAGE_BASE64_SIZE = 1 * 1024 * 1024 // 1MB max for base64 after compression
export const MAX_TOTAL_IMAGE_SIZE = 5 * 1024 * 1024 // 5MB total for multiple images
