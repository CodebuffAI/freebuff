import { describe, expect, test } from 'bun:test'
import {
  gravitySidebarAssets,
  gravitySidebarPlacementId,
  internalGravitySidebarPlacementId,
  isGravitySidebarRequest,
} from './gravity-sidebar'

const SIDEBAR = 'Desktop-Billboard-Sidebar'
const asset = { url: 'https://cdn.example/ad.webp', width: 640, height: 480 }
describe('Gravity sidebar contract', () => {
  test('only sidebar-only requests open to Gravity', () => {
    expect(isGravitySidebarRequest([SIDEBAR])).toBe(true)
    expect(isGravitySidebarRequest([`${SIDEBAR}:web`])).toBe(true)
    for (const ids of [
      [],
      ['Desktop-Billboard-Panel'],
      [SIDEBAR, 'Desktop-Billboard-Panel'],
      [SIDEBAR, 'Desktop-Inline-Chat'],
    ])
      expect(isGravitySidebarRequest(ids)).toBe(false)
  })
  test('new Gravity names round-trip to stable internal placement IDs', () => {
    for (const [internal, external] of [
      [SIDEBAR, 'Sidebar-Desktop'],
      [`${SIDEBAR}:web`, 'Sidebar-Web'],
    ] as const) {
      expect(gravitySidebarPlacementId(internal)).toBe(external)
      expect(internalGravitySidebarPlacementId(external)).toBe(internal)
    }
  })
  test('historical response labels and unrelated placements remain compatible', () => {
    expect(internalGravitySidebarPlacementId('sidebar-desktop')).toBe(SIDEBAR)
    expect(internalGravitySidebarPlacementId('sidebar-web')).toBe(
      `${SIDEBAR}:web`,
    )
    expect(internalGravitySidebarPlacementId('billboard-sidebar-desktop')).toBe(
      SIDEBAR,
    )
    expect(internalGravitySidebarPlacementId('billboard-sidebar-web')).toBe(
      `${SIDEBAR}:web`,
    )
    expect(internalGravitySidebarPlacementId(`${SIDEBAR}-web`)).toBe(
      `${SIDEBAR}:web`,
    )
    expect(internalGravitySidebarPlacementId(SIDEBAR)).toBe(SIDEBAR)
    expect(internalGravitySidebarPlacementId(`${SIDEBAR}:web`)).toBe(
      `${SIDEBAR}:web`,
    )
    for (const id of [
      'Desktop-Billboard-Panel',
      'Desktop-Inline-Chat',
      'unknown',
    ]) {
      expect(gravitySidebarPlacementId(id)).toBe(id)
      expect(internalGravitySidebarPlacementId(id)).toBe(id)
    }
  })
  test('requires full, correctly sized HTTPS artwork; drops unknown shapes', () => {
    expect(
      gravitySidebarAssets({ sidebar: asset, panel_square: asset }),
    ).toEqual({ sidebar: asset })
    for (const patch of [
      { width: 320 },
      { height: 640 },
      { width: Infinity },
      { width: NaN },
      { width: 640.1 },
      { url: 'http://cdn.example/a.webp' },
      { url: 'https://user:pass@cdn.example/a.webp' },
      { url: 'javascript:alert(1)' },
      { url: 'https://cdn.example:8080/a.webp' },
    ])
      expect(
        gravitySidebarAssets({ sidebar: { ...asset, ...patch } }),
      ).toBeUndefined()
    for (const raw of [
      undefined,
      null,
      {},
      { brandImage: asset.url },
      { panel_square: asset },
    ])
      expect(gravitySidebarAssets(raw)).toBeUndefined()
  })
})
