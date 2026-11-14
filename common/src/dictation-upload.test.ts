import { describe, expect, mock, test } from 'bun:test'

import { DICTATION_MAX_AUDIO_BYTES } from './dictation'
import { DictationUploadError, readDictationUpload } from './dictation-upload'

function request(body: BodyInit | null, options: { type?: string; length?: string; signal?: AbortSignal } = {}) {
  const headers = new Headers({ 'Content-Type': options.type ?? 'audio/wav' })
  if (options.length !== undefined) headers.set('Content-Length', options.length)
  return new Request('https://freebuff.com/api/workspace/dictation', {
    method: 'POST', headers, body, signal: options.signal, duplex: 'half',
  } as RequestInit)
}

async function refusal(promise: Promise<unknown>, status: number) {
  try {
    await promise
    throw new Error('Expected the upload to be refused')
  } catch (error) {
    expect(error).toBeInstanceOf(DictationUploadError)
    expect((error as DictationUploadError).status).toBe(status)
  }
}

describe('bounded dictation upload', () => {
  test('returns all bytes from an ordinary upload or several chunks', async () => {
    expect(new Uint8Array(await readDictationUpload(request(new Uint8Array([1, 2, 3]))))).toEqual(new Uint8Array([1, 2, 3]))
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]))
        controller.enqueue(new Uint8Array([2, 3]))
        controller.close()
      },
    })
    expect(new Uint8Array(await readDictationUpload(request(stream)))).toEqual(new Uint8Array([1, 2, 3]))
  })

  test('rejects wrong content types and malformed or oversized declared lengths before reading', async () => {
    for (const options of [
      { type: 'audio/webm' },
      { length: '-1' },
      { length: '1.5' },
      { length: String(DICTATION_MAX_AUDIO_BYTES + 1) },
    ]) {
      const req = request(new Uint8Array([1]), options)
      await refusal(readDictationUpload(req), options.type ? 415 : 413)
      expect(req.bodyUsed).toBe(false)
    }
  })

  test('permits the exact byte ceiling and rejects an extra byte without Content-Length', async () => {
    const maximum = await readDictationUpload(request(new Uint8Array(DICTATION_MAX_AUDIO_BYTES)))
    expect(maximum.byteLength).toBe(DICTATION_MAX_AUDIO_BYTES)
    await refusal(readDictationUpload(request(new Uint8Array(DICTATION_MAX_AUDIO_BYTES + 1))), 413)
  })

  test('a forged small Content-Length cannot hide a larger chunked body', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(DICTATION_MAX_AUDIO_BYTES))
        controller.enqueue(new Uint8Array(1))
        controller.close()
      },
    })
    await refusal(readDictationUpload(request(stream, { length: '1' })), 413)
  })

  test('empty, absent, failed and externally canceled streams are refused', async () => {
    await refusal(readDictationUpload(request(null)), 400)
    await refusal(readDictationUpload(request(new Uint8Array())), 400)
    const failed = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error('private source error')) } })
    await refusal(readDictationUpload(request(failed)), 400)
    // Construct the request first: the Fetch API refuses an already-used body.
    const canceled = request(new ReadableStream<Uint8Array>())
    await canceled.body!.cancel()
    await refusal(readDictationUpload(canceled), 400)
  })

  test('abort cancels a pending read and does not wait for an uncooperative cancellation promise', async () => {
    const cancel = mock(() => new Promise<void>(() => {}))
    const stream = new ReadableStream<Uint8Array>({ cancel })
    const controller = new AbortController()
    const reading = readDictationUpload(request(stream, { signal: controller.signal }))
    controller.abort()
    await refusal(reading, 408)
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  test('an already-aborted request is refused before reading and still cancels its source', async () => {
    const cancel = mock(() => {})
    const stream = new ReadableStream<Uint8Array>({ cancel })
    const controller = new AbortController()
    controller.abort()
    await refusal(readDictationUpload(request(stream, { signal: controller.signal })), 408)
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  test('a byte-limit refusal does not wait for a stalled source cancellation', async () => {
    const cancel = mock(() => new Promise<void>(() => {}))
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(DICTATION_MAX_AUDIO_BYTES + 1)) },
      cancel,
    })
    await refusal(readDictationUpload(request(stream)), 413)
    expect(cancel).toHaveBeenCalledTimes(1)
  })
})
