import { describe, expect, test } from 'bun:test'

import {
  SPONSORED_PARTIAL_EDITS_COPY,
  SPONSORED_PARTIAL_EDITS_MARKER,
  clientRunsSponsoredInPlace,
  sponsoredInPlaceVerdict,
  sponsoredPartialEditsDiagnostic,
  sponsoredRowOfferedInPlace,
  type SponsoredTurnEnding,
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

describe('sponsoredInPlaceVerdict', () => {
  const endings: SponsoredTurnEnding[] = [
    'completed',
    'stopped',
    'closed',
    'interrupted',
    'error',
    'grant_expired',
  ]

  for (const ending of endings) {
    for (const modelRan of [true, false, undefined]) {
      for (const editedFileCount of [0, 1, 3]) {
        const expected =
          editedFileCount > 0 && modelRan !== false
            ? ending === 'completed'
              ? 'delivered'
              : 'partial_edits'
            : modelRan === false
              ? 'model_never_ran'
              : 'no_edits'
        test(`${ending} x ${editedFileCount} files x modelRan=${String(
          modelRan,
        )} is ${expected}`, () => {
          expect(
            sponsoredInPlaceVerdict({ ending, editedFileCount, modelRan }),
          ).toBe(expected)
        })
      }
    }
  }

  test('only a completed turn with edits is delivered', () => {
    expect(
      sponsoredInPlaceVerdict({ ending: 'completed', editedFileCount: 2 }),
    ).toBe('delivered')
    expect(
      sponsoredInPlaceVerdict({ ending: 'error', editedFileCount: 2 }),
    ).toBe('partial_edits')
    expect(
      sponsoredInPlaceVerdict({
        ending: 'completed',
        editedFileCount: 2,
        modelRan: false,
      }),
    ).toBe('model_never_ran')
  })
})

describe('the partial-edits diagnostic and copy', () => {
  test('matches the text Desktop has written, byte for byte', () => {
    expect(sponsoredPartialEditsDiagnostic('turn interrupted', 2)).toBe(
      'turn interrupted; the turn ended early, so its partial changes (2 files) were left in the workspace and not reported as delivered',
    )
    expect(sponsoredPartialEditsDiagnostic('turn stopped', 1)).toBe(
      'turn stopped; the turn ended early, so its partial changes (1 file) were left in the workspace and not reported as delivered',
    )
  })

  test('carries the marker the funnel classifier keys on', () => {
    expect(sponsoredPartialEditsDiagnostic('turn error: boom', 4)).toContain(
      SPONSORED_PARTIAL_EDITS_MARKER,
    )
  })

  test('the copy says the partial changes are still there', () => {
    for (const copy of Object.values(SPONSORED_PARTIAL_EDITS_COPY)) {
      expect(copy).toContain('still in your files')
    }
    expect(SPONSORED_PARTIAL_EDITS_COPY.interrupted).toStartWith(
      'The sponsored task was interrupted',
    )
    expect(SPONSORED_PARTIAL_EDITS_COPY.failed).toStartWith(
      'The sponsored task failed',
    )
  })
})
