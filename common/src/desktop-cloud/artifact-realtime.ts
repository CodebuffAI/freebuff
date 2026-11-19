import { z } from 'zod/v4'

import type { ArtifactSelection } from './artifact-view-context'
import type { ArtifactAuthorKind, ArtifactKind } from './artifacts'

/**
 * Real-time for an open artifact tab: revision SIGNALS and PRESENCE, on the
 * hosted Cloud transport (web/src/server/desktop-cloud/streams.ts, the realtime
 * Redis) through one SSE per tab, `GET artifacts/:id/live`.
 *
 * - A signal says only that an artifact moved: its id, revision, what kind of
 *   change, and whether an agent made it. Never content. The tab answers it the
 *   way its poll answers a newer head (fetch + three-way merge), and the poll
 *   stays as the fallback and as a slow safety net.
 * - Presence is ephemeral (Redis with a TTL, never Postgres): who has the tab
 *   open, their mode, and their selection in the same ids the agent's view
 *   context uses, minus any text. Names, colours and anonymous labels are
 *   assigned by the server; a client never names itself.
 *
 * With no transport (no realtime Redis, a 503, a dropped stream) everything is
 * exactly the polling it was before.
 */

export const ARTIFACT_CHANGES = ['created', 'body', 'title', 'comments', 'assets', 'access', 'deleted'] as const
export type ArtifactChange = (typeof ARTIFACT_CHANGES)[number]

export type ArtifactSignal = {
  v: 1
  artifactId: string
  /** The stored revision after the change (0 when the change does not know it: comments, access). */
  revision: number
  change: ArtifactChange
  authorKind: ArtifactAuthorKind | null
}

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)

export const artifactSignalSchema = z.strictObject({
  v: z.literal(1),
  artifactId: uuid,
  revision: z.number().int().min(0).max(2_000_000_000),
  change: z.enum(ARTIFACT_CHANGES),
  authorKind: z.enum(['user', 'agent']).nullable(),
})

/** The Redis topic of an artifact's signals (namespaced per environment by CloudStreams). */
export const artifactSignalTopic = (artifactId: string) => `artifact:${artifactId}`
/** The Redis topic of an artifact's presence notifications. */
export const artifactPresenceTopic = (artifactId: string) => `artifact-presence:${artifactId}`

// ---- presence

export const ARTIFACT_PRESENCE_MODES = ['viewing', 'editing', 'presenting'] as const
export type ArtifactPresenceMode = (typeof ARTIFACT_PRESENCE_MODES)[number]

/** A peer that has not been heard from this long is gone. */
export const ARTIFACT_PRESENCE_TTL_MS = 10_000
/**
 * The tab's open live stream keeps its presence entry alive this often (server side, Redis
 * only), so presence costs no request while nothing changes; a closed tab stops it and is
 * gone within the TTL.
 */
export const ARTIFACT_PRESENCE_KEEPALIVE_MS = 3_000
/** A client re-sends its whole state this often anyway (an entry lost to a Redis restart). */
export const ARTIFACT_PRESENCE_HEARTBEAT_MS = 30_000
/**
 * Presence updates a client sends per second at most, coalesced (the latest state wins, nothing
 * queues). Each one is a gateway request with its session lookups, so this is kept low; pointer
 * samples are batched into them.
 */
export const ARTIFACT_PRESENCE_MAX_PER_SECOND = 2
/** Peers one artifact shows at most; later arrivals are not admitted until someone leaves. */
export const ARTIFACT_PRESENCE_MAX_PEERS = 24
/** A presence update's JSON body, bytes. */
export const ARTIFACT_PRESENCE_MAX_BYTES = 2048
/** Pointer samples one update carries at most (sampled ~20/s, batched into ≤2 updates/s). */
export const ARTIFACT_PRESENCE_POINTER_SAMPLES = 10

const id = z.string().min(1).max(64)

/**
 * A selection as presence carries it: the ids that place a marker, never the
 * quoted text, excerpts or filter values the agent's view context may hold.
 */
export const artifactPresenceSelectionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('doc'), tabId: id.optional(), blockIndex: z.number().int().min(0).max(100_000).optional() }),
  z.strictObject({
    kind: z.literal('slides'),
    slideId: id.optional(),
    element: z.string().min(1).max(40).optional(),
    elementIds: z.array(id).max(12).optional(),
  }),
  z.strictObject({ kind: z.literal('sheet'), tabId: id.optional(), range: z.string().max(40).regex(/^[A-Z]{1,3}[0-9]{1,7}(:[A-Z]{1,3}[0-9]{1,7})?$/).optional() }),
  z.strictObject({ kind: z.literal('data'), blockId: id.optional(), tabId: id.optional() }),
  z.strictObject({ kind: z.literal('whiteboard'), elementIds: z.array(id).max(20).optional() }),
  z.strictObject({ kind: z.literal('design'), pageId: id.optional(), boardId: id.optional(), nodeId: id.optional() }),
])
export type ArtifactPresenceSelection = z.infer<typeof artifactPresenceSelectionSchema>

/** A pointer position in the pane's own coordinates (a whiteboard's board units), `t` ms since the sender's batch began. */
export const artifactPresencePointerSchema = z.strictObject({
  x: z.number().finite().min(-1e7).max(1e7),
  y: z.number().finite().min(-1e7).max(1e7),
  t: z.number().int().min(0).max(5_000),
})
export type ArtifactPresencePointer = z.infer<typeof artifactPresencePointerSchema>

/** What a client says about itself. Who it is comes from the server. */
export const artifactPresenceUpdateSchema = z.strictObject({
  /** Random per tab; it names this tab's presence entry, nothing else. */
  sessionId: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
  mode: z.enum(ARTIFACT_PRESENCE_MODES),
  selection: artifactPresenceSelectionSchema.nullable().optional(),
  pointer: z.array(artifactPresencePointerSchema).max(ARTIFACT_PRESENCE_POINTER_SAMPLES).optional(),
  linkToken: z.string().max(64).optional(),
  /** The tab is closing: drop its entry now rather than at the TTL. */
  leave: z.literal(true).optional(),
})
export type ArtifactPresenceUpdate = z.infer<typeof artifactPresenceUpdateSchema>

/** One peer as a viewer receives it. */
export type ArtifactPeer = {
  /** Stable for the tab's life; derived from its session id, never an account id. */
  id: string
  /** The account's display name, or an anonymous label ("Anonymous Otter"). */
  name: string
  anonymous: boolean
  color: string
  mode: ArtifactPresenceMode
  selection: ArtifactPresenceSelection | null
  pointer: ArtifactPresencePointer[] | null
  /** Epoch ms the server last heard from it. */
  at: number
  /** The agent (drawn with Buffy's head); never sent by the server, added by the client. */
  agent?: boolean
}

export type ArtifactLiveHello = {
  v: 1
  /** The stored revision when the stream opened: a tab behind it reconciles at once. */
  revision: number
  /** This tab's own peer id (its entry is left out of `presence` frames it receives). */
  you: string | null
}

/** One SSE frame of `GET artifacts/:id/live` (event name → data). */
export type ArtifactLiveFrame =
  | { event: 'hello'; data: ArtifactLiveHello }
  | { event: 'signal'; data: ArtifactSignal }
  | { event: 'presence'; data: { peers: ArtifactPeer[] } }
  | { event: 'revoked'; data: Record<string, never> }

/**
 * The view context's selection as presence sends it: ids only. Null for a
 * selection of another kind than the artifact's.
 */
export function presenceSelectionOf(
  kind: ArtifactKind,
  selection: ArtifactSelection | null | undefined,
): ArtifactPresenceSelection | null {
  if (!selection) return null
  const clip = (value: string | undefined) => (value ? value.slice(0, 64) : undefined)
  const defined = <T extends Record<string, unknown>>(value: T) =>
    Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T
  const kindOf: Record<ArtifactSelection['kind'], ArtifactKind> = {
    doc: 'doc',
    slides: 'slides',
    sheet: 'sheet',
    data: 'data',
    whiteboard: 'whiteboard',
    design: 'design',
  }
  if (kindOf[selection.kind] !== kind) return null
  let out: ArtifactPresenceSelection
  switch (selection.kind) {
    case 'doc':
      out = defined({ kind: 'doc', tabId: clip(selection.tabId), blockIndex: selection.blockIndex })
      break
    case 'slides':
      out = defined({
        kind: 'slides',
        slideId: clip(selection.slideId),
        element: selection.element,
        elementIds: selection.freeElements?.length ? selection.freeElements.map((e) => e.id.slice(0, 64)).slice(0, 12) : undefined,
      })
      break
    case 'sheet':
      out = defined({ kind: 'sheet', tabId: clip(selection.tabId), range: selection.range?.toUpperCase() })
      break
    case 'data':
      out = defined({ kind: 'data', blockId: clip(selection.blockId), tabId: clip(selection.tabId) })
      break
    case 'whiteboard':
      out = defined({
        kind: 'whiteboard',
        elementIds: selection.elementIds?.length ? selection.elementIds.map((e) => e.slice(0, 64)).slice(0, 20) : undefined,
      })
      break
    case 'design': {
      const nodeId = selection.nodePath?.[selection.nodePath.length - 1]
      out = defined({ kind: 'design', pageId: clip(selection.pageId), boardId: clip(selection.boardId), nodeId: clip(nodeId) })
      break
    }
  }
  return artifactPresenceSelectionSchema.safeParse(out).success ? out : null
}

// ---- identity: colours and anonymous labels, deterministic per seed

/** Distinct hues that read on light and dark canvases alike. */
export const ARTIFACT_PEER_COLORS = [
  '#e5484d',
  '#f76b15',
  '#d6a100',
  '#30a46c',
  '#12a594',
  '#0090ff',
  '#3e63dd',
  '#8e4ec6',
  '#d6409f',
  '#a18072',
] as const

const ANIMALS = [
  'Otter', 'Fox', 'Heron', 'Lynx', 'Panda', 'Koala', 'Badger', 'Falcon', 'Moose', 'Gecko',
  'Walrus', 'Bison', 'Ibis', 'Marten', 'Puffin', 'Quokka', 'Raven', 'Seal', 'Tapir', 'Yak',
] as const

/** FNV-1a: a small stable hash of a seed (a peer id), used only to pick a colour. */
function hash(seed: string) {
  let h = 0x811c9dc5
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

export const artifactPeerColor = (seed: string) => ARTIFACT_PEER_COLORS[hash(seed) % ARTIFACT_PEER_COLORS.length]!
export const anonymousPeerLabel = (seed: string) => `Anonymous ${ANIMALS[hash(`a:${seed}`) % ANIMALS.length]}`

/** Two-letter initials for an avatar. */
export function peerInitials(name: string): string {
  const words = name.replace(/^Anonymous\s+/, '').trim().split(/\s+/).filter(Boolean)
  if (!words.length) return '?'
  const letters = words.length === 1 ? words[0]!.slice(0, 2) : `${words[0]![0]}${words[words.length - 1]![0]}`
  return letters.toUpperCase()
}

// ---- SSE parsing, shared by the browser client and tests

/** Splits an SSE byte stream's text into frames; keeps the unfinished tail for the next chunk. */
export function parseSseChunk(buffer: string): { frames: Array<{ event: string; data: string }>; rest: string } {
  const frames: Array<{ event: string; data: string }> = []
  const parts = buffer.split(/\r?\n\r?\n/)
  const rest = parts.pop() ?? ''
  for (const part of parts) {
    let event = 'message'
    const data: string[] = []
    for (const line of part.split(/\r?\n/)) {
      if (!line || line.startsWith(':')) continue
      const colon = line.indexOf(':')
      const field = colon < 0 ? line : line.slice(0, colon)
      const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '')
      if (field === 'event') event = value
      else if (field === 'data') data.push(value)
    }
    if (data.length) frames.push({ event, data: data.join('\n') })
  }
  return { frames, rest }
}
