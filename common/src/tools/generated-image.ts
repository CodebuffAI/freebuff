export type GeneratedImage = { url: string; width: number; height: number }

/** https, or a local dev server's own link (`http://localhost:3000/...`). */
const SAFE_IMAGE_URL = /^(https:\/\/|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/)/

/**
 * The image in a generate_image result, for transcripts to draw: the
 * runtime's `[{ type: 'json', value }]` array, or that array as JSON text
 * (how Desktop and web carry tool output). Only an https URL counts, or a
 * local dev server's.
 */
export function generatedImageFromOutput(output: unknown): GeneratedImage | null {
  let parts = output
  if (typeof parts === 'string') {
    try {
      parts = JSON.parse(parts)
    } catch {
      return null
    }
  }
  if (!Array.isArray(parts)) return null
  for (const part of parts) {
    const image = part?.type === 'json' ? part.value : undefined
    if (
      typeof image?.url === 'string' &&
      typeof image.width === 'number' &&
      typeof image.height === 'number' &&
      SAFE_IMAGE_URL.test(image.url)
    )
      return { url: image.url, width: image.width, height: image.height }
  }
  return null
}
