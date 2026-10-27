/** Bounded binary reads shared by Desktop and Cloud; previews have separate limits. */
export const FILE_DOWNLOAD_CHUNK_BYTES = 256 * 1024
export interface FileDownloadChunk {
  data: Uint8Array
  size: number
  revision: string
}

/** `attachment` with the path's base name, RFC 5987-encoded so any name is safe in a header. */
export function attachmentDisposition(path: string): string {
  const filename = path.split(/[\\/]/).pop() || 'download'
  return `attachment; filename*=UTF-8''${encodeURIComponent(filename).replace(/['()*]/g, char => '%' + char.charCodeAt(0).toString(16))}`
}

/** Fetch the first chunk before sending headers so missing files remain HTTP errors.
 * Later failures abort the body: a partial download must never look successful. */
export async function fileDownloadResponse(
  path: string,
  read: (offset: number) => Promise<FileDownloadChunk>,
  options: { signal?: AbortSignal; close?: () => Promise<void> } = {},
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
  try {
    options.signal?.throwIfAborted()
    first = await read(0)
    options.signal?.throwIfAborted()
    if (!Number.isSafeInteger(first.size) || first.size < 0) throw new Error('Invalid download size')
  } catch (error) {
    await close()
    throw error
  }
  let offset = 0
  let initial: FileDownloadChunk | undefined = first
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
        const chunk = initial ?? await read(offset)
        initial = undefined
        if (closed) return
        options.signal?.throwIfAborted()
        if (chunk.size !== first.size || chunk.revision !== first.revision ||
            chunk.data.length !== Math.min(FILE_DOWNLOAD_CHUNK_BYTES, first.size - offset))
          throw new Error('The file changed during download. Please try again.')
        offset += chunk.data.length
        if (chunk.data.length) controller.enqueue(chunk.data)
        if (offset === first.size) {
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
  return new Response(body, { headers: {
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(first.size),
    'Content-Disposition': attachmentDisposition(path),
    'Cache-Control': 'private, no-store, no-transform',
    'X-Content-Type-Options': 'nosniff',
  } })
}
