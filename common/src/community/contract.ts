/**
 * The Community contract: the JSON every client (the web workspace, which
 * Desktop hosts, and the native apps) reads and writes. Shapes and limits
 * only. How a feed is ranked and how a quality score is set are the server's
 * business and are not here: this package is published.
 *
 * A profile is a chosen handle, name and picture. It never carries the
 * sign-in name, photo or email (the legacy community was taken offline over
 * exactly that), so a person is public here only as far as they made
 * themselves.
 */
import type { FreebuffSubscriptionTierId } from '../constants/freebuff-subscriptions'

/**
 * Who Community is on for. `members` for now (Victor, 2026-11-20): it went
 * out to every limited-access account for a day, and was pulled back to the
 * people who had already posted a site on it. Everyone else has Sites, as
 * before. An admin sees it by switching it on in Settings → Admin.
 *
 * This is the workspace's rule alone (`communityShownFor`): the API answers
 * any signed-in account. Opening it to everyone is this constant, after the
 * launch steps in docs/freebuff-community.md.
 */
export type CommunityAudience = 'members' | 'everyone'
export const COMMUNITY_AUDIENCE: CommunityAudience = 'members'

/** Read through a function so a caller's comparison is not narrowed away. */
export function communityAudience(): CommunityAudience {
  return COMMUNITY_AUDIENCE
}

/** What the API says of the account asking: `GET /community/access`. */
export type CommunityAccess = {
  /** The account has a project posted in Community. */
  member: boolean
  admin: boolean
}

/**
 * Whether the workspace shows Community (in place of Sites) to an account.
 * Until it is open to everyone: a member, or an admin who switched it on.
 * `access` is null while it is not known, or when the API did not answer,
 * and nothing is shown then.
 */
export function communityShownFor(
  access: CommunityAccess | null | undefined,
  adminSwitch: boolean,
  audience: CommunityAudience = communityAudience(),
): boolean {
  if (!access) return false
  return audience === 'everyone' || access.member || (access.admin && adminSwitch)
}

/** One per post; every site fits one. The feed's pills and Explore filter on it. */
export const COMMUNITY_CATEGORIES = [
  'business',
  'consumer',
  'games',
  'social',
  'portfolio',
  'tools',
  'creative',
] as const
export type CommunityCategory = (typeof COMMUNITY_CATEGORIES)[number]

export const COMMUNITY_CATEGORY_LABELS: Record<CommunityCategory, string> = {
  business: 'Business',
  consumer: 'Consumer',
  games: 'Games',
  social: 'Social',
  portfolio: 'Portfolio',
  tools: 'Tools',
  creative: 'Creative',
}

/** Lowest first: a higher index is a higher league. */
export const COMMUNITY_LEAGUES = [
  'bronze',
  'silver',
  'gold',
  'platinum',
  'diamond',
] as const
export type CommunityLeague = (typeof COMMUNITY_LEAGUES)[number]

export const COMMUNITY_LEAGUE_LABELS: Record<CommunityLeague, string> = {
  bronze: 'Bronze',
  silver: 'Silver',
  gold: 'Gold',
  platinum: 'Platinum',
  diamond: 'Diamond',
}

export const COMMUNITY_RANGES = ['week', 'month', 'all'] as const
export type CommunityRange = (typeof COMMUNITY_RANGES)[number]

export const COMMUNITY_LIMITS = {
  title: 80,
  description: 300,
  tags: 5,
  tag: 24,
  bio: 160,
  name: 40,
  company: 60,
  link: 200,
  comment: 500,
  message: 2000,
} as const

/** Lowercase letters, digits and underscores, 3 to 20. */
export const COMMUNITY_HANDLE_PATTERN = /^[a-z0-9_]{3,20}$/

/**
 * The league a plan guarantees: any paid plan starts in Silver and Pro in
 * Gold. A weekly result can move a member above their floor, never below it.
 */
export function communityLeagueFloor(
  plan: FreebuffSubscriptionTierId | null,
): CommunityLeague {
  if (plan === 'pro') return 'gold'
  return plan ? 'silver' : 'bronze'
}

/** The verified mark, and the profile's company and contact fields: Plus ($25 a month) and up. */
export function communityVerifiedPlan(
  plan: FreebuffSubscriptionTierId | null,
): boolean {
  return plan === 'plus' || plan === 'pro'
}

const DAY_MS = 86_400_000

/**
 * The fixed league week holding `at`: Monday 00:00 UTC to the next. Everyone
 * shares the same week, so a standing means the same thing for all of them.
 */
export function communityLeagueWeek(at: Date): { start: Date; end: Date } {
  const day = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate())
  const start = new Date(day - ((new Date(day).getUTCDay() + 6) % 7) * DAY_MS)
  return { start, end: new Date(start.getTime() + 7 * DAY_MS) }
}

/** 1234 → "1.2K", 1_200_000 → "1.2M". Counts on cards, never money. */
export function formatCommunityCount(value: number): string {
  if (value < 1000) return String(Math.max(0, Math.round(value)))
  const [scaled, unit] =
    value < 999_500
      ? [value / 1000, 'K']
      : value < 999_500_000
        ? [value / 1_000_000, 'M']
        : [value / 1_000_000_000, 'B']
  return `${scaled < 100 ? scaled.toFixed(1).replace(/\.0$/, '') : Math.round(scaled)}${unit}`
}

/** Everything a card needs to show who made something. */
export type CommunityUser = {
  handle: string
  name: string
  /** A picture the member uploaded; null draws their initial. */
  avatarUrl: string | null
  verified: boolean
  league: CommunityLeague
  /** Whether the viewer follows them. Absent for the viewer themself. */
  following?: boolean
}

export type CommunityComment = {
  id: string
  author: CommunityUser
  body: string
  createdAt: string
  /** The viewer wrote it, or owns what it is on, and may remove it. */
  removable?: boolean
}

export type CommunityPost = {
  id: string
  author: CommunityUser
  title: string
  description: string
  category: CommunityCategory
  tags: string[]
  /** The live address: a Freebuff site, or any address for a manual listing. */
  url: string
  /** 16:10 landing screenshot; null until the first capture lands. */
  thumbnailUrl: string | null
  /** `site` is a published Freebuff site and can be embedded; `listing` was added by hand. */
  kind: 'site' | 'listing'
  publishedAt: string
  likes: number
  comments: number
  views: number
  liked: boolean
  /** The newest comments, so a feed card can show them without a second read. */
  recentComments: CommunityComment[]
  /**
   * Sent to the owner alone, for a post nobody else can see yet: `pending`
   * is waiting for its review, `held` did not pass it, `hidden` is a site
   * that is not published.
   */
  status?: 'pending' | 'held' | 'hidden'
  /**
   * Sent to the owner alone: they chose this picture, so a site's screenshot
   * no longer replaces it.
   */
  ownPicture?: true
}

/**
 * An owner's edit of a post. `thumbnailUrl` is left out to keep the picture,
 * an uploaded picture's address to set it, and null to give it up: a site
 * goes back to its screenshot, a listing to none.
 */
export type CommunityPostEdit = Pick<CommunityPost, 'title' | 'description' | 'category'> & {
  thumbnailUrl?: string | null
}

export type CommunityFeed = {
  /** The strip above the feed; sent with the first page only. */
  trending: CommunityPost[]
  posts: CommunityPost[]
  /** Opaque; null at the end. */
  next: string | null
}

export type CommunityPostPage = {
  post: CommunityPost
  comments: CommunityComment[]
  related: CommunityPost[]
}

export type CommunityProfileLinks = {
  website: string | null
  github: string | null
  x: string | null
  /** Verified profiles only. */
  linkedin: string | null
}

/** One day of the usage map. `level` is 0 to 4, shaded like a contribution graph. */
export type CommunityUsageDay = { day: string; tokens: number; level: number }
export type CommunityUsageWeek = { weekStart: string; tokens: number }

export type CommunityProfile = CommunityUser & {
  bio: string
  links: CommunityProfileLinks
  /** Verified profiles only. */
  company: string | null
  contact: string | null
  followers: number
  followingCount: number
  self: boolean
  /** Sent to an admin alone: whether the member is banned from Community. */
  banned?: boolean
  /** A private profile shows its header alone to anyone but its owner. */
  private: boolean
  joinedAt: string
  stats: {
    posts: number
    likes: number
    views: number
    tokens: number
    streak: number
    /** Place on the all-time members board; null when unranked. */
    rank: number | null
  }
  /** The last 53 weeks, oldest first. Empty when private. */
  usage: CommunityUsageDay[]
  /** The last 12 weeks, oldest first. */
  weeks: CommunityUsageWeek[]
  posts: CommunityPost[]
  /** Comments left on the profile itself. */
  wall: CommunityComment[]
}

/** What the owner may change. Company, contact and LinkedIn are kept only for a verified plan. */
export type CommunityProfileSettings = {
  handle: string
  name: string
  bio: string
  avatarUrl: string | null
  links: CommunityProfileLinks
  company: string | null
  contact: string | null
  private: boolean
  /** Off: a published site stays out of the community until its owner posts it. */
  autoPost: boolean
}

export type CommunityMe = {
  profile: CommunityUser
  settings: CommunityProfileSettings
  plan: FreebuffSubscriptionTierId | null
  unreadNotifications: number
  unreadMessages: number
  /** The viewer may ban a member from Community. */
  admin?: boolean
}

export type CommunityListingInput = {
  title: string
  description: string
  url: string
  category: CommunityCategory
  /** An uploaded screenshot; without one the capture job takes it. */
  thumbnailUrl: string | null
}

export type CommunityLeaderboardUser = {
  rank: number
  user: CommunityUser
  followers: number
  likes: number
  views: number
}

export type CommunityLeagueStanding = {
  rank: number
  user: CommunityUser
  /** Likes on their projects this week: what decides promotion. */
  likes: number
  /** A blend of likes, followers, usage and plan, shown beside the likes. */
  rating: number
  zone: 'promote' | 'stay' | 'demote'
  self: boolean
}

export type CommunityLeagueBoard = {
  league: CommunityLeague
  weekStart: string
  weekEnd: string
  standings: CommunityLeagueStanding[]
}

export type CommunityNotification = {
  id: string
  kind: 'like' | 'comment' | 'follow' | 'wall' | 'league' | 'posted'
  actor: CommunityUser | null
  post: Pick<CommunityPost, 'id' | 'title' | 'thumbnailUrl'> | null
  /** The comment's words, or the league reached. */
  text: string | null
  createdAt: string
  read: boolean
}

export type CommunityConversation = {
  with: CommunityUser
  last: { body: string; at: string; mine: boolean }
  unread: number
}

export type CommunityMessage = {
  id: string
  body: string
  at: string
  mine: boolean
}

export type CommunitySearch = {
  posts: CommunityPost[]
  users: (CommunityUser & { followers: number })[]
}
