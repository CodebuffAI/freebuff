import { describe, expect, test } from 'bun:test'
import { gzipSync, gunzipSync } from 'node:zlib'

import {
  DESKTOP_DEB_RECEIPT_MARKER,
  prepareDesktopDebReceipt,
} from './desktop-installer-archive'

const token = (platform = 'linux') =>
  `v1.12345678-1234-4234-8234-123456789abc.${Math.floor(Date.now() / 1000).toString(36)}.${platform}.${'a'.repeat(43)}`
const script = `#!/bin/sh\nset -e\n${DESKTOP_DEB_RECEIPT_MARKER}\necho configured\n`

function tarEntry(name: string, text: string, type = '0'): Buffer {
  const data = Buffer.from(text)
  const header = Buffer.alloc(512)
  header.write(name, 0, 100)
  header.write('0000755\0', 100, 8)
  header.write('0000000\0', 108, 8)
  header.write('0000000\0', 116, 8)
  header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 12)
  header.write('00000000000\0', 136, 12)
  header.fill(32, 148, 156)
  header.write(type, 156)
  header.write('ustar\0', 257, 6)
  header.write('00', 263, 2)
  header.write(
    `${header
      .reduce((sum, byte) => sum + byte, 0)
      .toString(8)
      .padStart(6, '0')}\0 `,
    148,
    8,
  )
  return Buffer.concat([
    header,
    data,
    Buffer.alloc((512 - (data.length % 512)) % 512),
  ])
}

function arHeader(name: string, size: number): Buffer {
  return Buffer.from(
    `${`${name}/`.padEnd(16)}${'1234567'.padEnd(12)}${'0'.padEnd(6)}${'0'.padEnd(6)}${'100644'.padEnd(8)}${String(size).padEnd(10)}\x60\n`,
  )
}

function arEntry(name: string, body: Buffer): Buffer {
  return Buffer.concat([
    arHeader(name, body.length),
    body,
    ...(body.length % 2 ? [Buffer.from('\n')] : []),
  ])
}

function fixture(
  options: {
    postinst?: string
    compression?: string
    type?: string
    duplicate?: boolean
  } = {},
) {
  const controlEntry = tarEntry(
    './control',
    'Package: freebuff\nVersion: 0.0.180\nArchitecture: amd64\n',
  )
  const postinstEntry = tarEntry(
    './postinst',
    options.postinst ?? script,
    options.type,
  )
  const control = gzipSync(
    Buffer.concat([
      controlEntry,
      postinstEntry,
      ...(options.duplicate ? [postinstEntry] : []),
      Buffer.alloc(1024),
    ]),
  )
  const prefix = Buffer.concat([
    Buffer.from('!<arch>\n'),
    arEntry('debian-binary', Buffer.from('2.0\n')),
    arEntry(options.compression ?? 'control.tar.gz', control),
  ])
  // Arbitrary opaque compressed application data: the personalizer must never inspect or alter it.
  const suffix = arEntry('data.tar.xz', Buffer.from([0, 128, 42, 255, 1, 2, 3]))
  return {
    prefix,
    suffix,
    archive: Buffer.concat([prefix, suffix]),
    controlEntry,
  }
}

async function* chunks(
  buffer: Buffer,
  chunkSize = 17,
): AsyncGenerator<Uint8Array> {
  yield new Uint8Array(0)
  for (let i = 0; i < buffer.length; i += chunkSize)
    yield buffer.subarray(i, i + chunkSize)
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = []
  for await (const chunk of source) chunks.push(chunk)
  return Buffer.concat(chunks)
}

function rewrittenControl(archive: Buffer): {
  header: Buffer
  control: Buffer
  tail: Buffer
} {
  const offset = 8 + 60 + 4
  const header = archive.subarray(offset, offset + 60)
  const size = Number(header.toString('ascii', 48, 58).trim())
  return {
    header,
    control: gunzipSync(archive.subarray(offset + 60, offset + 60 + size)),
    tail: archive.subarray(offset + 60 + size + (size % 2)),
  }
}

describe('Debian acquisition receipt delivery', () => {
  test.each([1, 17, 65536])(
    'personalizes only the install hook with %p-byte input chunks',
    async (chunkSize) => {
      const original = fixture()
      const receipt = token()
      const result = await collect(
        await prepareDesktopDebReceipt(
          chunks(original.archive, chunkSize),
          receipt,
        ),
      )
      const { header, control, tail } = rewrittenControl(result)
      expect(result.subarray(0, 8 + 60 + 4)).toEqual(
        original.archive.subarray(0, 8 + 60 + 4),
      )
      expect(header.subarray(0, 48)).toEqual(original.prefix.subarray(72, 120))
      expect(control.subarray(0, original.controlEntry.length)).toEqual(
        original.controlEntry,
      )
      expect(tail).toEqual(original.suffix)
      const postinstHeader = control.subarray(
        original.controlEntry.length,
        original.controlEntry.length + 512,
      )
      const postinstSize = Number.parseInt(
        postinstHeader.toString('ascii', 124, 136),
        8,
      )
      const updated = control
        .subarray(
          original.controlEntry.length + 512,
          original.controlEntry.length + 512 + postinstSize,
        )
        .toString()
      expect(updated).toContain(`printf '%s\\n' '${receipt}'`)
      expect(updated).toContain(
        '[ ! -e /var/lib/freebuff/install-receipt.txt ] && install -d',
      )
      expect(updated).toContain('( set -C;')
      expect(updated).toEndWith('echo configured\n')
      expect(updated).not.toContain(DESKTOP_DEB_RECEIPT_MARKER)
      const checksumHeader = Buffer.from(postinstHeader)
      const storedChecksum = Number.parseInt(
        checksumHeader.toString('ascii', 148, 156),
        8,
      )
      checksumHeader.fill(32, 148, 156)
      expect(storedChecksum).toBe(
        checksumHeader.reduce((sum, byte) => sum + byte, 0),
      )
    },
  )

  test('does not pull the application payload while preparing the HTTP response', async () => {
    const { prefix, suffix } = fixture()
    let pulledPayload = false
    let closed = false
    async function* source() {
      try {
        yield prefix
        pulledPayload = true
        yield suffix
      } finally {
        closed = true
      }
    }
    const prepared = await prepareDesktopDebReceipt(
      source(),
      token('linux-arm64'),
    )
    expect(pulledPayload).toBe(false)
    const result = await collect(prepared)
    expect(rewrittenControl(result).tail).toEqual(suffix)
    expect(closed).toBe(true)
  })

  test('consumer cancellation closes the upstream download', async () => {
    let closed = false
    const { prefix, suffix } = fixture()
    async function* source() {
      try {
        yield prefix
        yield suffix
      } finally {
        closed = true
      }
    }
    for await (const _chunk of await prepareDesktopDebReceipt(
      source(),
      token(),
    ))
      break
    expect(closed).toBe(true)
  })

  test.each([
    { postinst: '#!/bin/sh\necho old release\n' },
    { postinst: `${script}\n${DESKTOP_DEB_RECEIPT_MARKER}` },
    { type: '2' },
    { duplicate: true },
    { compression: 'control.tar.xz' },
  ])(
    'rejects unsupported or ambiguous control hooks before returning a stream: %p',
    async (options) => {
      await expect(
        prepareDesktopDebReceipt(chunks(fixture(options).archive), token()),
      ).rejects.toThrow()
    },
  )

  test('bounds compressed and decompressed control archives', async () => {
    const binary = arEntry('debian-binary', Buffer.from('2.0\n'))
    const oversizedHeader = Buffer.concat([
      Buffer.from('!<arch>\n'),
      binary,
      arHeader('control.tar.gz', 2 * 1024 * 1024 + 1),
    ])
    await expect(
      prepareDesktopDebReceipt(chunks(oversizedHeader), token()),
    ).rejects.toThrow('Unsupported Debian control archive')
    const compressedBomb = arEntry(
      'control.tar.gz',
      gzipSync(Buffer.alloc(8 * 1024 * 1024 + 1)),
    )
    await expect(
      prepareDesktopDebReceipt(
        chunks(
          Buffer.concat([Buffer.from('!<arch>\n'), binary, compressedBomb]),
        ),
        token(),
      ),
    ).rejects.toThrow()
  })

  test('malformed or truncated release downloads close the upstream', async () => {
    let closed = false
    async function* source() {
      try {
        yield fixture().prefix.subarray(0, 90)
      } finally {
        closed = true
      }
    }
    await expect(prepareDesktopDebReceipt(source(), token())).rejects.toThrow(
      'Truncated Debian installer',
    )
    expect(closed).toBe(true)
    await expect(
      prepareDesktopDebReceipt(chunks(Buffer.from('not ar!!')), token()),
    ).rejects.toThrow('Invalid Debian installer')
  })

  test.each([`${token()}' ; touch /tmp/untrusted`, token('windows'), ''])(
    'rejects unsafe/wrong-platform receipts before reading a release',
    async (receipt) => {
      let read = false
      async function* source() {
        read = true
        yield fixture().archive
      }
      await expect(prepareDesktopDebReceipt(source(), receipt)).rejects.toThrow(
        'Invalid Debian acquisition receipt',
      )
      expect(read).toBe(false)
    },
  )
})
