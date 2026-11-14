import { describe, expect, test } from 'bun:test'

import {
  projectFileKind,
  safeProjectFileName,
  uniqueProjectFileName,
  validProjectFileName,
} from './project-files'

describe('project file names', () => {
  test('a plain file name is accepted; paths, hidden and control names are not', () => {
    expect(validProjectFileName('report.pdf')).toBe(true)
    expect(validProjectFileName('Q3 budget (final).xlsx')).toBe(true)
    expect(validProjectFileName('a/b.txt')).toBe(false)
    expect(validProjectFileName('a\\b.txt')).toBe(false)
    expect(validProjectFileName('.env')).toBe(false)
    expect(validProjectFileName('..')).toBe(false)
    expect(validProjectFileName('')).toBe(false)
    expect(validProjectFileName(' padded.txt')).toBe(false)
    expect(validProjectFileName('bad\u0000name')).toBe(false)
    expect(validProjectFileName('a'.repeat(201))).toBe(false)
  })

  test('a browser name is made safe rather than refused', () => {
    expect(safeProjectFileName('photos/holiday:1.jpg')).toBe('photos-holiday-1.jpg')
    expect(safeProjectFileName('.hidden')).toBe('hidden')
    expect(safeProjectFileName('   ')).toBe('file')
    expect(validProjectFileName(safeProjectFileName('weird<>name|?.txt'))).toBe(true)
  })

  test('a duplicate name is numbered before its extension', () => {
    const taken = new Set(['notes.md', 'notes (2).md'])
    expect(uniqueProjectFileName('notes.md', taken)).toBe('notes (3).md')
    expect(uniqueProjectFileName('fresh.md', taken)).toBe('fresh.md')
    expect(uniqueProjectFileName('README', new Set(['README']))).toBe('README (2)')
  })

  test('kinds follow the media type, then the extension', () => {
    expect(projectFileKind({ name: 'x', mediaType: 'image/png' })).toBe('image')
    expect(projectFileKind({ name: 'photo.JPG', mediaType: '' })).toBe('image')
    expect(projectFileKind({ name: 'deck.pptx', mediaType: 'application/octet-stream' })).toBe('document')
    expect(projectFileKind({ name: 'data.csv', mediaType: 'text/csv' })).toBe('document')
    expect(projectFileKind({ name: 'archive.zip', mediaType: 'application/zip' })).toBe('file')
  })
})
