import { expect, test } from 'bun:test'

import {
  ARTIFACT_VIEW_SLIDE_IDS_MAX,
  ARTIFACT_CONTEXT_BODY_MAX_CHARS,
  ARTIFACT_CONTEXT_HEADER_MAX_CHARS,
  artifactViewContextSchema,
  decodeArtifactViewContext,
  encodeArtifactViewContext,
  normalizeArtifactViewContext,
  resolveArtifactViewContext,
  type ArtifactViewContext,
} from './artifact-view-context'

const ID = '0190a4f0-0000-7000-8000-000000000009'
const TOKEN = 'a'.repeat(43)

const base: ArtifactViewContext = { artifactId: ID, kind: 'data', title: 'Revenue', revision: 7, mode: 'viewing', dirty: false }

/** Filters far past any request header: 40 keys of 50 long values each. */
function hugeFilters(): Record<string, string[]> {
  const filters: Record<string, string[]> = {}
  for (let key = 0; key < 40; key++) filters[`region-${key}`] = Array.from({ length: 50 }, (_, value) => `${key}-${value}-${'x'.repeat(190)}`)
  return filters
}

test('oversized Data filters keep the artifact id and revision and say they were cut', () => {
  const context = { ...base, selection: { kind: 'data' as const, blockId: 'kpi-1', tabId: 'overview', filters: hugeFilters() } }
  // The body copy: within its cap, ids kept, the cut named.
  const body = normalizeArtifactViewContext(context)!
  expect(JSON.stringify(body).length).toBeLessThanOrEqual(ARTIFACT_CONTEXT_BODY_MAX_CHARS)
  expect(body.artifactId).toBe(ID)
  expect(body.revision).toBe(7)
  expect(body.selection).toMatchObject({ kind: 'data', blockId: 'kpi-1', tabId: 'overview' })
  expect(body.truncated).toContain('selection.filters')
  // The header copy (for an API that reads only the header): never dropped whole, still decodable.
  const header = encodeArtifactViewContext(context)
  expect(header).not.toBeNull()
  expect(header!.length).toBeLessThanOrEqual(ARTIFACT_CONTEXT_HEADER_MAX_CHARS)
  const decoded = decodeArtifactViewContext(header)!
  expect(decoded.artifactId).toBe(ID)
  expect(decoded.revision).toBe(7)
  expect(decoded.selection).toMatchObject({ kind: 'data', blockId: 'kpi-1' })
})

test('truncation is deterministic', () => {
  const context = { ...base, selection: { kind: 'data' as const, blockId: 'b', filters: hugeFilters() } }
  expect(JSON.stringify(normalizeArtifactViewContext(context))).toBe(JSON.stringify(normalizeArtifactViewContext(structuredClone(context))))
  expect(encodeArtifactViewContext(context)).toBe(encodeArtifactViewContext(structuredClone(context)))
})

test('per-field caps clip long values instead of dropping the context', () => {
  const context = {
    ...base,
    kind: 'doc',
    title: 'T'.repeat(5000),
    selection: { kind: 'doc', tabId: 't1', blockIndex: 3, quote: 'q'.repeat(5000), unknownFutureField: 1 },
    futureField: { nested: true },
  }
  const normalized = normalizeArtifactViewContext(context)!
  expect(normalized.title.length).toBeLessThanOrEqual(200)
  expect(normalized.selection).toMatchObject({ kind: 'doc', tabId: 't1', blockIndex: 3 })
  expect((normalized.selection as { quote: string }).quote.length).toBeLessThanOrEqual(500)
  expect(normalized.truncated).toEqual(expect.arrayContaining(['title', 'selection.quote']))
  expect(artifactViewContextSchema.safeParse(normalized).success).toBe(true)
  // No id, kind or revision: nothing to address, so no context.
  expect(normalizeArtifactViewContext({ ...base, artifactId: '' })).toBeNull()
  expect(normalizeArtifactViewContext({ ...base, kind: 'nope' })).toBeNull()
  expect(normalizeArtifactViewContext('nope')).toBeNull()
})

test('the header copy is the shape an older API decodes: no link token, no truncation marker', () => {
  const context = { ...base, linkToken: TOKEN, truncated: ['selection.filters' as const] }
  const header = encodeArtifactViewContext(context)!
  const json = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(header), (c) => c.charCodeAt(0))))
  expect(json).not.toHaveProperty('linkToken')
  expect(json).not.toHaveProperty('truncated')
  expect(json.artifactId).toBe(ID)
})

test('the body is preferred over the header; the header is the fallback; neither is never a failure', () => {
  const fromBody = { ...base, title: 'body' }
  const header = encodeArtifactViewContext({ ...base, title: 'header' })
  expect(resolveArtifactViewContext({ body: fromBody, header })).toMatchObject({ source: 'body', context: { title: 'body' } })
  expect(resolveArtifactViewContext({ body: undefined, header })).toMatchObject({ source: 'header', context: { title: 'header' } })
  // A body copy that does not read falls back to the header, never a failed run.
  expect(resolveArtifactViewContext({ body: { nonsense: true }, header })).toMatchObject({ source: 'header' })
  expect(resolveArtifactViewContext({ body: undefined, header: 'not base64!' })).toBeNull()
  // A client never supplies a sealed token: the API seals one itself.
  expect(resolveArtifactViewContext({ body: { ...base, sealedLinkToken: 'x' }, header: null })!.context).not.toHaveProperty('sealedLinkToken')
  // A link token of the right shape is kept (the API seals it); any other is dropped.
  expect(resolveArtifactViewContext({ body: { ...base, linkToken: TOKEN }, header: null })!.context.linkToken).toBe(TOKEN)
  expect(resolveArtifactViewContext({ body: { ...base, linkToken: 'short' }, header: null })!.context).not.toHaveProperty('linkToken')
})

test('ours’ full doc and data selections survive the body and the header copies whole, ids uncut', () => {
  const longId = `d${'x'.repeat(199)}`
  const doc: ArtifactViewContext = {
    artifactId: 'a-doc',
    kind: 'doc',
    title: 'Plan',
    revision: 4,
    mode: 'editing',
    dirty: false,
    lastEditedByUserAt: null,
    selection: { kind: 'doc', tabId: 't-launch', blockIndex: 3, blockHash: 'abc1234', blockId: 'b-abc1234.2', quote: 'the launch' },
  }
  const data: ArtifactViewContext = {
    artifactId: 'a-data',
    kind: 'data',
    title: 'Weekly',
    revision: 2,
    mode: 'viewing',
    dirty: true,
    lastEditedByUserAt: '2026-11-16T15:00:00.000Z',
    selection: { kind: 'data', blockId: longId, tabId: longId, filters: { region: ['EU', 'US'], compareToPrevious: true, clicked: 'week = 2026-11-09' } },
  }
  for (const context of [doc, data]) {
    expect(normalizeArtifactViewContext(context)).toEqual(context)
    expect(decodeArtifactViewContext(encodeArtifactViewContext(context))).toEqual(context)
  }
  // A block id that is not one is dropped, never the selection.
  const odd = normalizeArtifactViewContext({ ...doc, selection: { ...doc.selection, blockId: 'not an id' } })
  expect(odd?.selection).toEqual({ kind: 'doc', tabId: 't-launch', blockIndex: 3, blockHash: 'abc1234', quote: 'the launch' })
})

test('round 5: a slides multi-selection and a whiteboard viewport ride the body; over a cap they are cut, never refused', () => {
  const ids = Array.from({ length: ARTIFACT_VIEW_SLIDE_IDS_MAX }, (_, i) => `slide-${i}`)
  const slides = { ...base, lastEditedByUserAt: null, kind: 'slides' as const, selection: { kind: 'slides' as const, slideId: 'slide-0', slideIds: ids } }
  expect(normalizeArtifactViewContext(slides)).toEqual(slides)
  const over = normalizeArtifactViewContext({ ...slides, selection: { ...slides.selection, slideIds: [...ids, 'one-more'] } })!
  expect(over.selection).toEqual(slides.selection)
  expect(over.truncated).toEqual(['selection.lists'])

  const viewport = { x: -120, y: 40, w: 1600, h: 900, zoom: 0.75 }
  const board = { ...base, lastEditedByUserAt: null, kind: 'whiteboard' as const, selection: { kind: 'whiteboard' as const, elementIds: ['a'], viewport } }
  expect(normalizeArtifactViewContext(board)).toEqual(board)
  expect(artifactViewContextSchema.safeParse(board).success).toBe(true)
  // A malformed viewport is dropped; the selection and the context stay.
  expect(normalizeArtifactViewContext({ ...board, selection: { ...board.selection, viewport: { ...viewport, zoom: 0, extra: 1 } } })!.selection).toEqual({ kind: 'whiteboard', elementIds: ['a'] })
  // The round-4 header copy carries neither field.
  for (const context of [slides, board]) {
    const header = decodeArtifactViewContext(encodeArtifactViewContext(context))!
    expect(JSON.stringify(header)).not.toContain('slideIds')
    expect(JSON.stringify(header)).not.toContain('viewport')
  }
})
