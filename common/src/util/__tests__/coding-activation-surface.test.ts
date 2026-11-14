import { expect, test } from 'bun:test'

import { isCodingActivationSurface } from '../coding-activation-surface'

test('pending claims keep every surface the trackers write', () => {
  for (const surface of ['web', 'desktop', 'cli', 'android', 'ios'])
    expect(isCodingActivationSurface(surface)).toBe(true)
  for (const surface of ['cloud', 'chat', '', undefined, 'Android'])
    expect(isCodingActivationSurface(surface)).toBe(false)
})
