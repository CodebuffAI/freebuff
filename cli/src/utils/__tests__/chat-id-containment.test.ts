import { afterAll, describe, expect, test } from 'bun:test'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { resolveRequestedChatDir } from '../run-state-storage'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-chat-id-'))
const chatsDir = path.join(root, 'chats')
const outsideDir = path.join(root, 'outside')
const chatId = '2026-11-24T06-00-00.000Z'

fs.mkdirSync(path.join(chatsDir, chatId), { recursive: true })
fs.mkdirSync(outsideDir)
fs.writeFileSync(path.join(chatsDir, 'not-a-folder'), '')
fs.symlinkSync(outsideDir, path.join(chatsDir, 'link-out'), 'dir')

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('resolveRequestedChatDir', () => {
  test('a chat id names its folder inside the chats directory', () => {
    expect(resolveRequestedChatDir(chatsDir, chatId)).toBe(
      path.join(chatsDir, chatId),
    )
    expect(resolveRequestedChatDir(chatsDir, ` ${chatId} `)).toBe(
      path.join(chatsDir, chatId),
    )
  })

  test('an id that leaves the chats directory names nothing', () => {
    for (const id of [
      '../outside',
      '../outside/',
      `${chatId}/../../outside`,
      '..',
      '.',
      outsideDir,
      '..\\outside',
      'link-out',
    ]) {
      expect(resolveRequestedChatDir(chatsDir, id)).toBeNull()
    }
  })

  test('a missing id or a file where a folder was expected names nothing', () => {
    expect(resolveRequestedChatDir(chatsDir, '')).toBeNull()
    expect(resolveRequestedChatDir(chatsDir, 'no-such-chat')).toBeNull()
    expect(resolveRequestedChatDir(chatsDir, 'not-a-folder')).toBeNull()
  })
})
