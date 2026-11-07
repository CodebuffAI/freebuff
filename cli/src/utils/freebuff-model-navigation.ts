export type FreebuffModelNavigationDirection = 'forward' | 'backward'

const FORWARD_KEY_NAMES = new Set(['right', 'down'])
const BACKWARD_KEY_NAMES = new Set(['left', 'up'])
const FORWARD_TAB_SEQUENCES = new Set(['\t', '\x1b[9u'])
const BACKWARD_TAB_SEQUENCES = new Set([
  '\x1b[Z',
  '\x1b[9;2u',
  '\x1b[27;2;9~',
])

export function nextFreebuffModelId(params: {
  modelIds: readonly string[]
  focusedId: string
  direction: FreebuffModelNavigationDirection
}): string | null {
  const { modelIds, focusedId, direction } = params
  if (modelIds.length === 0) return null

  const currentIdx = modelIds.indexOf(focusedId)
  if (currentIdx === -1) return modelIds[0] ?? null

  const step = direction === 'forward' ? 1 : -1
  return modelIds[(currentIdx + step + modelIds.length) % modelIds.length]
}

/**
 * The chat picker's key hint. It names only keys that do something: a
 * one-model catalog (a new account's single "Freebuff" row) has nothing for
 * the arrows to move to, and "↑↓ choose model" over one row reads as a
 * keyboard bug (support, 2026-11-07).
 */
export function freebuffChatPickerHint(params: {
  modelCount: number
  focusedHasReasoning: boolean
}): string {
  return [
    ...(params.modelCount > 1 ? ['↑↓ choose model'] : []),
    ...(params.focusedHasReasoning ? ['Tab reasoning'] : []),
    'Enter select',
    'Esc cancel',
  ].join(' · ')
}

export function freebuffModelNavigationDirectionForKey(key: {
  name?: string
  shift?: boolean
  sequence?: string
  raw?: string
}): FreebuffModelNavigationDirection | null {
  const name = (key.name ?? '').toLowerCase()
  const sequence = key.sequence ?? key.raw ?? ''

  if (FORWARD_KEY_NAMES.has(name)) return 'forward'
  if (BACKWARD_KEY_NAMES.has(name)) return 'backward'

  if (
    (name === 'tab' && Boolean(key.shift)) ||
    BACKWARD_TAB_SEQUENCES.has(sequence)
  ) {
    return 'backward'
  }
  if (name === 'tab' || FORWARD_TAB_SEQUENCES.has(sequence)) {
    return 'forward'
  }

  return null
}
