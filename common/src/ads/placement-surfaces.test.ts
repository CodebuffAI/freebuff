import { expect, test } from 'bun:test'
import { PLACEMENT_SLOTS } from '../constants/freebuff-placements'
import { placementSurface, placementSurfaceAllowed } from './placement-surfaces'

test('every catalog slot has a device surface, with web copies distinct from Desktop', () => {
  for (const slot of PLACEMENT_SLOTS)
    expect(placementSurface(slot.id)).not.toBeNull()
  expect(placementSurface('Desktop-Inline-Chat')).toBe('desktop')
  expect(placementSurface('Desktop-Inline-Chat:web')).toBe('web')
  expect(placementSurface('CLI-Chat-Inline')).toBe('cli')
  expect(placementSurface('Single-Ad-Unit-1')).toBe('cli')
  expect(placementSurface('Chat-Assistant-Above-Input')).toBe('web')
})
test('a restriction never inherits into another surface or admits unknown slots', () => {
  expect(placementSurfaceAllowed(['desktop'], 'Desktop-Inline-Chat:web')).toBe(
    false,
  )
  expect(placementSurfaceAllowed(['web'], 'Desktop-Inline-Chat:web')).toBe(true)
  expect(placementSurfaceAllowed(['web'], 'unknown')).toBe(false)
  expect(placementSurfaceAllowed(null, 'Desktop-Inline-Chat:web')).toBe(true)
})
