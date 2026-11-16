import { z } from 'zod/v4'

/**
 * Freebuff artifacts: hosted, agent-authored things a user keeps, edits and
 * shares by link (a doc, a deck, a sheet...). The wire contract between the
 * workspace UI and `/api/v1/cloud/artifacts` (web/src/server/desktop-cloud/
 * artifacts-api.ts). The body formats and their validation live in
 * packages/internal/src/freebuff-artifacts/kinds.ts.
 *
 * Routes, all under `/api/v1/cloud/` (the workspace gateway serves the same
 * paths under `/api/workspace/cloud/`):
 *  - `GET  artifacts?scope=mine|shared&kind=&search=&limit=&sort=` → `ArtifactListResponse` (pinned first)
 *  - `GET  artifacts/:id/head?linkToken=` → `ArtifactHeadResponse` (the open tab's poll)
 *  - `PUT  artifacts/:id/pin` `ArtifactPinRequest` → `{ pinned }`
 *  - `PUT  artifacts/:id/template` `ArtifactTemplateRequest` → `ArtifactTemplateResponse` (owner only)
 *  - `POST artifacts` `ArtifactCreateRequest` → `ArtifactResponse`
 *  - `GET  artifacts/:id` → `ArtifactResponse`
 *  - `PUT  artifacts/:id` `ArtifactSaveRequest` → `ArtifactResponse`, or 409 `ArtifactConflict`
 *  - `PATCH artifacts/:id` `ArtifactRenameRequest` → `{ artifact }`
 *  - `DELETE artifacts/:id` → `{ deleted: true }`
 *  - `GET  artifacts/:id/share` → `ArtifactAccess`
 *  - `POST artifacts/:id/share` `ArtifactShareRequest` → `ArtifactShareResponse`
 *  - `POST artifacts/:id/invites` `ArtifactInviteRequest` → `{ invite }`
 *  - `DELETE artifacts/:id/invites/:inviteId` → `{ revoked: true }`
 *  - `GET  artifacts/shared/:token` (no sign-in; a share link's or an invite email's token) → `ArtifactResponse` with `via`
 *  - `GET  artifacts/:id/revisions?before=&limit=&linkToken=` → `ArtifactRevisionListResponse`
 *  - `GET  artifacts/:id/revisions/:rev?linkToken=` → `ArtifactRevisionResponse`
 *  - `POST artifacts/:id/revisions/:rev/restore` `ArtifactRestoreRequest` → `ArtifactResponse`, or 409 `ArtifactConflict`
 *  - `GET  artifacts/:id/comments?state=open|resolved|all&linkToken=` → `ArtifactCommentListResponse`
 *  - `POST artifacts/:id/comments` `ArtifactCommentAddRequest` → `{ thread: ArtifactCommentThread }`
 *  - `PATCH artifacts/:id/comments/:commentId` `ArtifactCommentUpdateRequest` → `{ thread: ArtifactCommentThread }`
 *  - `DELETE artifacts/:id/comments/:commentId?linkToken=` → `{ deleted: true }`
 *  - `POST artifacts/:id/assets?linkToken=` raw image bytes → `{ asset: ArtifactAsset }` (editors, signed in)
 *  - `GET  artifacts/:id/assets?linkToken=` → `ArtifactAssetListResponse`
 *  - `GET  artifacts/:id/assets/:assetId?linkToken=` → the image bytes (anyone who can read)
 *  - `GET  artifacts/shared/:token/assets/:assetId` (no sign-in) → the image bytes
 *  - `POST artifacts/shared/:token/accept` (signed in) → `ArtifactInviteAcceptResponse`, or 403 `ArtifactInviteRefusal`
 *  - `POST artifacts/:id/invites/:inviteId/email` (server to server only;
 *    the workspace gateway never forwards it) → `ArtifactInviteEmailClaim`
 *
 * The browser asks freebuff-web's `POST /api/artifacts/invite-email`
 * (`ArtifactInviteEmailRequest` → `ArtifactInviteEmailResponse`) to email an
 * invite it just created; see that route for the flow.
 *
 * A signed-in link holder presents the link token: in the JSON body of a
 * write, or as the `linkToken` query parameter of a GET or DELETE.
 *
 * Who may do what (`artifactCan`): a viewer reads the artifact and its
 * comments; a commenter also comments and resolves threads; an editor also
 * saves, reads the version history and restores a version; the owner also
 * shares, deletes and deletes anyone's comment. Writing a comment needs a
 * signed-in account, never a link alone.
 */

export const ARTIFACT_KINDS = [
  'doc',
  'slides',
  'sheet',
  'data',
  'whiteboard',
  'design',
] as const
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number]
export const artifactKindSchema = z.enum(ARTIFACT_KINDS)

export const ARTIFACT_BODY_FORMATS = ['markdown', 'json'] as const
export type ArtifactBodyFormat = (typeof ARTIFACT_BODY_FORMATS)[number]

/** What a link or an invite lets someone do. `owner` is never granted. */
export const ARTIFACT_SHARE_ROLES = ['viewer', 'commenter', 'editor'] as const
export type ArtifactShareRole = (typeof ARTIFACT_SHARE_ROLES)[number]
export const artifactShareRoleSchema = z.enum(ARTIFACT_SHARE_ROLES)
export type ArtifactRole = ArtifactShareRole | 'owner'

export const ARTIFACT_LINK_ACCESS = ['private', 'link'] as const
export type ArtifactLinkAccess = (typeof ARTIFACT_LINK_ACCESS)[number]

/** One body, UTF-8. A doc's Markdown or a JSON kind's serialized document. */
export const ARTIFACT_BODY_MAX_BYTES = 1024 * 1024
export const ARTIFACT_TITLE_MAX_CHARS = 200
export const ARTIFACT_INVITES_MAX = 50
export const ARTIFACT_LIST_MAX = 100
/** Live (not deleted) artifacts one account may own. */
export const ARTIFACTS_PER_ACCOUNT_MAX = 2000
/**
 * What one account's live artifacts may hold in all: their current bodies plus their images.
 * Superseded bodies (the history) are not counted; the daily write budget bounds those.
 */
export const ARTIFACT_ACCOUNT_STORED_BYTES_MAX = 1024 * 1024 * 1024

// Bodies are Markdown and JSON that routinely hold shell commands and paths,
// which Render's edge WAF answers with an HTML 403 (docs/render-edge-waf.md),
// so they travel base64-encoded, as documents and skills do. Transport only.
const ARTIFACT_BODY_ENCODED_CHARS = Math.ceil(ARTIFACT_BODY_MAX_BYTES / 3) * 4
/** A request carrying one encoded body plus its small JSON envelope. */
export const ARTIFACT_REQUEST_MAX_BYTES = ARTIFACT_BODY_ENCODED_CHARS + 16 * 1024

export const artifactEncodedBodySchema = z
  .object({
    encoding: z.literal('base64'),
    data: z.string().max(ARTIFACT_BODY_ENCODED_CHARS),
  })
  .strict()
export type ArtifactEncodedBody = z.infer<typeof artifactEncodedBodySchema>

export function encodeArtifactBody(text: string): ArtifactEncodedBody {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
  return { encoding: 'base64', data: btoa(binary) }
}

/** Null for invalid base64 or invalid UTF-8; never a lossy decode. */
export function decodeArtifactBody(body: ArtifactEncodedBody): string | null {
  let binary: string
  try {
    binary = atob(body.data)
  } catch {
    return null
  }
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

const title = z.string().trim().min(1).max(ARTIFACT_TITLE_MAX_CHARS)
const optionalId = z.string().min(1).max(200).optional()

export const artifactCreateRequestSchema = z
  .object({
    kind: artifactKindSchema,
    title,
    body: artifactEncodedBodySchema,
    chatId: optionalId,
    projectId: optionalId,
    /** Made from another artifact the creator can open (a duplicate): recorded for "Made from …". */
    sourceArtifactId: optionalId,
  })
  .strict()
export type ArtifactCreateRequest = z.infer<typeof artifactCreateRequestSchema>

/** A link's editor saves or renames by presenting the link token. */
const linkToken = z.string().max(64).optional()

export const artifactSaveRequestSchema = z
  .object({
    expectedRevision: z.number().int().min(1),
    body: artifactEncodedBodySchema,
    linkToken,
  })
  .strict()
export type ArtifactSaveRequest = z.infer<typeof artifactSaveRequestSchema>

export const artifactRenameRequestSchema = z
  .object({ title, linkToken })
  .strict()
export type ArtifactRenameRequest = z.infer<typeof artifactRenameRequestSchema>

/**
 * `link` mints a token the first time (and on `rotate`); the raw token is in
 * the response only then. `private` revokes it.
 */
export const artifactShareRequestSchema = z
  .object({
    access: z.enum(ARTIFACT_LINK_ACCESS),
    role: artifactShareRoleSchema.optional(),
    rotate: z.boolean().optional(),
  })
  .strict()
export type ArtifactShareRequest = z.infer<typeof artifactShareRequestSchema>

export const artifactInviteRequestSchema = z
  .object({
    email: z.email().max(254),
    role: artifactShareRoleSchema,
  })
  .strict()
export type ArtifactInviteRequest = z.infer<typeof artifactInviteRequestSchema>

export const ARTIFACT_LIST_SORTS = ['updated', 'created', 'title'] as const
export type ArtifactListSort = (typeof ARTIFACT_LIST_SORTS)[number]

/** `PUT artifacts/:id/pin`: pin or unpin it in the reader's own list (the owner's, or an invitee's). */
export const artifactPinRequestSchema = z.object({ pinned: z.boolean() }).strict()
export type ArtifactPinRequest = z.infer<typeof artifactPinRequestSchema>

/** A template's description, shown on "Start from a template" and the list row. */
export const ARTIFACT_TEMPLATE_DESCRIPTION_MAX = 280

/**
 * `PUT artifacts/:id/template` (the owner's): marks it a template others it is shared with can
 * "Use" (a copy with `sourceArtifactId`), or unmarks it. The generic mechanism a Design system
 * can ride on.
 */
export const artifactTemplateRequestSchema = z
  .object({
    template: z.boolean(),
    description: z.string().trim().max(ARTIFACT_TEMPLATE_DESCRIPTION_MAX).optional(),
  })
  .strict()
export type ArtifactTemplateRequest = z.infer<typeof artifactTemplateRequestSchema>
export type ArtifactTemplateResponse = { template: boolean; templateDescription: string | null }

/**
 * `GET artifacts/:id/head?linkToken=`: the cheap poll an open tab makes every few seconds
 * (the body is read only when `revision` moved). `lastAuthorKind`/`lastSavedAt` describe the
 * newest revision, so a tab can show "Buffy is editing…" while an agent's writes arrive.
 */
export type ArtifactHeadResponse = {
  revision: number
  updatedAt: string
  lastAuthorKind: ArtifactAuthorKind | null
  lastSavedAt: string | null
}

export const artifactListQuerySchema = z
  .object({
    scope: z.enum(['mine', 'shared']).default('mine'),
    kind: artifactKindSchema.optional(),
    search: z.string().trim().min(1).max(200).optional(),
    limit: z.coerce.number().int().min(1).max(ARTIFACT_LIST_MAX).optional(),
    /** Pinned first always; then newest change (default), newest created, or title A to Z. */
    sort: z.enum(ARTIFACT_LIST_SORTS).optional(),
    /** `templates`: only artifacts marked as templates. */
    filter: z.enum(['templates']).optional(),
  })
  .strict()
export type ArtifactListQuery = z.infer<typeof artifactListQuerySchema>

/** An artifact's id as the store mints it (a UUID, lower-case). */
export const ARTIFACT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** A link token as minted: 32 random bytes, base64url. */
export const ARTIFACT_LINK_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

export type ArtifactMeta = {
  id: string
  kind: ArtifactKind
  title: string
  bodyFormat: ArtifactBodyFormat
  bodyBytes: number
  bodySha256: string
  revision: number
  chatId: string | null
  projectId: string | null
  linkAccess: ArtifactLinkAccess
  linkRole: ArtifactShareRole
  createdAt: string
  updatedAt: string
  /** Set on lists and reads by someone other than the owner. */
  role?: ArtifactRole
  /** When the reader pinned it in their own list (lists only); null when not pinned. */
  pinnedAt?: string | null
  /** The artifact it was made from; `ArtifactResponse.source` names it when the reader can open it. */
  sourceArtifactId?: string | null
  /** Marked as a template by its owner (`PUT artifacts/:id/template`). */
  template?: boolean
  templateDescription?: string | null
  /** The owner's list only: it has at least one live (unrevoked) invite. */
  invited?: boolean
}

export type ArtifactResponse = {
  artifact: ArtifactMeta
  body: ArtifactEncodedBody
  role: ArtifactRole
  /** Set by `artifacts/shared/:token` only: a share link opened it. */
  via?: 'link'
  /** "Made from …": the source artifact, only when this reader can open it too. */
  source?: { id: string; kind: ArtifactKind; title: string }
}
/**
 * `artifacts/shared/:token` for a live invite email's token: only the artifact's kind, for the
 * sign-in prompt. No title, body or images: the invited account opens it once it signs in and
 * accepts (`artifacts/shared/:token/accept`), through its own access, never through the token.
 */
export type ArtifactSharedInviteResponse = { via: 'invite'; kind: ArtifactKind }
export type ArtifactListResponse = { artifacts: ArtifactMeta[] }
/** A 409 from save: someone saved first. Re-read, reapply, retry. */
export type ArtifactConflict = { error: string; currentRevision: number }

export type ArtifactInvite = {
  id: string
  email: string
  role: ArtifactShareRole
  accepted: boolean
  createdAt: string
  /** The accepted invitee's display name (null when they have none, or have not accepted). */
  name?: string | null
}
export type ArtifactAccess = {
  linkAccess: ArtifactLinkAccess
  linkRole: ArtifactShareRole
  /** A token exists; it is never readable again, only rotatable. */
  hasLinkToken: boolean
  invites: ArtifactInvite[]
  /** The owner's display name (null when they have none). */
  ownerName?: string | null
}
export type ArtifactShareResponse = {
  linkAccess: ArtifactLinkAccess
  linkRole: ArtifactShareRole
  /** The raw link token: only in the response that minted it. */
  token: string | null
}

const ROLE_RANK: Record<ArtifactRole, number> = {
  viewer: 1,
  commenter: 2,
  editor: 3,
  owner: 4,
}

/** What a role allows; the server enforces the same table (store.ts). */
export function artifactCan(
  role: ArtifactRole,
  action: 'comment' | 'edit' | 'history' | 'share',
): boolean {
  const needed: ArtifactRole =
    action === 'comment'
      ? 'commenter'
      : action === 'share'
        ? 'owner'
        : 'editor'
  return ROLE_RANK[role] >= ROLE_RANK[needed]
}

// ---------------------------------------------------------------- history

/** History rows kept per artifact; older rows are dropped (their bodies stay). */
export const ARTIFACT_REVISIONS_KEPT = 200
export const ARTIFACT_REVISION_PAGE_MAX = 100
/**
 * A user's saves within this long of the revision they started, with nothing
 * else in between, update that revision instead of adding one.
 */
export const ARTIFACT_AUTOSAVE_COALESCE_MS = 5 * 60_000

/** `refresh`: a connected dataset pulled again by the server ("Refreshed from <app>"), never Buffy's edit. */
export const ARTIFACT_REVISION_SOURCES = ['create', 'save', 'restore', 'refresh'] as const
export type ArtifactRevisionSource = (typeof ARTIFACT_REVISION_SOURCES)[number]
export const ARTIFACT_AUTHOR_KINDS = ['user', 'agent'] as const
export type ArtifactAuthorKind = (typeof ARTIFACT_AUTHOR_KINDS)[number]

export type ArtifactRevision = {
  /** The artifact revision this row holds the body of. Rows are sparse: coalesced saves skip numbers. */
  revision: number
  title: string
  bodySha256: string
  bodyBytes: number
  source: ArtifactRevisionSource
  authorKind: ArtifactAuthorKind
  /** The account's display name; null when unknown or the account is gone. */
  authorName: string | null
  /** A short description of what changed ("Added slide 4"); null when unknown. */
  summary: string | null
  /** When this revision was first written. */
  createdAt: string
  /** When it was last written (later than createdAt for coalesced autosaves). */
  savedAt: string
  /** True for the artifact's current revision. */
  current: boolean
}

export const artifactRevisionListQuerySchema = z
  .object({
    /** Revisions older than this one (the last row's `revision`), for the next page. */
    before: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(ARTIFACT_REVISION_PAGE_MAX).optional(),
    linkToken,
  })
  .strict()
export type ArtifactRevisionListQuery = z.infer<typeof artifactRevisionListQuerySchema>

export type ArtifactRevisionListResponse = {
  revisions: ArtifactRevision[]
  /** Pass as `before` for the next page; null on the last page. */
  nextBefore: number | null
}
export type ArtifactRevisionResponse = {
  revision: ArtifactRevision
  body: ArtifactEncodedBody
}

/** Restoring writes a NEW revision whose body is the old one's, compared-and-set like a save. */
export const artifactRestoreRequestSchema = z
  .object({ expectedRevision: z.number().int().min(1), linkToken })
  .strict()
export type ArtifactRestoreRequest = z.infer<typeof artifactRestoreRequestSchema>

// ---------------------------------------------------------------- comments

export const ARTIFACT_COMMENT_MAX_CHARS = 4000
export const ARTIFACT_COMMENT_QUOTE_MAX_CHARS = 1000
export const ARTIFACT_COMMENT_THREADS_LISTED = 200
export const ARTIFACT_COMMENT_REPLIES_MAX = 100
/** A comment request: its encoded text and quote plus the envelope. */
export const ARTIFACT_COMMENT_REQUEST_MAX_BYTES = 64 * 1024
/** Live comments one artifact may hold. */
export const ARTIFACT_COMMENTS_MAX = 2000

const anchorId = z.string().min(1).max(200)
/** Elements one whiteboard comment anchor names at most (a multi-selection). */
export const ARTIFACT_ANCHOR_MAX_ELEMENTS = 50
const coord = z.number().finite().min(-1e6).max(1e6)
/**
 * A doc block's stable id (doc-block-ids.ts: `b-<hash>` derived, or a kept one), as the sidecar
 * holds it. A doc anchor and a doc view selection carry it beside the block index: an anchor
 * resolves by it first (it survives edits above the block), then by index and quote.
 */
export const ARTIFACT_DOC_BLOCK_ID_PATTERN = /^b-[A-Za-z0-9._-]{1,40}$/

/**
 * Where a thread points, by the artifact's kind. Shape only: a slide, cell or
 * element that is later removed leaves an orphaned anchor, and the thread
 * still reads by its quote.
 */
export const artifactCommentAnchorSchemas = {
  doc: z
    .object({
      kind: z.literal('doc'),
      blockIndex: z.number().int().min(0).max(100_000),
      blockId: z.string().regex(ARTIFACT_DOC_BLOCK_ID_PATTERN).optional(),
    })
    .strict(),
  slides: z.object({ kind: z.literal('slides'), slideId: anchorId }).strict(),
  sheet: z
    .object({
      kind: z.literal('sheet'),
      tabId: anchorId,
      range: z.string().regex(/^[A-Za-z]{1,3}[1-9]\d{0,6}(:[A-Za-z]{1,3}[1-9]\d{0,6})?$/),
    })
    .strict(),
  data: z.object({ kind: z.literal('data'), blockId: anchorId }).strict(),
  // An element (and, for a multi-selection, every selected element: `elementIds` lists them all,
  // `elementId` first, so a reader that knows only `elementId` still finds the thread), or a point
  // on an empty part of the board.
  whiteboard: z.union([
    z
      .object({
        kind: z.literal('whiteboard'),
        elementId: anchorId,
        elementIds: z.array(anchorId).min(2).max(ARTIFACT_ANCHOR_MAX_ELEMENTS).optional(),
      })
      .strict()
      .refine((anchor) => !anchor.elementIds || anchor.elementIds[0] === anchor.elementId, 'elementIds starts with elementId'),
    z.object({ kind: z.literal('whiteboard'), x: coord, y: coord }).strict(),
  ]),
  design: z
    .object({ kind: z.literal('design'), boardId: anchorId, nodeId: anchorId.optional() })
    .strict(),
} satisfies Record<ArtifactKind, z.ZodType>

export const artifactCommentAnchorSchema = z.union([
  artifactCommentAnchorSchemas.doc,
  artifactCommentAnchorSchemas.slides,
  artifactCommentAnchorSchemas.sheet,
  artifactCommentAnchorSchemas.data,
  artifactCommentAnchorSchemas.whiteboard,
  artifactCommentAnchorSchemas.design,
])
export type ArtifactCommentAnchor = z.infer<typeof artifactCommentAnchorSchema>

/** The anchor, checked against the artifact's own kind; an error message when it does not fit. */
export function parseArtifactCommentAnchor(
  kind: ArtifactKind,
  anchor: unknown,
): { ok: true; anchor: ArtifactCommentAnchor } | { ok: false; error: string } {
  const parsed = artifactCommentAnchorSchemas[kind].safeParse(anchor)
  if (parsed.success) return { ok: true, anchor: parsed.data as ArtifactCommentAnchor }
  const [issue] = parsed.error.issues
  return {
    ok: false,
    error: `Not a ${kind} anchor: ${issue?.path.join('.') || 'anchor'}: ${issue?.message ?? 'invalid'}`,
  }
}

/** Base64 of at most `max` UTF-16 units (≤ 3 UTF-8 bytes each); the store counts characters. */
const commentText = (max: number) =>
  z
    .object({ encoding: z.literal('base64'), data: z.string().max(max * 4 + 4) })
    .strict()

/**
 * A new thread (anchor optional, `quote` the selected text) or, with
 * `threadId`, a reply. Text travels base64 like bodies (the edge WAF).
 */
export const artifactCommentAddRequestSchema = z
  .object({
    body: commentText(ARTIFACT_COMMENT_MAX_CHARS),
    threadId: z.string().min(1).max(64).optional(),
    anchor: z.record(z.string(), z.unknown()).optional(),
    quote: commentText(ARTIFACT_COMMENT_QUOTE_MAX_CHARS).optional(),
    linkToken,
  })
  .strict()
export type ArtifactCommentAddRequest = z.infer<typeof artifactCommentAddRequestSchema>

/** Exactly one of: new text (author only), or resolve / reopen the comment's thread. */
export const artifactCommentUpdateRequestSchema = z
  .object({
    body: commentText(ARTIFACT_COMMENT_MAX_CHARS).optional(),
    resolved: z.boolean().optional(),
    linkToken,
  })
  .strict()
  .refine((input) => (input.body === undefined) !== (input.resolved === undefined), {
    message: 'Pass exactly one of body or resolved',
  })
export type ArtifactCommentUpdateRequest = z.infer<typeof artifactCommentUpdateRequestSchema>

export const ARTIFACT_COMMENT_STATES = ['open', 'resolved', 'all'] as const
export type ArtifactCommentState = (typeof ARTIFACT_COMMENT_STATES)[number]
/**
 * How far back an `afterSeq` read reaches before its cursor: a comment written in a transaction
 * that committed just after the previous read (its time is its transaction's start) is never
 * missed. A thread may therefore come back once more; readers merge by thread id.
 */
export const ARTIFACT_COMMENT_SEQ_OVERLAP_MS = 5_000
export const artifactCommentListQuerySchema = z
  .object({
    state: z.enum(ARTIFACT_COMMENT_STATES).default('open'),
    /**
     * A cursor (`latestSeq` of an earlier list): only threads with a comment written since
     * (less `ARTIFACT_COMMENT_SEQ_OVERLAP_MS`). New comments and replies only: an edit, a resolve
     * or a delete does not move a thread past it.
     */
    afterSeq: z.coerce.number().int().min(0).optional(),
    linkToken,
  })
  .strict()

export type ArtifactComment = {
  id: string
  threadId: string
  authorKind: ArtifactAuthorKind
  /** The account's display name, never its email; null when unknown or gone. */
  authorName: string | null
  /** Plain text / Markdown. Empty for a deleted root kept for its replies. */
  body: string
  createdAt: string
  editedAt: string | null
  /** A deleted root that still has replies; its body is empty. */
  deleted: boolean
  /** The viewer wrote it (and may edit it). */
  mine: boolean
  /** The viewer may delete it: its author, or the artifact's owner. */
  canDelete: boolean
}

export type ArtifactCommentThread = {
  id: string
  anchor: ArtifactCommentAnchor | null
  /** The text selected when the thread began, so an orphaned anchor still reads. */
  quote: string | null
  resolvedAt: string | null
  resolvedByName: string | null
  /** Root first, then replies oldest first. */
  comments: ArtifactComment[]
}

export type ArtifactCommentListResponse = {
  threads: ArtifactCommentThread[]
  /** Whether the viewer may comment, reply and resolve. */
  canComment: boolean
  /**
   * The cursor for the next `afterSeq` read: the newest comment's time (ms) of every thread in
   * this state, listed or not; null when there is none. Absent from an older API.
   */
  latestSeq?: number | null
}

// ---------------------------------------------------------------- invites by email

/**
 * The browser's request to freebuff-web's `POST /api/artifacts/invite-email`
 * after it created (or wants to resend) an invite. Ids only: the title, role,
 * address and inviter are read server-side as the signed-in user, never taken
 * from the client.
 */
export const artifactInviteEmailRequestSchema = z
  .object({
    artifactId: z.uuid(),
    inviteId: z.uuid(),
  })
  .strict()
export type ArtifactInviteEmailRequest = z.infer<typeof artifactInviteEmailRequestSchema>

/**
 * `sent: false` when this server has no email transport (local dev, staging
 * without a key) or the provider refused: the dialog tells the inviter to
 * copy a link instead. The same answer whether or not the address has an
 * account. A refusal (not yours, revoked, too soon, over budget) is a 4xx
 * `{ error }` instead.
 */
export type ArtifactInviteEmailResponse = {
  sent: boolean
  reason?: 'email_unavailable' | 'send_failed'
}

/** Emails one invite may receive in all; a resend after this is refused. */
export const ARTIFACT_INVITE_EMAILS_PER_INVITE = 5
/** The least time between two emails to the same invite. */
export const ARTIFACT_INVITE_EMAIL_COOLDOWN_MS = 10 * 60_000
/**
 * How long an invite email's link opens anything after the email that minted it (a resend mints
 * a new one and restarts the clock). It only ever leads to sign-in: once the invited account
 * accepts, it reaches the artifact through its own access, and the link stops resolving.
 */
export const ARTIFACT_INVITE_TOKEN_TTL_MS = 14 * 24 * 60 * 60_000

/**
 * What `POST artifacts/:id/invites/:inviteId/email` answers the
 * freebuff-web server (never a browser): the facts of the email, all from
 * the database. The caller minted the invite's new token and sent only its
 * SHA-256, so this response carries no secret.
 */
export type ArtifactInviteEmailClaim = {
  email: string
  role: ArtifactShareRole
  artifactTitle: string
  artifactKind: ArtifactKind
  /** The inviting account's display name; null when it has none. */
  inviterName: string | null
}
export const artifactInviteEmailClaimRequestSchema = z
  .object({ tokenSha256: z.string().regex(/^[0-9a-f]{64}$/) })
  .strict()

export type ArtifactInviteAcceptResponse = {
  artifactId: string
  role: ArtifactShareRole
}
/**
 * A signed-in account whose verified email is not the invited one, or an
 * invite another account already accepted. Never names the invited address.
 */
export type ArtifactInviteRefusal = {
  error: string
  code: 'invite_other_account'
}
export const ARTIFACT_INVITE_OTHER_ACCOUNT_MESSAGE =
  'This invite was sent to a different email address. Sign in with the invited address to open it.'

// ---------------------------------------------------------------- image assets

/**
 * Images uploaded into an artifact. A body names one by a same-origin path,
 * `/_asset/<assetId>`, which every kind's image src rule accepts (slides
 * `image.src`, whiteboard `image.src`, design `image.src`; a doc's Markdown
 * `![alt](/_asset/<id>)` is not validated). The path is a reference, not a
 * URL anything serves: a renderer rewrites it with `resolveArtifactAssetSrc`
 * for where it draws (the workspace, or the public page of a share link).
 *
 * Bytes are sniffed by magic number on upload (PNG, JPEG, WebP, GIF only;
 * never SVG, whatever the declared type) and stored content-addressed in the
 * artifact owner's Cloud R2 prefix, so account erasure removes them.
 */
export const ARTIFACT_ASSET_CONTENT_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
] as const
export type ArtifactAssetContentType = (typeof ARTIFACT_ASSET_CONTENT_TYPES)[number]
export const ARTIFACT_ASSET_MAX_BYTES = 5 * 1024 * 1024
export const ARTIFACT_ASSETS_MAX = 200
export const ARTIFACT_ASSETS_MAX_TOTAL_BYTES = 100 * 1024 * 1024
/** New uploads one account may make per hour, across artifacts. */
export const ARTIFACT_ASSET_UPLOADS_PER_HOUR = 120
/** A side longer than this is refused (decoders and canvases choke first). */
export const ARTIFACT_ASSET_MAX_SIDE = 16_384
/** Pixels one image may decode to (a small file can decode to gigabytes of RGBA and crash a tab). */
export const ARTIFACT_ASSET_MAX_PIXELS = 50_000_000

export type ArtifactAsset = {
  id: string
  contentType: ArtifactAssetContentType
  bytes: number
  sha256: string
  /** From the image header; null when it could not be read cheaply. */
  width: number | null
  height: number | null
  createdAt: string
  /** `/_asset/<id>`, ready to put in a body. */
  ref: string
}
export type ArtifactAssetListResponse = { assets: ArtifactAsset[] }

const ASSET_ID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
/** An asset reference as it appears in a body; group 1 is the asset id. */
export const ARTIFACT_ASSET_REF_PATTERN = new RegExp(`^/_asset/(${ASSET_ID})$`)
/** Every asset reference inside a longer text (a Markdown body); group 1 is the id. */
export const ARTIFACT_ASSET_REF_GLOBAL_PATTERN = new RegExp(`/_asset/(${ASSET_ID})(?![0-9a-f-])`, 'g')
export const ARTIFACT_ASSET_ID_PATTERN = new RegExp(`^${ASSET_ID}$`)

export function artifactAssetRef(assetId: string): string {
  if (!ARTIFACT_ASSET_ID_PATTERN.test(assetId)) throw new Error('Not an artifact asset id')
  return `/_asset/${assetId}`
}

/** The asset id a src names, or null when it is not an asset reference. */
export function parseArtifactAssetRef(src: string): string | null {
  return ARTIFACT_ASSET_REF_PATTERN.exec(src)?.[1] ?? null
}

/**
 * Where a renderer is drawing an artifact:
 *  - `workspace`: the signed-in workspace (web and hosted Desktop), through
 *    the workspace gateway; a signed-in link holder passes their link token;
 *  - `shared`: the public page of a share or invite link,
 *    `/artifacts/<token>`, which proxies the artifact's own images.
 */
export type ArtifactAssetSurface =
  | { surface: 'workspace'; artifactId: string; linkToken?: string }
  | { surface: 'shared'; token: string }

/**
 * The URL to load for an image src. An asset reference becomes this
 * surface's same-origin asset route; anything else is returned unchanged
 * (the kind's own rules already allow it, and the public page decides
 * separately whether it loads third-party images). Pure: UI on both
 * surfaces imports it.
 */
export function resolveArtifactAssetSrc(src: string, where: ArtifactAssetSurface): string {
  const assetId = parseArtifactAssetRef(src)
  if (!assetId) return src
  if (where.surface === 'shared') {
    if (!ARTIFACT_LINK_TOKEN_PATTERN.test(where.token)) return src
    return `/artifacts/${where.token}/asset/${assetId}`
  }
  if (!ARTIFACT_ASSET_ID_PATTERN.test(where.artifactId)) return src
  const path = `/api/workspace/cloud/artifacts/${where.artifactId}/assets/${assetId}`
  return where.linkToken && ARTIFACT_LINK_TOKEN_PATTERN.test(where.linkToken)
    ? `${path}?linkToken=${where.linkToken}`
    : path
}

/** The file extension served for a stored type. */
export function artifactAssetExtension(type: ArtifactAssetContentType): string {
  return type === 'image/jpeg' ? 'jpg' : type.slice('image/'.length)
}

/**
 * The headers every asset response carries, on the API, the workspace
 * gateway and the public page alike: the stored type exactly, never sniffed,
 * shown inline under a name built from the id, reauthorized on each request,
 * and sandboxed so that even a file a browser chose to render as a document
 * could run nothing. A different account in the same browser must not reuse
 * an eligible account's cached image.
 */
export const ARTIFACT_ASSET_CACHE_CONTROL = 'private, no-store'
export function artifactAssetHeaders(asset: {
  id: string
  contentType: ArtifactAssetContentType
  /** Null when a proxy cannot know it (the hop decoded a content-encoding). */
  bytes: number | null
  sha256: string
}): Record<string, string> {
  return {
    'Content-Type': asset.contentType,
    ...(asset.bytes === null ? {} : { 'Content-Length': String(asset.bytes) }),
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': `inline; filename="${asset.id}.${artifactAssetExtension(asset.contentType)}"`,
    'Cache-Control': ARTIFACT_ASSET_CACHE_CONTROL,
    'Content-Security-Policy': "default-src 'none'; sandbox",
    ETag: `"${asset.sha256}"`,
  }
}

export function isArtifactAssetContentType(value: string): value is ArtifactAssetContentType {
  return (ARTIFACT_ASSET_CONTENT_TYPES as readonly string[]).includes(value)
}
