import { afterEach, beforeAll, expect, test } from 'bun:test'
import { createTestRenderer } from '@opentui/core/testing'
import { createRoot, flushSync } from '@opentui/react'
import React, { useState } from 'react'
import {
  usePartnerSuggestion,
  PARTNER_REVIEW_ITEM_ID,
} from '../use-partner-suggestion'
import {
  useChatKeyboard,
  type ChatKeyboardHandlers,
} from '../use-chat-keyboard'
import {
  SuggestionMenu,
  type SuggestionItem,
} from '../../components/suggestion-menu'
import { createDefaultChatKeyboardState } from '../../utils/keyboard-actions'
import { initializeThemeStore } from '../use-theme'
import { useChatStore } from '../../state/chat-store'
import { createEngagementRegistry } from '../../ads/ad-engagement'
import { setAdEngagementRegistryForTests } from '../../ads/use-ad-engagement'
import type { AdResponse } from '../use-gravity-ad'
import type { AdEngagement } from '@codebuff/common/types/ad-client-context'

beforeAll(initializeThemeStore)
afterEach(() => {
  setAdEngagementRegistryForTests(null)
  useChatStore.getState().reset()
})
const commands = [
  { id: 'plan', label: 'plan', description: 'Plan work' },
  { id: 'review', label: 'review', description: 'Review work' },
  { id: 'queue', label: 'queue', description: 'Queued work' },
]
const fill: AdResponse = {
  title: 'Greptile review',
  adText: '',
  cta: '',
  favicon: '',
  url: 'https://greptile.com',
  clickUrl: 'test-only:partner',
  impUrl: 'partner-keyboard',
  partnerBrand: 'greptile',
  brandColor: '#28E99F',
  brandInk: '#0A0A0A',
}

test('arrows traverse the filled ad, Enter activates it, and Tab never inserts it', async () => {
  useChatStore.setState({ inputValue: '/', cursorPosition: 1 })
  const records: AdEngagement[] = []
  setAdEngagementRegistryForTests(
    createEngagementRegistry({
      now: () => 0,
      send: (r) => records.push(r),
      focus: () => ({ supported: false, focused: null }),
    }),
  )
  let resolve!: (ad: AdResponse | null) => void
  const answer = new Promise<AdResponse | null>((r) => {
    resolve = r
  })
  let calls = 0
  const fetchAd = async () => {
    calls++
    return answer
  }
  let selectedId = ''
  let currentItems: SuggestionItem[] = []
  const executed: string[] = []
  const completed: string[] = []
  function Harness({ enabled = true }: { enabled?: boolean }) {
    const [selectedIndex, setSelectedIndex] = useState(2)
    const items = usePartnerSuggestion({
      items: commands,
      selectedIndex,
      setSelectedIndex,
      maxVisible: 5,
      enabled,
      fetchAd,
    })
    currentItems = items
    selectedId = items[selectedIndex]?.id ?? ''
    useChatKeyboard({
      state: {
        ...createDefaultChatKeyboardState(),
        inputValue: '/',
        cursorPosition: 1,
        slashMenuActive: true,
        slashSelectedIndex: selectedIndex,
        slashMatchesLength: items.length,
      },
      handlers: {
        onSlashMenuDown: () => setSelectedIndex((i) => i + 1),
        onSlashMenuUp: () => setSelectedIndex((i) => i - 1),
        onSlashMenuSelect: () => {
          const row = items[selectedIndex]!
          if (row.activate) row.activate()
          else executed.push(row.id)
        },
        onSlashMenuComplete: () => {
          const row = items[selectedIndex]!
          if (!row.activate) completed.push(row.id)
        },
      } as ChatKeyboardHandlers,
    })
    return (
      <SuggestionMenu
        items={items}
        selectedIndex={selectedIndex}
        maxVisible={5}
      />
    )
  }
  const setup = await createTestRenderer({ width: 80, height: 6 })
  const root = createRoot(setup.renderer)
  // React's scheduler needs macrotasks for async fills and keyboard updates.
  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      await setup.renderOnce()
      await new Promise((resolve) => setTimeout(resolve, 0))
      flushSync(() => {})
    }
    await setup.renderOnce()
  }
  try {
    flushSync(() => root.render(<Harness />))
    await settle()
    expect(calls).toBe(1)
    resolve(fill)
    await settle()
    expect(currentItems.map((i) => i.id)).toEqual([
      'plan',
      'review',
      PARTNER_REVIEW_ITEM_ID,
      'queue',
    ])
    expect(selectedId).toBe('queue') // late arrival preserves the chosen command
    await setup.mockInput.pressArrow('up')
    await settle()
    expect(selectedId).toBe(PARTNER_REVIEW_ITEM_ID)
    expect(setup.captureCharFrame()).toContain('› Greptile review')
    await setup.mockInput.pressTab()
    await setup.mockInput.pressEnter()
    await settle()
    expect(executed).toEqual([])
    expect(completed).toEqual([])
    expect(useChatStore.getState().inputValue).toBe('/')
    expect(records.some((r) => r.click?.count === 1)).toBe(true)
    await setup.mockInput.pressArrow('up')
    await settle()
    expect(selectedId).toBe('review')
    await setup.mockInput.pressArrow('down')
    await settle()
    await setup.mockInput.pressArrow('down')
    await settle()
    expect(selectedId).toBe('queue')
    await setup.mockInput.pressEnter()
    expect(executed).toEqual(['queue'])
    flushSync(() => root.render(<Harness enabled={false} />))
    await settle()
    expect(currentItems.map((i) => i.id)).toEqual(['plan', 'review', 'queue'])
    expect(selectedId).toBe('queue')
  } finally {
    flushSync(() => root.unmount())
    setup.renderer.destroy()
  }
})

test('no fill creates no menu position; an offscreen review never fetches', async () => {
  let calls = 0
  const fetchAd = async () => {
    calls++
    return null
  }
  let currentItems: SuggestionItem[] = []
  function Harness({ index }: { index: number }) {
    currentItems = usePartnerSuggestion({
      items: commands,
      selectedIndex: index,
      setSelectedIndex: () => {},
      maxVisible: 1,
      enabled: true,
      fetchAd,
    })
    return (
      <SuggestionMenu
        items={currentItems}
        selectedIndex={index}
        maxVisible={1}
      />
    )
  }
  const setup = await createTestRenderer({ width: 80, height: 3 })
  const root = createRoot(setup.renderer)
  try {
    flushSync(() => root.render(<Harness index={0} />))
    await setup.renderOnce()
    expect(calls).toBe(0)
    flushSync(() => root.render(<Harness index={1} />))
    await setup.renderOnce()
    expect(calls).toBe(1)
    expect(currentItems).toBe(commands)
  } finally {
    flushSync(() => root.unmount())
    setup.renderer.destroy()
  }
})
