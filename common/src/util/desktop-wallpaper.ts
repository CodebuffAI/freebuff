const MAX_WALLPAPER_SOURCE_CHARS = 4_000_000

/** Validate the bounded, static raster produced by the renderer without a native image decoder. */
export function decodeWallpaper(source: unknown): Buffer | null {
  if (
    typeof source !== 'string' ||
    source.length > MAX_WALLPAPER_SOURCE_CHARS ||
    !/^data:image\/webp;base64,[a-z\d+/]+={0,2}$/i.test(source)
  )
    return null
  const image = Buffer.from(source.slice(source.indexOf(',') + 1), 'base64')
  if (
    image.length < 30 ||
    image.toString('ascii', 0, 4) !== 'RIFF' ||
    image.toString('ascii', 8, 12) !== 'WEBP' ||
    image.readUInt32LE(4) + 8 !== image.length
  )
    return null
  let hasPixels = false
  for (let offset = 12; offset + 8 <= image.length; ) {
    const kind = image.toString('ascii', offset, offset + 4)
    const length = image.readUInt32LE(offset + 4)
    const start = offset + 8
    if (start + length > image.length) return null
    let width = 0,
      height = 0
    if (kind === 'VP8X' && length >= 10) {
      if (image[start] & 0x02) return null // Animated wallpapers never enter the cache.
      width = image.readUIntLE(start + 4, 3) + 1
      height = image.readUIntLE(start + 7, 3) + 1
    } else if (kind === 'VP8 ' && length >= 10) {
      if (image.toString('hex', start + 3, start + 6) !== '9d012a') return null
      width = image.readUInt16LE(start + 6) & 0x3fff
      height = image.readUInt16LE(start + 8) & 0x3fff
      hasPixels = true
    } else if (kind === 'VP8L' && length >= 5 && image[start] === 0x2f) {
      const dimensions = image.readUInt32LE(start + 1)
      width = (dimensions & 0x3fff) + 1
      height = ((dimensions >>> 14) & 0x3fff) + 1
      hasPixels = true
    } else if (kind === 'ICCP') {
      // Chromium's canvas encoder adds its own sRGB profile. Keep this bounded
      // color information; EXIF/XMP and animation chunks remain unsupported.
      if (length > 65_536) return null
    } else if (kind !== 'ALPH') return null
    if (
      kind !== 'ALPH' &&
      kind !== 'ICCP' &&
      (!width || !height || width > 2560 || height > 2560)
    )
      return null
    offset = start + length + (length % 2)
  }
  return hasPixels ? image : null
}
