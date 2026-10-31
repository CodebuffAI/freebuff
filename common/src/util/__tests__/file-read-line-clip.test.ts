import { describe, expect, it } from 'bun:test'

import {
  clipLongLine,
  MAX_READ_LINE_CHARS,
  windowFileRead,
} from '../file-read-limits'

describe('long line clipping', () => {
  const long = 'x'.repeat(MAX_READ_LINE_CHARS + 500)

  it('leaves a line at the limit alone and says what it cut', () => {
    expect(clipLongLine('short')).toBe('short')
    expect(clipLongLine('x'.repeat(MAX_READ_LINE_CHARS))).toHaveLength(
      MAX_READ_LINE_CHARS,
    )
    expect(clipLongLine(long)).toEndWith('[line clipped: 500 more characters]')
  })

  it('clips a whole-file read and keeps its other lines', () => {
    const read = windowFileRead(`first\n${long}\nlast\n`)
    expect(read.startsWith('first\nxxx')).toBe(true)
    expect(read).toContain('[line clipped: 500 more characters]\nlast')
    expect(read).toEndWith('the clip marker is not part of the file.]')
  })

  it('notes clipping in a windowed read footer', () => {
    const read = windowFileRead(`first\n${long}\nlast\n`, 2, 1)
    expect(read).toContain('showing lines 2-2 of 3. Lines over')
  })

  it('returns a file with no long line unchanged', () => {
    const content = 'first\nlast\n'
    expect(windowFileRead(content)).toBe(content)
  })
})
