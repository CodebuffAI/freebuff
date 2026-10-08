import { SHARED_SETTINGS_PAGES } from '../constants/settings-pages'

type Surface = 'desktop' | 'web'
type Topic = { label: string; keywords: string; surface?: Surface }
type PageLabel =
  | (typeof SHARED_SETTINGS_PAGES)[number]['label']
  | 'Browser'
  | 'MCP'
  | 'Updates'
  | 'Account standing'

// Index the settings themselves, including common names people use for them.
// Keep this alongside the shared navigation, without mounting inactive pages or
// fetching account data just to search. Platform-only controls stay scoped.
const topics: Record<PageLabel, Topic[]> = {
  'Keyboard shortcuts': [
    {
      label: 'Keyboard shortcuts',
      keywords: 'keybindings hotkeys terminal panels customize reset keys',
    },
  ],
  General: [
    {
      label: 'Advanced Mode',
      keywords: 'composer mode buttons skills context usage slash commands',
    },
    { label: 'Feedback', keywords: 'report issue bug feature request help' },
    {
      label: 'Include AGENTS.md',
      keywords: 'agent instructions claude.md context rules',
    },
    {
      label: 'Automatically start the next session',
      keywords: 'auto start sessions renew hour',
      surface: 'desktop',
    },
    {
      label: 'Full access',
      keywords: 'permissions approval administrator commands',
      surface: 'desktop',
    },
    {
      label: 'Show in Discord status',
      keywords: 'discord presence playing activity',
      surface: 'desktop',
    },
  ],
  Account: [
    {
      label: 'Name and email',
      keywords: 'profile account personal email address',
    },
    { label: 'Sign out', keywords: 'log out logout' },
    {
      label: 'Sign-in methods',
      keywords: 'login password google github authentication',
      surface: 'web',
    },
    { label: 'Country', keywords: 'region location', surface: 'web' },
    {
      label: 'Delete account',
      keywords: 'remove account data privacy',
      surface: 'web',
    },
  ],
  'Account standing': [
    {
      label: 'Rules and appeals',
      keywords: 'suspension suspended review appeal rules',
      surface: 'web',
    },
  ],
  Usage: [
    {
      label: 'Allowance',
      keywords: 'daily limit quota wallet balance freebucks',
    },
    {
      label: 'Sessions by model',
      keywords: 'session usage history premium free models',
    },
    {
      label: 'Tokens',
      keywords: 'input output cached tokens statistics activity',
    },
  ],
  Billing: [
    {
      label: 'Plans',
      keywords:
        'subscription upgrade downgrade cancel renewal monthly yearly pricing',
    },
    {
      label: 'Buy Freebucks',
      keywords: 'balance wallet purchase credits payment card',
    },
    {
      label: 'Auto top-up',
      keywords: 'auto topup automatic recharge payment',
      surface: 'web',
    },
    { label: 'Prepaid credits', keywords: 'developer api credit balance' },
  ],
  Earn: [
    {
      label: 'Referrals',
      keywords: 'invite friends referral link rewards leaderboard',
    },
    { label: 'Bounties', keywords: 'submissions tasks rewards freebucks' },
    { label: 'Offers', keywords: 'earn rewards freebucks' },
  ],
  Connections: [
    {
      label: 'GitHub',
      keywords: 'connect authorize repository repos integration',
    },
    { label: 'Discord', keywords: 'connect community account integration' },
  ],
  'API Providers': [
    {
      label: 'Provider API key',
      keywords:
        'bring your own key byok openrouter openai anthropic gemini credentials token',
    },
    {
      label: 'Provider base URL',
      keywords: 'endpoint custom server compatible local ollama',
    },
    {
      label: 'Provider model ID',
      keywords: 'model connection context window maximum output tokens',
    },
  ],
  'Developer API': [
    {
      label: 'API keys',
      keywords: 'developer access token secret create revoke key',
    },
    { label: 'API usage', keywords: 'requests credits balance rate limits' },
  ],
  'Project settings': [
    {
      label: 'Startup script',
      keywords: 'setup command install dependencies environment project cloud',
    },
  ],
  Skills: [
    {
      label: 'Your skills',
      keywords:
        'instructions library add create edit import delete skill packages',
    },
  ],
  Appearance: [
    {
      label: 'Theme',
      keywords:
        'dark mode light mode system auto preset colors accent surface text',
    },
    {
      label: 'Interface size',
      keywords: 'font text size zoom scale icons controls',
    },
    { label: 'Wallpaper', keywords: 'background image gradient custom preset' },
    {
      label: 'Panel transparency',
      keywords: 'opacity blur glass style surface fade',
    },
    { label: 'Dithering', keywords: 'pixel size color levels invert image' },
    { label: 'Import and export', keywords: 'theme file save share preset' },
  ],
  Archived: [
    {
      label: 'Archived chats',
      keywords: 'restore unarchive conversations threads history',
    },
  ],
  Browser: [
    {
      label: 'Browser access',
      keywords:
        'import chrome safari edge cookies history bookmarks permissions full disk access',
    },
  ],
  MCP: [
    {
      label: 'Connectors',
      keywords: 'model context protocol servers tools integrations stdio http',
    },
  ],
  Updates: [
    {
      label: 'Version',
      keywords: 'check update download install restart release',
    },
  ],
}

export type SettingsSearchPage = { id: string; label: PageLabel }

function normalize(value: string) {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

// A single missing, extra, or mistyped letter; short words must match literally.
function nearWord(query: string, word: string) {
  if (query.length < 4 || Math.abs(query.length - word.length) > 1) return false
  let edits = 0
  for (let i = 0, j = 0; i < query.length || j < word.length; ) {
    if (query[i] === word[j]) {
      i++
      j++
      continue
    }
    if (++edits > 1) return false
    if (query.length >= word.length) i++
    if (word.length >= query.length) j++
  }
  return true
}

function score(query: string, label: string, keywords = '') {
  const name = normalize(label)
  if (name === query) return 100
  if (name.startsWith(query)) return 90
  if (name.includes(query)) return 80
  const words = normalize(`${label} ${keywords}`).split(' ')
  let fuzzy = false
  for (const token of query.split(' ')) {
    if (words.some((word) => word.startsWith(token))) continue
    if (!words.some((word) => nearWord(token, word))) return 0
    fuzzy = true
  }
  return fuzzy ? 10 : 50
}

export function searchSettings<T extends SettingsSearchPage>(
  query: string,
  pages: readonly T[],
  surface: Surface,
): { page: T; detail?: string }[] {
  const normalized = normalize(query)
  if (!normalized) return query.trim() ? [] : pages.map((page) => ({ page }))
  return pages
    .map((page) => {
      let best = score(normalized, page.label)
      let detail: string | undefined
      for (const topic of topics[page.label]) {
        if (topic.surface && topic.surface !== surface) continue
        const value = score(
          normalized,
          topic.label,
          `${page.label} ${topic.keywords}`,
        )
        if (value > best) {
          best = value
          detail = topic.label
        }
      }
      return { page, detail, score: best }
    })
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score)
}
