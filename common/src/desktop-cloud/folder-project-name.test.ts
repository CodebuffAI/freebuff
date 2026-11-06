import { describe, expect, test } from 'bun:test'
import { folderProjectName } from './folder-project-name'

describe('folderProjectName', () => {
  test('a folder is named after its last segment on either platform', () => {
    expect(folderProjectName('/Users/me/code/app')).toBe('app')
    expect(folderProjectName('/Users/me/code/app/')).toBe('app')
    expect(folderProjectName('C:\\Users\\me\\app')).toBe('app')
    expect(folderProjectName('C:\\Users\\me\\app\\')).toBe('app')
    expect(folderProjectName('\\\\server\\share\\app')).toBe('app')
  })

  test('a drive root is named after its drive, and the POSIX root is /', () => {
    expect(folderProjectName('R:\\')).toBe('R:')
    expect(folderProjectName('R:/')).toBe('R:')
    expect(folderProjectName('R:')).toBe('R:')
    expect(folderProjectName('/')).toBe('/')
  })

  test('an empty path has no name', () => {
    expect(folderProjectName('')).toBeNull()
  })
})
