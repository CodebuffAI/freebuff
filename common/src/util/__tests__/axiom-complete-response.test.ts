import { describe, expect, test } from 'bun:test'

import {
  assertCompleteAxiomResponse,
  isCompleteAxiomResponse,
} from '../axiom-complete-response'

describe('isCompleteAxiomResponse', () => {
  test('accepts only an explicit isPartial: false', () => {
    expect(isCompleteAxiomResponse({ status: { isPartial: false } })).toBe(true)
    expect(
      isCompleteAxiomResponse({ status: { isPartial: false }, tables: [] }),
    ).toBe(true)
  })

  test('a partial answer is refused', () => {
    expect(isCompleteAxiomResponse({ status: { isPartial: true } })).toBe(false)
  })

  test('a statusless answer is refused, not trusted', () => {
    // A well-formed body with no status is the shape a truncated or proxied
    // answer takes. Silence is not completeness.
    expect(isCompleteAxiomResponse({ buckets: { totals: [] } })).toBe(false)
    expect(isCompleteAxiomResponse({ status: {} })).toBe(false)
    expect(isCompleteAxiomResponse({ status: null })).toBe(false)
    expect(isCompleteAxiomResponse({ status: { isPartial: undefined } })).toBe(
      false,
    )
  })

  test('a non-boolean isPartial is refused', () => {
    expect(isCompleteAxiomResponse({ status: { isPartial: 'false' } })).toBe(
      false,
    )
    expect(isCompleteAxiomResponse({ status: { isPartial: 0 } })).toBe(false)
  })

  test('anything that is not an object is refused', () => {
    expect(isCompleteAxiomResponse(null)).toBe(false)
    expect(isCompleteAxiomResponse(undefined)).toBe(false)
    expect(isCompleteAxiomResponse('ok')).toBe(false)
    expect(isCompleteAxiomResponse([])).toBe(false)
  })
})

describe('assertCompleteAxiomResponse', () => {
  test('does not throw for a complete response', () => {
    expect(() =>
      assertCompleteAxiomResponse({ status: { isPartial: false } }, 'hour 12'),
    ).not.toThrow()
  })

  test('throws for a partial response with the caller name', () => {
    expect(() =>
      assertCompleteAxiomResponse({ status: { isPartial: true } }, 'hour 12'),
    ).toThrow(/^hour 12: Axiom returned a partial or statusless answer$/)
  })

  test('throws for a statusless response — not just partials', () => {
    expect(() =>
      assertCompleteAxiomResponse({ buckets: { totals: [] } }, 'hour 12'),
    ).toThrow(/^hour 12: Axiom returned a partial or statusless answer$/)

    expect(() =>
      assertCompleteAxiomResponse({ status: {} }, 'hour 12'),
    ).toThrow(/^hour 12: Axiom returned a partial or statusless answer$/)

    expect(() =>
      assertCompleteAxiomResponse({ status: null }, 'hour 12'),
    ).toThrow(/^hour 12: Axiom returned a partial or statusless answer$/)
  })

  test('throws for non-object inputs', () => {
    expect(() =>
      assertCompleteAxiomResponse(null, 'hour 12'),
    ).toThrow(/^hour 12: Axiom returned a partial or statusless answer$/)

    expect(() =>
      assertCompleteAxiomResponse(undefined, 'hour 12'),
    ).toThrow(/^hour 12: Axiom returned a partial or statusless answer$/)
  })
})
