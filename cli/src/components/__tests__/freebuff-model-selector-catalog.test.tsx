import fs from 'fs'
import os from 'os'
import path from 'path'

import { freebucksFixture } from '@codebuff/common/testing/freebuff'
import { createTestRenderer } from '@opentui/core/testing'
import { createRoot, flushSync } from '@opentui/react'
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from 'bun:test'
import React from 'react'

import { initializeThemeStore } from '../../hooks/use-theme'
import { setFreebuffCatalog } from '../../state/freebuff-catalog-store'
import {
  getSelectedFreebuffModel,
  useFreebuffModelStore,
} from '../../state/freebuff-model-store'
import { useFreebuffSessionStore } from '../../state/freebuff-session-store'
import * as auth from '../../utils/auth'
import * as openUrl from '../../utils/open-url'
import {
  catalogFixture,
  catalogRow,
} from '../../utils/__tests__/freebuff-catalog-fixtures'
import { FreebuffModelSelector } from '../freebuff-model-selector'

/**
 * The picker in catalog mode (docs/freebuff-model-catalog.md): every row,
 * pill, lock, ladder and step-down comes from the server catalog, and every
 * row id is a catalog key. Fallback mode is the rest of the picker's suite,
 * which runs with no catalog held.
 */

const FIXED_NOW_MS = Date.UTC(2026, 7, 20, 19, 0, 0)

const CATALOG = catalogFixture(
  [
    catalogRow('m-hero', {
      displayName: 'Hero Model',
      tagline: 'The default',
      badges: [
        { kind: 'new', label: 'New', tooltip: 'Retrained this week.' },
        {
          kind: 'price',
          label: 'Price',
          tooltip: 'Launch rate; may change.',
          tone: 'warning',
        },
      ],
      multimodal: true,
      premium: true,
    }),
    catalogRow('m-cheap', {
      displayName: 'Cheap Model',
      tagline: 'Quick',
      warning: 'Trains on your prompts',
      efforts: ['low', 'high', 'max'],
      defaultEffort: 'high',
    }),
    catalogRow('m-future', {
      displayName: 'Future Model',
      tagline: 'Catalog only',
      badges: [{ kind: 'sparkly-unknown', label: 'Beta', tone: 'glitter' }],
    }),
    catalogRow('m-locked', {
      displayName: 'Locked Model',
      tagline: 'Frontier',
      access: 'locked',
      lockedLabel: 'Pro plan',
      lockedTooltip: 'Included with Pro.',
    }),
  ],
  {
    recommendedKey: 'm-hero',
    fallbackKey: 'm-cheap',
    plansUrl: 'https://freebuff.com/plans?from=catalog',
  },
)

let cleanupRenderer: (() => void) | undefined
let configDir: string
let configSpy: ReturnType<typeof spyOn>

beforeAll(() => {
  initializeThemeStore()
})

beforeEach(() => {
  // A reasoning pick persists; keep it out of the real settings file.
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuff-picker-test-'))
  configSpy = spyOn(auth, 'getConfigDir').mockReturnValue(configDir)
  setFreebuffCatalog(CATALOG)
})

afterEach(() => {
  cleanupRenderer?.()
  cleanupRenderer = undefined
  useFreebuffSessionStore.getState().setSession(null)
  setFreebuffCatalog(null)
  useFreebuffModelStore.setState({ reasoningEffortByModel: {} })
  useFreebuffModelStore.getState().setSelectedModel('mimo/mimo-v2.5')
  configSpy.mockRestore()
  fs.rmSync(configDir, { recursive: true, force: true })
})

const render = async (
  opts: {
    selected?: string
    session?: Record<string, unknown>
    onSelectModel?: (model: string) => void
    startSession?: (model: string) => Promise<void>
  } = {},
) => {
  cleanupRenderer?.()
  useFreebuffSessionStore
    .getState()
    .setSession((opts.session ?? { status: 'none', accessTier: 'full' }) as never)
  useFreebuffModelStore.getState().setSelectedModel(opts.selected ?? 'm-hero')
  const setup = await createTestRenderer({
    width: 110,
    height: 50,
    kittyKeyboard: true,
  })
  const root = createRoot(setup.renderer)
  cleanupRenderer = () => {
    flushSync(() => root.unmount())
    setup.renderer.destroy()
  }
  flushSync(() =>
    root.render(
      <FreebuffModelSelector
        maxHeight={45}
        nowMs={FIXED_NOW_MS}
        onSelectModel={opts.onSelectModel}
        startSession={opts.startSession}
      />,
    ),
  )
  await setup.renderOnce()
  return setup
}

const lineWith = (frame: string, text: string) =>
  frame.split('\n').find((line) => line.includes(text)) ?? ''
const lineAfter = (frame: string, text: string) => {
  const lines = frame.split('\n')
  return lines[lines.findIndex((line) => line.includes(text)) + 1] ?? ''
}

describe('catalog rows', () => {
  test('lists every row the server sent, catalog-only rows included', async () => {
    const setup = await render({ onSelectModel: () => {} })
    const frame = setup.captureCharFrame()
    for (const name of ['Hero Model', 'Cheap Model', 'Future Model', 'Locked Model'])
      expect(frame).toContain(name)
  })

  test('draws every pill generically after the tagline, and Images for multimodal', async () => {
    const setup = await render({ onSelectModel: () => {} })
    const frame = setup.captureCharFrame()
    expect(lineWith(frame, 'Hero Model')).toContain(
      'The default · Images · New · Price',
    )
    // An unknown kind and tone still renders: a new pill is a server change.
    expect(lineWith(frame, 'Future Model')).toContain('Catalog only · Beta')
    expect(lineAfter(frame, 'Cheap Model')).toContain('Trains on your prompts')
  })

  test('prints the focused row’s tooltips, and only that row’s', async () => {
    const setup = await render({ onSelectModel: () => {} })
    let frame = setup.captureCharFrame()
    expect(frame).toContain('Retrained this week.')
    expect(frame).toContain('Launch rate; may change.')
    flushSync(() => setup.mockInput.pressKey('ARROW_DOWN'))
    await setup.renderOnce()
    frame = setup.captureCharFrame()
    expect(frame).not.toContain('Retrained this week.')
  })

  test('a price notice for the key replaces its tagline', async () => {
    const setup = await render({
      onSelectModel: () => {},
      session: {
        status: 'none',
        accessTier: 'full',
        freebucks: {
          ...freebucksFixture(100, { 'm-hero': 10, 'm-cheap': 5, 'm-future': 20 }),
          priceNotices: { 'm-cheap': 'Half price today' },
        },
      },
    })
    expect(lineWith(setup.captureCharFrame(), 'Cheap Model')).toContain(
      'Half price today',
    )
  })

  test('sorts cheapest first by the key-priced meter, locked and unpriced last', async () => {
    const setup = await render({
      onSelectModel: () => {},
      session: {
        status: 'none',
        accessTier: 'full',
        freebucks: freebucksFixture(100, {
          'm-hero': 20,
          'm-cheap': 5,
          'm-future': 10,
        }),
      },
    })
    const frame = setup.captureCharFrame()
    const order = ['Cheap Model', 'Future Model', 'Hero Model', 'Locked Model']
      .map((name) => frame.indexOf(name))
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(lineAfter(frame, 'Cheap Model')).toContain('5 Freebucks/hr')
  })
})

describe('the collapsed landing', () => {
  test('opens on the recommended key as its hero', async () => {
    const setup = await render({ selected: 'm-hero' })
    const frame = setup.captureCharFrame()
    expect(frame).toContain('Hero Model')
    expect(frame).not.toContain('Cheap Model')
    expect(frame).toContain('See all 4 models')
  })

  test('steps down to the fallback key when the hero cannot start', async () => {
    const setup = await render({
      selected: 'm-hero',
      session: {
        status: 'none',
        accessTier: 'full',
        // The hero costs more than the balance; the step-down row does not.
        freebucks: freebucksFixture(5, {
          'm-hero': 50,
          'm-future': 1,
          'm-cheap': 5,
        }),
      },
    })
    await setup.renderOnce()
    expect(getSelectedFreebuffModel()).toBe('m-cheap')
  })
})

describe('a locked row', () => {
  const focusLocked = async (
    startSession: (model: string) => Promise<void>,
  ) => {
    const setup = await render({ selected: 'm-hero', startSession })
    // Expand, then walk to the locked row.
    for (let i = 0; i < 20; i++) {
      if (setup.captureCharFrame().includes('› Locked Model')) break
      if (setup.captureCharFrame().includes('See all')) {
        flushSync(() => setup.mockInput.pressKey('ARROW_DOWN'))
        await setup.renderOnce()
        flushSync(() => setup.mockInput.pressEnter())
        await setup.renderOnce()
        continue
      }
      flushSync(() => setup.mockInput.pressKey('ARROW_DOWN'))
      await setup.renderOnce()
    }
    expect(setup.captureCharFrame()).toContain('› Locked Model')
    return setup
  }

  test('shows its locked label and tooltip, no price', async () => {
    const setup = await focusLocked(async () => {})
    const frame = setup.captureCharFrame()
    expect(lineAfter(frame, 'Locked Model')).toContain('Pro plan')
    expect(lineAfter(frame, 'Locked Model')).not.toContain('Freebucks/hr')
    expect(frame).toContain('Included with Pro.')
  })

  test('explains on the first press, opens the catalog plans page on the second, never starts', async () => {
    const openSpy = spyOn(openUrl, 'safeOpen').mockResolvedValue(true)
    const started: string[] = []
    try {
      const setup = await focusLocked(async (model) => {
        started.push(model)
      })
      flushSync(() => setup.mockInput.pressEnter())
      await setup.renderOnce()
      expect(setup.captureCharFrame()).toContain(
        'Included with a paid plan. Enter opens plans.',
      )
      flushSync(() => setup.mockInput.pressEnter())
      await setup.renderOnce()
      expect(openSpy).toHaveBeenCalledWith(
        'https://freebuff.com/plans?from=catalog',
      )
      expect(started).toEqual([])
    } finally {
      openSpy.mockRestore()
    }
  })
})

describe('the reasoning submenu', () => {
  test('offers the row ladder with its default, and saves per key', async () => {
    // Spied like the compiled picker's Tab test: the real setter also writes
    // the settings file, and CI's NODE_ENV=production run shares one process
    // (and one settings file) across every test file.
    const previous = useFreebuffModelStore.getState().reasoningEffortByModel
    useFreebuffModelStore.setState({ reasoningEffortByModel: {} })
    const saves: Array<[string, string | undefined]> = []
    const persist = spyOn(
      useFreebuffModelStore.getState(),
      'setReasoningEffort',
    ).mockImplementation((id, effort) => {
      saves.push([id, effort])
      useFreebuffModelStore.setState({
        reasoningEffortByModel: effort ? { [id]: effort } : {},
      })
    })
    try {
      const setup = await render({
        selected: 'm-cheap',
        onSelectModel: () => {},
      })
      expect(lineWith(setup.captureCharFrame(), 'Cheap Model')).toContain(
        'Cheap Model • high',
      )
      flushSync(() => setup.mockInput.pressKey('TAB'))
      await setup.renderOnce()
      const frame = setup.captureCharFrame()
      expect(frame).toContain('Cheap Model • Reasoning')
      expect(frame).toContain('low')
      expect(frame).toContain('high (default)')
      expect(frame).toContain('max')
      flushSync(() => setup.mockInput.pressKey('ARROW_DOWN'))
      await setup.renderOnce()
      flushSync(() => setup.mockInput.pressEnter())
      await setup.renderOnce()
      expect(saves).toEqual([['m-cheap', 'max']])
    } finally {
      persist.mockRestore()
      useFreebuffModelStore.setState({ reasoningEffortByModel: previous })
    }
  })

  test('a row with no ladder opens no submenu', async () => {
    const setup = await render({ selected: 'm-future', onSelectModel: () => {} })
    flushSync(() => setup.mockInput.pressKey('TAB'))
    await setup.renderOnce()
    expect(setup.captureCharFrame()).not.toContain('• Reasoning')
  })
})
