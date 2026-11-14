/** Rename only ZIP entry paths around a signed .app; signed bundle bytes are unchanged. Small bootstrap archives only. */
export function personalizeDesktopInstallerZip(
  input: Uint8Array,
  receipt: string,
): Uint8Array {
  const data = Buffer.from(input)
  if (
    data.length < 22 ||
    data.length > 16 * 1024 * 1024 ||
    !/^[A-Za-z0-9_.-]{50,180}$/.test(receipt) ||
    receipt.trim() !== receipt
  )
    throw Error('Invalid installer archive')
  let end = data.length - 22
  while (
    end >= Math.max(0, data.length - 65557) &&
    data.readUInt32LE(end) !== 0x06054b50
  )
    end--
  if (
    end < 0 ||
    data.readUInt32LE(end) !== 0x06054b50 ||
    end + 22 + data.readUInt16LE(end + 20) !== data.length
  )
    throw Error('Invalid ZIP directory')
  const count = data.readUInt16LE(end + 10),
    directory = data.readUInt32LE(end + 16)
  if (
    !count ||
    count > 2048 ||
    data.readUInt16LE(end + 4) ||
    data.readUInt16LE(end + 6) ||
    data.readUInt16LE(end + 8) !== count ||
    directory + data.readUInt32LE(end + 12) !== end
  )
    throw Error('Unsupported ZIP')
  const extraFields = (bytes: Buffer) => {
    for (let at = 0; at < bytes.length; ) {
      if (at + 4 > bytes.length) throw Error('Invalid ZIP extra field')
      const id = bytes.readUInt16LE(at),
        size = bytes.readUInt16LE(at + 2)
      if (id === 1 || at + 4 + size > bytes.length)
        throw Error('Unsupported ZIP extra field')
      at += 4 + size
    }
  }
  const entries: {
    central: Buffer
    oldName: Buffer
    name: Buffer
    offset: number
    flags: number
    method: number
    crc: number
    compressed: number
    uncompressed: number
  }[] = []
  let position = directory
  let root = ''
  const paths = new Set<string>()
  for (let i = 0; i < count; i++) {
    if (position + 46 > end || data.readUInt32LE(position) !== 0x02014b50)
      throw Error('Invalid ZIP entry')
    const n = data.readUInt16LE(position + 28),
      x = data.readUInt16LE(position + 30),
      c = data.readUInt16LE(position + 32)
    const length = 46 + n + x + c
    const flags = data.readUInt16LE(position + 8),
      method = data.readUInt16LE(position + 10)
    const crc = data.readUInt32LE(position + 16),
      compressed = data.readUInt32LE(position + 20),
      uncompressed = data.readUInt32LE(position + 24)
    if (
      position + length > end ||
      data.readUInt16LE(position + 6) >= 45 ||
      data.readUInt16LE(position + 34) ||
      data.readUInt32LE(position + 42) === 0xffffffff ||
      compressed === 0xffffffff ||
      uncompressed === 0xffffffff ||
      flags & 0x2041 ||
      ![0, 8].includes(method) ||
      (method === 0 && compressed !== uncompressed)
    )
      throw Error('Unsupported ZIP entry')
    extraFields(data.subarray(position + 46 + n, position + 46 + n + x))
    const oldName = data.subarray(position + 46, position + 46 + n),
      path = oldName.toString('utf8')
    root ||= path.split('/')[0] ?? ''
    const components = path.replace(/\/$/, '').split('/')
    if (
      !root.endsWith('.app') ||
      root.length <= 4 ||
      root.includes('..') ||
      /[\\:\x00-\x1f\x7f]/.test(path) ||
      components.some((part) => !part || part === '.' || part === '..') ||
      !Buffer.from(path).equals(oldName) ||
      paths.has(path) ||
      !(path === root || path.startsWith(root + '/'))
    )
      throw Error('Invalid app path')
    paths.add(path)
    const name = Buffer.from(
      root.slice(0, -4) + '--fb_' + receipt + '.app' + path.slice(root.length),
    )
    if (name.length > 0xffff) throw Error('ZIP entry path too long')
    entries.push({
      central: Buffer.from(data.subarray(position, position + length)),
      oldName,
      name,
      offset: data.readUInt32LE(position + 42),
      flags,
      method,
      crc,
      compressed,
      uncompressed,
    })
    position += length
  }
  if (position !== end) throw Error('Invalid ZIP directory size')
  const chunks: Buffer[] = [],
    offsets = new Map<number, number>()
  let outputSize = 0
  const sorted = [...entries].sort((a, b) => a.offset - b.offset)
  if (sorted[0]?.offset !== 0) throw Error('Unsupported ZIP prefix')
  for (let i = 0; i < sorted.length; i++) {
    const entry = sorted[i]!,
      next = sorted[i + 1]?.offset ?? directory
    if (
      entry.offset + 30 > next ||
      data.readUInt32LE(entry.offset) !== 0x04034b50 ||
      data.readUInt16LE(entry.offset + 4) >= 45 ||
      data.readUInt16LE(entry.offset + 6) !== entry.flags ||
      data.readUInt16LE(entry.offset + 8) !== entry.method
    )
      throw Error('Invalid local ZIP entry')
    const n = data.readUInt16LE(entry.offset + 26),
      x = data.readUInt16LE(entry.offset + 28)
    if (
      entry.offset + 30 + n + x > next ||
      !data
        .subarray(entry.offset + 30, entry.offset + 30 + n)
        .equals(entry.oldName)
    )
      throw Error('Inconsistent ZIP entry')
    extraFields(data.subarray(entry.offset + 30 + n, entry.offset + 30 + n + x))
    const localCrc = data.readUInt32LE(entry.offset + 14),
      localCompressed = data.readUInt32LE(entry.offset + 18),
      localUncompressed = data.readUInt32LE(entry.offset + 22)
    const descriptor = Boolean(entry.flags & 8)
    if (
      (localCrc !== entry.crc && !(descriptor && localCrc === 0)) ||
      (localCompressed !== entry.compressed &&
        !(descriptor && localCompressed === 0)) ||
      (localUncompressed !== entry.uncompressed &&
        !(descriptor && localUncompressed === 0))
    )
      throw Error('Inconsistent ZIP sizes')
    const payloadEnd = entry.offset + 30 + n + x + entry.compressed
    const descriptorSize = next - payloadEnd
    if (!descriptor && descriptorSize !== 0)
      throw Error('Inconsistent ZIP payload')
    if (descriptor) {
      if (
        ![12, 16].includes(descriptorSize) ||
        payloadEnd < entry.offset ||
        payloadEnd + descriptorSize > next
      )
        throw Error('Invalid ZIP descriptor')
      const at = descriptorSize === 16 ? payloadEnd + 4 : payloadEnd
      if (
        (descriptorSize === 16 &&
          data.readUInt32LE(payloadEnd) !== 0x08074b50) ||
        data.readUInt32LE(at) !== entry.crc ||
        data.readUInt32LE(at + 4) !== entry.compressed ||
        data.readUInt32LE(at + 8) !== entry.uncompressed
      )
        throw Error('Inconsistent ZIP descriptor')
    }
    const header = Buffer.from(data.subarray(entry.offset, entry.offset + 30))
    header.writeUInt16LE(entry.name.length, 26)
    offsets.set(entry.offset, outputSize)
    const rest = data.subarray(entry.offset + 30 + n, next)
    chunks.push(header, entry.name, rest)
    outputSize += header.length + entry.name.length + rest.length
  }
  const directoryOffset = outputSize
  for (const entry of entries) {
    const n = entry.central.readUInt16LE(28),
      header = Buffer.from(entry.central.subarray(0, 46)),
      rest = entry.central.subarray(46 + n)
    header.writeUInt16LE(entry.name.length, 28)
    header.writeUInt32LE(offsets.get(entry.offset)!, 42)
    chunks.push(header, entry.name, rest)
    outputSize += header.length + entry.name.length + rest.length
  }
  const footer = Buffer.from(data.subarray(end))
  footer.writeUInt32LE(outputSize - directoryOffset, 12)
  footer.writeUInt32LE(directoryOffset, 16)
  return Buffer.concat([...chunks, footer])
}
