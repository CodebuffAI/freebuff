import { expect, test } from 'bun:test'
import { SHARED_SETTINGS_PAGES } from '../constants/settings-pages'
import { searchSettings } from './settings-search'

const search = (query: string, surface: 'desktop' | 'web' = 'web') =>
  searchSettings(query, SHARED_SETTINGS_PAGES, surface)

test('finds controls on unopened pages using their names and everyday terms', () => {
  for (const [query, page, detail] of [
    ['dark mode', 'appearance', 'Theme'],
    ['font size', 'appearance', 'Interface size'],
    ['startup script', 'projects', 'Startup script'],
    ['byok', 'providers', 'Provider API key'],
    ['auto topup', 'billing', 'Auto top-up'],
    ['unarchive', 'archived', 'Archived chats'],
    ['claude.md', 'general', 'Include AGENTS.md'],
    ['invite friends', 'earn', 'Referrals'],
  ]) {
    const result = search(query!)[0]
    expect(result?.page.id).toBe(page)
    expect(result?.detail).toBe(detail)
  }
})

test('normalizes case, punctuation and whitespace, and tolerates a mistyped letter', () => {
  expect(search('  DÁRK   mode  ')[0]?.page.id).toBe('appearance')
  expect(search('api-key').map(({ page }) => page.id)).toContain('providers')
  expect(search('apperance')[0]?.page.id).toBe('appearance')
  expect(search('statup script')[0]?.page.id).toBe('projects')
  expect(search('ap').map(({ page }) => page.id)).toEqual(
    expect.arrayContaining(['appearance', 'providers', 'api']),
  )
})

test('ranks exact page names above topic aliases and requires every word to match', () => {
  expect(search('Account')[0]).toMatchObject({
    page: { id: 'account' },
    detail: undefined,
  })
  expect(search('skills')[0]?.page.id).toBe('skills')
  expect(search('startup wallpaper')).toEqual([])
  expect(search('unknown-setting-xyz')).toEqual([])
  expect(search('???')).toEqual([])
  expect(search('  ').map(({ page }) => page)).toEqual([
    ...SHARED_SETTINGS_PAGES,
  ])
})

test('only searches available pages and controls on the current surface', () => {
  expect(search('full access', 'web')).toEqual([])
  expect(search('full access', 'desktop')[0]?.page.id).toBe('general')
  expect(search('delete account', 'desktop')).toEqual([])
  expect(search('delete account', 'web')[0]?.page.id).toBe('account')
  const guest = SHARED_SETTINGS_PAGES.filter(
    ({ id }) => id === 'general' || id === 'appearance',
  )
  expect(searchSettings('api key', guest, 'web')).toEqual([])
  expect(searchSettings('dark mode', guest, 'web')[0]?.page.id).toBe(
    'appearance',
  )
})
