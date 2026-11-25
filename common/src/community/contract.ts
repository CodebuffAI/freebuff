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
 * Who Community is on for. `everyone` since 2026-11-24 (Victor: "community
 * is ready. flip it on and change the sites section to be the new one for
 * all users"): every account's Sites page is the shared one, with the
 * listing tick box in the Publish menu. It was `members` from 2026-11-20
 * (the people who had posted a site, and admins who switched it on in
 * Settings → Admin); setting it back is the way to close it again.
 *
 * This is the workspace's rule alone (`communityShownFor`): the API answers
 * any signed-in account.
 */
export type CommunityAudience = 'members' | 'everyone'
export const COMMUNITY_AUDIENCE: CommunityAudience = 'everyone'

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

/**
 * The three kinds the page is browsed by. The seven categories are still
 * what a post is filed under (the review picks one); a visitor is shown
 * these, games first. Seven pills was a row nobody read (Victor, 2026-11-22:
 * "just have the biggest categories (either games, projects, creative)").
 */
export const COMMUNITY_GROUPS = ['games', 'projects', 'creative'] as const
export type CommunityGroup = (typeof COMMUNITY_GROUPS)[number]

export const COMMUNITY_GROUP_LABELS: Record<CommunityGroup, string> = {
  games: 'Games',
  // The group's id is on the wire and stays; its name is Tools (Sam, 2026-11-24).
  projects: 'Tools',
  creative: 'Creative',
}

/** The group a category is shown under: games and creative are their own, the rest are projects. */
export function communityGroupOf(category: CommunityCategory): CommunityGroup {
  return category === 'games' || category === 'creative' ? category : 'projects'
}

/** The categories a group holds. */
export function communityGroupCategories(group: CommunityGroup): CommunityCategory[] {
  return COMMUNITY_CATEGORIES.filter((category) => communityGroupOf(category) === group)
}

/** What a post's opens are called: a game is played, anything else is viewed. */
export function communityViewsLabel(category: CommunityCategory, count: number): string {
  const noun = category === 'games' ? 'play' : 'view'
  return count === 1 ? noun : `${noun}s`
}

/**
 * Lowest first: a higher index is a higher league. Three for now (Victor,
 * 2026-11-20); there were five. A league stored from before that is not in
 * this list reads as the top one (`effectiveLeague`).
 */
export const COMMUNITY_LEAGUES = ['bronze', 'silver', 'gold'] as const
export type CommunityLeague = (typeof COMMUNITY_LEAGUES)[number]

export const COMMUNITY_LEAGUE_LABELS: Record<CommunityLeague, string> = {
  bronze: 'Bronze',
  silver: 'Silver',
  gold: 'Gold',
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
  /** The viewer is an admin and may reword it. */
  editable?: boolean
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
   * Sent to the owner, and to an admin, for a post nobody else can see:
   * `pending` is waiting for its review, `held` did not pass it, `hidden` is
   * a site that is not published. `removed` is an admin's removal, and is
   * sent to admins alone: to its owner the post is gone.
   */
  status?: 'pending' | 'held' | 'hidden' | 'removed'
  /**
   * Sent to the owner, and to an admin: the picture was chosen by hand, so a
   * site's screenshot no longer replaces it.
   */
  ownPicture?: true
  /**
   * Sent on a post's own page, and only as `false`: the site refuses to be
   * shown inside another page, so it is opened and not framed.
   */
  embeddable?: false
  /**
   * Sent on a post's own page when the site answered with an error status
   * (403, 404, 429...): the page says it is not loading, with that code.
   */
  siteStatus?: number
  /**
   * Sent in the feed, for a post worth a second look: `hot` is among what is
   * being liked and opened most these days, `rising` is young and already
   * getting attention. Most posts carry neither.
   */
  heat?: 'hot' | 'rising'
}

/**
 * An owner's edit of a post. `thumbnailUrl` is left out to keep the picture,
 * an uploaded picture's address to set it, and null to give it up: a site
 * goes back to its screenshot, a listing to none.
 */
export type CommunityPostEdit = Pick<CommunityPost, 'title' | 'description' | 'category'> & {
  thumbnailUrl?: string | null
}

/** What was made most recently, newest first: the endless list at the foot of Home. */
export type CommunityFeed = {
  /**
   * Always empty. It held what was hot before Home had shelves
   * (`CommunityHome`); a page loaded before then still reads its length.
   */
  trending: CommunityPost[]
  posts: CommunityPost[]
  /** Opaque; null at the end. */
  next: string | null
}

/** One row of Home: a few posts under a name that says why they are there. */
export type CommunityShelf = {
  /** Stable, for the page to tell shelves apart: `featured`, `hot-games`, `top-games`, ... */
  id: string
  title: string
  /** The group its posts are from, where it has one: what "See all" opens. */
  group?: CommunityGroup
  posts: CommunityPost[]
}

/**
 * Home, or one group's page: what is worth opening, in rows, most worth it
 * first. A row with nothing in it is left out.
 */
export type CommunityHome = {
  shelves: CommunityShelf[]
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

/**
 * One of the viewer's sites and its listing: `GET /community/sites`, and what
 * listing one from the Sites page answers (`POST /community/sites/:id`).
 * `live` is shown; `pending` waits for its review; `held` did not pass it;
 * `hidden` is a site not published now. A site with none is not listed.
 */
export type CommunitySiteListing = {
  siteId: string
  postId: string
  status: 'live' | 'pending' | 'held' | 'hidden'
}

export type CommunityMe = {
  profile: CommunityUser
  settings: CommunityProfileSettings
  plan: FreebuffSubscriptionTierId | null
  unreadNotifications: number
  /** The viewer may ban a member from Community. */
  admin?: boolean
  /**
   * The viewer still has the name every profile starts with, and is asked
   * to choose their own. A profile is never named from the account
   * (docs/freebuff-community.md, "The one rule that came from an incident").
   */
  needsName?: true
}

/** The name every profile started with before names were made up (`generatedIdentity`); still read as one nobody chose. */
export const COMMUNITY_DEFAULT_NAME = 'New maker'

/**
 * A handle to offer for a chosen name: its letters and digits, lowercased
 * and joined by underscores. Null when that leaves too little.
 */
export function communityHandleFor(name: string): string | null {
  const handle = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 20)
    .replace(/_+$/, '')
  return COMMUNITY_HANDLE_PATTERN.test(handle) ? handle : null
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
  /**
   * What the week's top places win when it closes, in hours of usage.
   * Absent while leagues carry no prize: the board then shows none.
   */
  prizes?: CommunityLeaguePrizes
}

export type CommunityLeaguePrizes = {
  /** Hours for first place, second, and so on, in this league. */
  places: number[]
  /** The whole pool of each league, for the ladder: it grows with the league. */
  pools: Record<CommunityLeague, number>
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

export type CommunitySearch = {
  posts: CommunityPost[]
  users: (CommunityUser & { followers: number })[]
}
