/** Containers Chromium plays natively. A QuickTime file plays only when its codec is H.264/AAC;
 * the panel falls back to a download when the element reports it can't decode one. */
const MEDIA_TYPES = {
  mp4: { kind: 'video', mimeType: 'video/mp4' },
  m4v: { kind: 'video', mimeType: 'video/mp4' },
  mov: { kind: 'video', mimeType: 'video/quicktime' },
  webm: { kind: 'video', mimeType: 'video/webm' },
  ogv: { kind: 'video', mimeType: 'video/ogg' },
  mp3: { kind: 'audio', mimeType: 'audio/mpeg' },
  m4a: { kind: 'audio', mimeType: 'audio/mp4' },
  wav: { kind: 'audio', mimeType: 'audio/wav' },
  ogg: { kind: 'audio', mimeType: 'audio/ogg' },
  oga: { kind: 'audio', mimeType: 'audio/ogg' },
  flac: { kind: 'audio', mimeType: 'audio/flac' },
} as const

export type FileMediaType = (typeof MEDIA_TYPES)[keyof typeof MEDIA_TYPES]

/** A playable file's description. Its bytes are streamed from a URL, never inlined in a read. */
export interface FileMedia {
  kind: FileMediaType['kind']
  mimeType: FileMediaType['mimeType']
  size: number
}

/** Bytes per native media chunk; the page assembles them into a Blob it can seek. */
export const MEDIA_CHUNK_BYTES = 2 * 1024 * 1024
/** Media read over native IPC is held in memory, so it has a ceiling HTTP streaming does not. */
export const MEDIA_BLOB_MAX_BYTES = 256 * 1024 * 1024

export function mediaType(path: string): FileMediaType | undefined {
  const extension = /\.([^./\\]+)$/.exec(path)?.[1]?.toLowerCase()
  return extension && Object.hasOwn(MEDIA_TYPES, extension)
    ? MEDIA_TYPES[extension as keyof typeof MEDIA_TYPES]
    : undefined
}
