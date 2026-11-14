import { gzipSync, gunzipSync } from 'node:zlib'

import { parseDesktopAcquisitionReceipt } from './desktop-acquisition-receipt'

const AR_MAGIC = Buffer.from('!<arch>\n')
const CONTROL_LIMIT = 2 * 1024 * 1024
const CONTROL_TAR_LIMIT = 8 * 1024 * 1024
export const DESKTOP_DEB_RECEIPT_MARKER =
  '# FREEBUFF_INSTALL_RECEIPT_PLACEHOLDER'

/** Reads only as much of a release stream as the current archive member needs. */
class ArchiveReader {
  private readonly iterator: AsyncIterator<Uint8Array>
  private chunk: Uint8Array = new Uint8Array(0)
  private offset = 0

  constructor(source: AsyncIterable<Uint8Array>) {
    this.iterator = source[Symbol.asyncIterator]()
  }

  async read(size: number): Promise<Buffer> {
    const output = Buffer.alloc(size)
    let written = 0
    while (written < size) {
      if (this.offset === this.chunk.length) {
        const next = await this.iterator.next()
        if (next.done) throw new Error('Truncated Debian installer')
        this.chunk = next.value
        this.offset = 0
        if (!this.chunk.length) continue
      }
      const count = Math.min(size - written, this.chunk.length - this.offset)
      output.set(this.chunk.subarray(this.offset, this.offset + count), written)
      this.offset += count
      written += count
    }
    return output
  }

  async *rest(): AsyncGenerator<Uint8Array> {
    if (this.offset < this.chunk.length) yield this.chunk.subarray(this.offset)
    for (;;) {
      const next = await this.iterator.next()
      if (next.done) return
      if (next.value.length) yield next.value
    }
  }

  async cancel(): Promise<void> {
    await this.iterator.return?.()
  }
}

function arMember(header: Buffer): { name: string; size: number } {
  if (header.length !== 60 || header.toString('ascii', 58) !== '`\n')
    throw new Error('Invalid Debian archive member')
  const name = header.toString('ascii', 0, 16).trim().replace(/\/$/, '')
  const sizeText = header.toString('ascii', 48, 58).trim()
  if (!/^\d+$/.test(sizeText)) throw new Error('Invalid Debian archive size')
  const size = Number(sizeText)
  if (!Number.isSafeInteger(size))
    throw new Error('Invalid Debian archive size')
  return { name, size }
}

function tarName(header: Buffer): string {
  const name = header.toString('utf8', 0, 100).replace(/\0.*$/s, '')
  const prefix = header.toString('utf8', 345, 500).replace(/\0.*$/s, '')
  return (prefix ? `${prefix}/${name}` : name).replace(/^\.\//, '')
}

function tarSize(header: Buffer): number {
  const sizeText = header.toString('ascii', 124, 136).replace(/\0/g, '').trim()
  if (!/^[0-7]+$/.test(sizeText))
    throw new Error('Unsupported Debian control tar size')
  const size = Number.parseInt(sizeText, 8)
  if (!Number.isSafeInteger(size) || size > CONTROL_TAR_LIMIT)
    throw new Error('Debian control tar member is too large')
  return size
}

function resizedTarHeader(original: Buffer, size: number): Buffer {
  const header = Buffer.from(original)
  header.fill(0, 124, 136)
  header.write(size.toString(8).padStart(11, '0'), 124, 11, 'ascii')
  header.fill(32, 148, 156)
  const checksum = header.reduce((total, byte) => total + byte, 0)
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
  return header
}

function receiptInstallScript(receipt: string): string {
  // The caller verified the signature; the shared parser also limits this literal to shell-safe
  // ASCII. This file is outside the application and is not replaced by ordinary auto-updates.
  return `# Persist only the original acquisition, never replace it during an upgrade.\nif [ ! -e /var/lib/freebuff/install-receipt.txt ] && install -d -m 0755 /var/lib/freebuff; then\n    ( set -C; printf '%s\\n' '${receipt}' > /var/lib/freebuff/install-receipt.txt ) 2>/dev/null || true\n    chmod 0644 /var/lib/freebuff/install-receipt.txt 2>/dev/null || true\nfi`
}

function personalizeControl(control: Buffer, receipt: string): Buffer {
  const archive = gunzipSync(control, { maxOutputLength: CONTROL_TAR_LIMIT })
  if (archive.length > CONTROL_TAR_LIMIT)
    throw new Error('Debian control tar is too large')
  const parts: Buffer[] = []
  let offset = 0
  let rewritten = false
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) {
      parts.push(archive.subarray(offset))
      offset = archive.length
      break
    }
    const size = tarSize(header)
    const end = offset + 512 + Math.ceil(size / 512) * 512
    if (end > archive.length) throw new Error('Truncated Debian control tar')
    if (tarName(header) === 'postinst') {
      if (rewritten || (header[156] !== 0 && header[156] !== 48))
        throw new Error('Invalid Debian post-install hook')
      const original = archive
        .subarray(offset + 512, offset + 512 + size)
        .toString('utf8')
      if (original.split(DESKTOP_DEB_RECEIPT_MARKER).length !== 2)
        throw new Error(
          'Debian installer does not support acquisition receipts',
        )
      const updated = Buffer.from(
        original.replace(
          DESKTOP_DEB_RECEIPT_MARKER,
          receiptInstallScript(receipt),
        ),
      )
      parts.push(resizedTarHeader(header, updated.length), updated)
      if (updated.length % 512)
        parts.push(Buffer.alloc(512 - (updated.length % 512)))
      rewritten = true
    } else {
      parts.push(archive.subarray(offset, end))
    }
    offset = end
  }
  if (!rewritten || offset !== archive.length)
    throw new Error('Invalid Debian control tar')
  return gzipSync(Buffer.concat(parts))
}

/**
 * Personalize a website download without buffering its application payload. Only the small
 * control.tar.gz install hook changes; the data archive and every byte after it pass through.
 * The returned stream is ready only after the receipt hook has been checked, so unsupported
 * releases can fail before the HTTP response starts. The caller must verify the receipt HMAC.
 */
export async function prepareDesktopDebReceipt(
  source: AsyncIterable<Uint8Array>,
  receipt: string,
): Promise<AsyncIterable<Uint8Array>> {
  const parsed = parseDesktopAcquisitionReceipt(receipt)
  if (
    !parsed ||
    (parsed.platform !== 'linux' && parsed.platform !== 'linux-arm64')
  )
    throw new Error('Invalid Debian acquisition receipt')
  const reader = new ArchiveReader(source)
  try {
    if (!(await reader.read(8)).equals(AR_MAGIC))
      throw new Error('Invalid Debian installer')
    const binaryHeader = await reader.read(60)
    const binary = arMember(binaryHeader)
    if (binary.name !== 'debian-binary' || binary.size !== 4)
      throw new Error('Unsupported Debian installer')
    const binaryBody = await reader.read(4)
    if (binaryBody.toString('ascii') !== '2.0\n')
      throw new Error('Unsupported Debian version')
    const controlHeader = await reader.read(60)
    const control = arMember(controlHeader)
    if (control.name !== 'control.tar.gz' || control.size > CONTROL_LIMIT)
      throw new Error('Unsupported Debian control archive')
    const updated = personalizeControl(await reader.read(control.size), receipt)
    if (control.size % 2) await reader.read(1)
    const header = Buffer.from(controlHeader)
    header.write(String(updated.length).padEnd(10, ' '), 48, 10, 'ascii')
    return (async function* () {
      try {
        yield AR_MAGIC
        yield binaryHeader
        yield binaryBody
        yield header
        yield updated
        if (updated.length % 2) yield Buffer.from('\n')
        yield* reader.rest()
      } finally {
        await reader.cancel()
      }
    })()
  } catch (error) {
    await reader.cancel()
    throw error
  }
}
