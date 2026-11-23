import { describe, expect, test } from 'bun:test'

import { ARTIFACT_ANCHOR_MAX_ELEMENTS, parseArtifactCommentAnchor } from './artifacts'

// A comment anchor is stored with its thread: every shape ever written must keep parsing.
describe('whiteboard comment anchors', () => {
  test('a single element (the shape stored before multi-selection) and a point still parse', () => {
    expect(parseArtifactCommentAnchor('whiteboard', { kind: 'whiteboard', elementId: 'n1' }).ok).toBe(true)
    expect(parseArtifactCommentAnchor('whiteboard', { kind: 'whiteboard', x: -40, y: 1200.5 }).ok).toBe(true)
  })

  test('a multi-selection lists every element, the lead first, within the cap', () => {
    const ids = Array.from({ length: ARTIFACT_ANCHOR_MAX_ELEMENTS }, (_, i) => `e${i}`)
    expect(parseArtifactCommentAnchor('whiteboard', { kind: 'whiteboard', elementId: 'e0', elementIds: ids }).ok).toBe(true)
    expect(parseArtifactCommentAnchor('whiteboard', { kind: 'whiteboard', elementId: 'e0', elementIds: [...ids, 'one-more'] }).ok).toBe(false)
    expect(parseArtifactCommentAnchor('whiteboard', { kind: 'whiteboard', elementId: 'e1', elementIds: ['e0', 'e1'] }).ok).toBe(false)
    expect(parseArtifactCommentAnchor('whiteboard', { kind: 'whiteboard', elementId: 'e0', elementIds: ['e0'] }).ok).toBe(false)
    expect(parseArtifactCommentAnchor('whiteboard', { kind: 'whiteboard', elementId: 'e0', x: 1, y: 2 }).ok).toBe(false)
  })
})
