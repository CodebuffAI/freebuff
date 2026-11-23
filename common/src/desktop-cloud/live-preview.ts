/** Presentation only. Never persisted, used as context, or treated as a response receipt. */
export type CloudPreviewPart = { kind: 'text' | 'reasoning'; text: string }
export type CloudPreview = {
  base: string
  attempt: string
  parts: CloudPreviewPart[]
}
export const CLOUD_PREVIEW_MAX_CHARS = 64 * 1024

function validPreviewParts(parts: unknown): parts is CloudPreviewPart[] {
  return (
    Array.isArray(parts) &&
    parts.length <= 128 &&
    parts.every(
      (part) =>
        part &&
        ['text', 'reasoning'].includes(part.kind) &&
        typeof part.text === 'string',
    ) &&
    parts.reduce((n, part) => n + part.text.length, 0) <= CLOUD_PREVIEW_MAX_CHARS
  )
}

export function validCloudPreview(value: unknown): value is CloudPreview {
  if (!value || typeof value !== 'object') return false
  const preview = value as CloudPreview
  return (
    typeof preview.base === 'string' &&
    /^[1-9][0-9]{0,18}$/.test(preview.base) &&
    typeof preview.attempt === 'string' &&
    /^[1-9][0-9]{0,18}$/.test(preview.attempt) &&
    validPreviewParts(preview.parts)
  )
}

/**
 * Text a Claude Code or Codex turn on the user's computer has streamed but not yet written to
 * its journal, which takes a line a second. Desktop reports it as the progress of a
 * `harness_read`, so the chat shows the answer as it is written.
 *
 * `after` is the journal size the text follows. Whoever shows it must hold every line up to
 * there and none past it, or the text prints twice or out of order.
 */
export type DeviceLivePreview = { after: number; parts: CloudPreviewPart[] }

export function validDeviceLivePreview(value: unknown): value is DeviceLivePreview {
  if (!value || typeof value !== 'object') return false
  const preview = value as DeviceLivePreview
  return (
    Number.isSafeInteger(preview.after) &&
    preview.after >= 0 &&
    validPreviewParts(preview.parts)
  )
}
