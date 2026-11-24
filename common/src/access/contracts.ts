import { z } from 'zod'

/**
 * Sharing, one model for everything Freebuff shares (docs/freebuff-sharing.md). A grant gives a
 * role on one resource to a person (an account, or an address no account has claimed yet) or to
 * everyone with a link. A project's grants reach the chats and artifacts in it; a chat's reach the
 * artifacts made in it.
 *
 * The routes, under the Cloud API's `/api/v1/cloud/` (freebuff-web's workspace gateway forwards
 * all but the email claim):
 *
 *   GET    access/:kind/:id                      who has access (owner only)
 *   POST   access/:kind/:id/people               invite one address `{ email, role }`
 *   PATCH  access/:kind/:id/people/:grantId      change a person's role `{ role }`
 *   DELETE access/:kind/:id/people/:grantId      remove a person
 *   POST   access/:kind/:id/link                 general access `{ enabled, role?, rotate? }`
 *   POST   access/:kind/:id/people/:grantId/email   server to server: claim an invite email
 *   GET    access/shared?kind=                   what is shared with the caller
 */

export const ACCESS_RESOURCE_KINDS = ['project', 'chat', 'artifact'] as const
export type AccessResourceKind = (typeof ACCESS_RESOURCE_KINDS)[number]

export const ACCESS_ROLES = ['viewer', 'commenter', 'editor'] as const
export type AccessRole = (typeof ACCESS_ROLES)[number]
/** A role as a reader holds it: the owner's is never granted. */
export type AccessEffectiveRole = AccessRole | 'owner'

/**
 * How a reader holds their role: they own it, a grant names them, the chat it was made in or the
 * project it is in does, or a link.
 */
export type AccessVia = 'owner' | 'direct' | 'chat' | 'project' | 'link'

export const ACCESS_ROLE_RANK: Record<AccessEffectiveRole, number> = {
  viewer: 1,
  commenter: 2,
  editor: 3,
  owner: 4,
}

/** The strongest of the roles held; null when none. */
export function strongestAccessRole<R extends AccessEffectiveRole>(roles: ReadonlyArray<R | null | undefined>): R | null {
  let best: R | null = null
  for (const role of roles) if (role && (!best || ACCESS_ROLE_RANK[role] > ACCESS_ROLE_RANK[best])) best = role
  return best
}

/** What each kind offers. A chat has nothing to comment on, so it offers view and edit. */
export const ACCESS_KIND_SPECS: Record<
  AccessResourceKind,
  {
    roles: readonly AccessRole[]
    /** Whether "Anyone with the link" applies. Only artifacts open by link for now. */
    links: boolean
    /** A grant on this kind reaches these kinds inside it. */
    contains: readonly AccessResourceKind[]
  }
> = {
  project: { roles: ['viewer', 'commenter', 'editor'], links: false, contains: ['chat', 'artifact'] },
  chat: { roles: ['viewer', 'editor'], links: false, contains: ['artifact'] },
  artifact: { roles: ['viewer', 'commenter', 'editor'], links: true, contains: [] },
}

/**
 * A role as it applies to a kind: a project's commenter reads the project's chats (a chat has
 * nothing to comment on), and comments on its artifacts.
 */
export function accessRoleOn<R extends AccessEffectiveRole>(kind: AccessResourceKind, role: R): R | 'viewer' {
  return role === 'commenter' && !ACCESS_KIND_SPECS[kind].roles.includes('commenter') ? 'viewer' : role
}

/** People one resource may be shared with. */
export const ACCESS_PEOPLE_MAX = 50

/** An invite is emailed at most this often, this many times in all. */
export const ACCESS_INVITE_EMAIL_COOLDOWN_MS = 10 * 60_000
export const ACCESS_INVITE_EMAILS_PER_INVITE = 5
/** How long an invite email's link opens its sign-in prompt. */
export const ACCESS_INVITE_TOKEN_TTL_MS = 14 * 24 * 60 * 60_000

/** One person with access, as the owner sees them in the Share dialog. */
export type AccessPerson = {
  grantId: string
  /** Null for an address no account has claimed yet (`pending`). */
  userId: string | null
  email: string | null
  name: string | null
  role: AccessRole
  /**
   * `chat` / `project`: they hold it through the chat it was made in or the project it is in
   * (changed from that chat's or project's dialog).
   */
  via: 'direct' | 'chat' | 'project'
  pending: boolean
  /** On a project: the number of its chats shared with someone who holds no grant on the project. */
  chats?: number
  createdAt: string
}

export type AccessLink = {
  enabled: boolean
  role: AccessRole
  /** A live link exists. Its token is shown once, when minted; copying an older one rotates it. */
  hasToken: boolean
}

export type AccessListResponse = {
  kind: AccessResourceKind
  id: string
  title: string | null
  owner: { userId: string; email: string | null; name: string | null }
  people: AccessPerson[]
  /** Null on a kind that does not open by link. */
  link: AccessLink | null
  roles: AccessRole[]
}

export type AccessInviteResponse = {
  status: 'granted' | 'invited' | 'updated'
  person: AccessPerson
}

export type AccessLinkResponse = AccessLink & {
  /** The raw token, only when this call minted it. */
  token: string | null
}

/** A resource shared with the caller, for "Shared with you". */
export type AccessSharedItem = {
  kind: AccessResourceKind
  id: string
  title: string
  role: AccessRole
  via: 'direct' | 'chat' | 'project'
  sharedBy: { email: string | null; name: string | null }
  sharedAt: string
}

/** What an invite email needs, recorded by the owner's claim (`.../people/:grantId/email`). */
export type AccessInviteEmailClaim = {
  kind: AccessResourceKind
  id: string
  email: string
  role: AccessRole
  title: string
  inviterName: string | null
  /** No account holds the address yet. */
  pending: boolean
}

export const accessKindSchema = z.enum(ACCESS_RESOURCE_KINDS)
export const accessRoleSchema = z.enum(ACCESS_ROLES)

export const accessInviteRequestSchema = z
  .object({ email: z.string().trim().min(3).max(320).email(), role: accessRoleSchema })
  .strict()
export const accessRoleRequestSchema = z.object({ role: accessRoleSchema }).strict()
export const accessLinkRequestSchema = z
  .object({ enabled: z.boolean(), role: accessRoleSchema.optional(), rotate: z.boolean().optional() })
  .strict()
export const accessInviteEmailClaimRequestSchema = z
  .object({ tokenSha256: z.string().regex(/^[0-9a-f]{64}$/) })
  .strict()

export type AccessInviteRequest = z.infer<typeof accessInviteRequestSchema>
export type AccessLinkRequest = z.infer<typeof accessLinkRequestSchema>
