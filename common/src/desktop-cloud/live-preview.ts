/** Presentation only. Never persisted, used as context, or treated as a response receipt. */
export type CloudPreviewPart = { kind: 'text' | 'reasoning'; text: string }
export type CloudPreview = {
  base: string
  attempt: string
  parts: CloudPreviewPart[]
}
export const CLOUD_PREVIEW_MAX_CHARS = 64 * 1024

export function validCloudPreview(value: unknown): value is CloudPreview {
  if (!value || typeof value !== 'object') return false
  const preview = value as CloudPreview
  return (
    typeof preview.base === 'string' &&
    /^[1-9][0-9]{0,18}$/.test(preview.base) &&
    typeof preview.attempt === 'string' &&
    /^[1-9][0-9]{0,18}$/.test(preview.attempt) &&
    Array.isArray(preview.parts) &&
    preview.parts.length <= 128 &&
    preview.parts.every(
      (part) =>
        part &&
        ['text', 'reasoning'].includes(part.kind) &&
        typeof part.text === 'string',
    ) &&
    preview.parts.reduce((n, part) => n + part.text.length, 0) <=
      CLOUD_PREVIEW_MAX_CHARS
  )
}
