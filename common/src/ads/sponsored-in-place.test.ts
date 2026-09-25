import { describe, expect, test } from 'bun:test'

import {
  clientRunsSponsoredInPlace,
  sponsoredRowOfferedInPlace,
} from './sponsored-in-place'

describe('in-place execution', () => {
  test('only the exact version runs in place', () => {
    expect(clientRunsSponsoredInPlace(1)).toBe(true)
    for (const value of [undefined, 0, 2, '1', true])
      expect(clientRunsSponsoredInPlace(value)).toBe(false)
  })

  test('a generic folder-keyed row was offered in place; nothing else was', () => {
    expect(
      sponsoredRowOfferedInPlace({
        deliveryKind: 'generic',
        target: { kind: 'workspace' },
      }),
    ).toBe(true)
    // A generic repository-keyed row is the worktree flow's.
    expect(
      sponsoredRowOfferedInPlace({
        deliveryKind: 'generic',
        target: { kind: 'repo' },
      }),
    ).toBe(false)
    // The legacy Supabase format keys a remote-less folder by workspace for
    // its own worktree flow.
    for (const deliveryKind of [undefined, null, 'supabase'])
      expect(
        sponsoredRowOfferedInPlace({
          deliveryKind,
          target: { kind: 'workspace' },
        }),
      ).toBe(false)
    expect(
      sponsoredRowOfferedInPlace({ deliveryKind: 'generic', target: null }),
    ).toBe(false)
  })
})
