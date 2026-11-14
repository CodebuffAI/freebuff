/** Bounded binary reads shared by Desktop and Cloud; previews have separate limits. */
export const FILE_DOWNLOAD_CHUNK_BYTES = 256 * 1024
export interface FileDownloadChunk {
  data: Uint8Array
  size: number
  revision: string
}

/** The path's base name as an RFC 5987 parameter, so any name is safe in a header. */
function encodedFilename(path: string): string {
  const filename = path.split(/[\\/]/).pop() || 'download'
  return `filename*=UTF-8''${encodeURIComponent(filename).replace(/['()*]/g, char => '%' + char.charCodeAt(0).toString(16))}`
}

/** `attachment` with the path's base name, RFC 5987-encoded so any name is safe in a header. */
export function attachmentDisposition(path: string): string {
  return `attachment; ${encodedFilename(path)}`
}

/** One `bytes=` range, clamped to the file. Multipart requests are answered with the whole file. */
export function parseByteRange(header: string | null | undefined, size: number):
  { start: number; end: number } | 'unsatisfiable' | null {
  const match = header ? /^bytes=(\d{0,16})-(\d{0,16})$/.exec(header.trim()) : null
  if (!match || (!match[1] && !match[2])) return null
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]))
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1
  if (!match[1] && Number(match[2]) === 0) return 'unsatisfiable'
  return start >= size || end < start ? 'unsatisfiable' : { start, end }
}

export interface FileDownloadOptions {
  signal?: AbortSignal
  close?: () => Promise<void>
  /** The request's `Range` header. Readers must accept any offset, not only chunk multiples. */
  range?: string | null
  /** Serve for in-page playback with this media type instead of as an attachment. */
  inline?: string
}

/** Fetch the first chunk before sending headers so missing files remain HTTP errors.
 * Later failures abort the body: a partial download must never look successful. */
export async function fileDownloadResponse(
  path: string,
  read: (offset: number) => Promise<FileDownloadChunk>,
  options: FileDownloadOptions = {},
): Promise<Response> {
  let closed = false
  let onAbort: (() => void) | undefined
  const close = async () => {
    if (closed) return
    closed = true
    if (onAbort) options.signal?.removeEventListener('abort', onAbort)
    await options.close?.()
  }
  let first: FileDownloadChunk
  let range: ReturnType<typeof parseByteRange>
  try {
    options.signal?.throwIfAborted()
    first = await read(0)
    options.signal?.throwIfAborted()
    if (!Number.isSafeInteger(first.size) || first.size < 0) throw new Error('Invalid download size')
    range = parseByteRange(options.range, first.size)
  } catch (error) {
    await close()
    throw error
  }
  const headers: Record<string, string> = {
    'Content-Type': options.inline ?? 'application/octet-stream',
    'Content-Disposition': options.inline ? `inline; ${encodedFilename(path)}` : attachmentDisposition(path),
    'Cache-Control': 'private, no-store, no-transform',
    'X-Content-Type-Options': 'nosniff',
    'Accept-Ranges': 'bytes',
    ETag: `"${encodeURIComponent(first.revision)}"`,
    ...(options.inline ? { 'Content-Security-Policy': "default-src 'none'; sandbox" } : {}),
  }
  if (range === 'unsatisfiable') {
    await close()
    return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${first.size}` } })
  }
  const start = range?.start ?? 0
  const end = range?.end ?? first.size - 1
  // `position` is the next byte to deliver; a chunk read at `from` covers [from, from + length).
  let position = start
  let initial: FileDownloadChunk | undefined = start < first.data.length || first.size === 0 ? first : undefined
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      onAbort = () => {
        controller.error(options.signal?.reason ?? new Error('Download cancelled'))
        void close().catch(() => {})
      }
      options.signal?.addEventListener('abort', onAbort, { once: true })
    },
    async pull(controller) {
      try {
        options.signal?.throwIfAborted()
        const from = initial ? 0 : position
        const chunk = initial ?? await read(position)
        initial = undefined
        if (closed) return
        options.signal?.throwIfAborted()
        if (chunk.size !== first.size || chunk.revision !== first.revision ||
            chunk.data.length !== Math.min(FILE_DOWNLOAD_CHUNK_BYTES, first.size - from))
          throw new Error('The file changed during download. Please try again.')
        const data = chunk.data.subarray(position - from, Math.min(chunk.data.length, end + 1 - from))
        position += data.length
        if (data.length) controller.enqueue(data)
        if (position > end) {
          await close()
          controller.close()
        }
      } catch (error) {
        await close()
        controller.error(error)
      }
    },
    cancel: close,
  })
  return new Response(body, {
    status: range ? 206 : 200,
    headers: {
      ...headers,
      'Content-Length': String(end + 1 - start),
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${first.size}` } : {}),
    },
  })
}
