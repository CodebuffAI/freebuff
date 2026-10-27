import { DICTATION_CONTENT_TYPE, DICTATION_MAX_AUDIO_BYTES } from './dictation'

export class DictationUploadError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

/** Read only after authentication. Bounds actual bytes, including chunked uploads. */
export async function readDictationUpload(request: Request): Promise<ArrayBuffer> {
  if (request.headers.get('content-type')?.split(';')[0].trim() !== DICTATION_CONTENT_TYPE)
    throw new DictationUploadError(415, 'Record audio to use dictation.')
  const length = request.headers.get('content-length')
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > DICTATION_MAX_AUDIO_BYTES))
    throw new DictationUploadError(413, 'Recordings must be two minutes or shorter.')
  const reader = request.body?.getReader()
  if (!reader) throw new DictationUploadError(400, 'The recording is empty.')
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(15_000)])
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', cancel, { once: true })
  let size = 0
  const chunks: Uint8Array[] = []
  try {
    for (;;) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      signal.throwIfAborted()
      if (done) break
      size += value.byteLength
      if (size > DICTATION_MAX_AUDIO_BYTES)
        throw new DictationUploadError(413, 'Recordings must be two minutes or shorter.')
      chunks.push(value)
    }
    if (!size) throw new DictationUploadError(400, 'The recording is empty.')
    const buffer = new ArrayBuffer(size)
    const bytes = new Uint8Array(buffer)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return buffer
  } catch (error) {
    if (error instanceof DictationUploadError) throw error
    throw new DictationUploadError(signal.aborted ? 408 : 400,
      signal.aborted ? 'The recording upload was interrupted. Try again.' : 'Could not read the recording.')
  } finally {
    signal.removeEventListener('abort', cancel)
    // A source may never settle its cancel promise. Cancellation must not
    // prevent the request deadline or byte-limit refusal from being returned.
    void reader.cancel().catch(() => {})
  }
}
