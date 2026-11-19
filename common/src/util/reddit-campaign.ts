/**
 * Reddit campaigns that are not one fixed post (2026-11-19, for Casco):
 * "reply in r/X to threads about Y", where each user finds a fitting recent
 * thread themselves, and "share this link in r/X", a post of their own.
 *
 * Such a campaign is an ordinary engagement campaign whose link is a
 * SUBREDDIT (`https://www.reddit.com/r/<name>/`) instead of a post, bought
 * as a `comment` (a reply in a thread the user picks) or a `post` (a post of
 * their own). Nothing new is stored: the link says which subreddit, the
 * description says which threads to look for, and the comment guidance says
 * what a good reply covers, with the link to share on a line of its own
 * (`SHARE_LINK_PREFIX`).
 *
 * Pure: shared by the campaign assistant, the Earn assistant, the feed and
 * the submission check.
 */

const SUBREDDIT_NAME = /^[A-Za-z0-9][A-Za-z0-9_]{1,20}$/

/** The results a subreddit campaign can buy. */
export const SUBREDDIT_CAMPAIGN_ACTIONS = ['comment', 'post'] as const

/**
 * `{subreddit, canonical}` for a link to a subreddit itself (`r/name`,
 * `reddit.com/r/name`, with or without `/new`, `/top` and the like), or null
 * for a post, a comment, a user or anything else. The name is lowercased:
 * Reddit treats it so, and the campaign's link is compared as text.
 */
export function parseSubredditUrl(
  raw: string,
): { subreddit: string; canonical: string } | null {
  const trimmed = raw.trim()
  const bare = /^\/?r\/([A-Za-z0-9_]+)\/?$/.exec(trimmed)
  if (bare) {
    const name = bare[1]!
    return SUBREDDIT_NAME.test(name)
      ? {
          subreddit: name.toLowerCase(),
          canonical: `https://www.reddit.com/r/${name.toLowerCase()}/`,
        }
      : null
  }
  let url: URL
  try {
    url = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`)
  } catch {
    return null
  }
  const host = url.hostname.toLowerCase().replace(/^(www|old|new|m)\./, '')
  if (host !== 'reddit.com') return null
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts[0] !== 'r' || !parts[1] || !SUBREDDIT_NAME.test(parts[1])) {
    return null
  }
  // Anything under the subreddit that is a listing, not a post.
  if (parts.length > 3) return null
  if (parts[2] && !/^(new|hot|top|rising|controversial|about)$/i.test(parts[2])) {
    return null
  }
  const name = parts[1].toLowerCase()
  return { subreddit: name, canonical: `https://www.reddit.com/r/${name}/` }
}

export function isSubredditCampaignUrl(postUrl: string): boolean {
  return parseSubredditUrl(postUrl) !== null
}

/**
 * The subreddit of a STORED campaign post that is a subreddit campaign, or
 * null. Strict, so that only campaigns made as one are treated as one: the
 * link is exactly the canonical subreddit link, the result is a reply or a
 * post, and the post's preview author is `r/<name>`, which the campaign
 * assistant writes when it creates one. A like campaign, or one made before
 * subreddit campaigns existed on a subreddit link, keeps the ordinary
 * screenshot path. `isSubredditCampaignSql` (server) is the same test in SQL.
 */
export function subredditCampaign(post: {
  postUrl: string
  requiredAction: string | null | undefined
  previewAuthor: string | null | undefined
}): { subreddit: string } | null {
  const target = parseSubredditUrl(post.postUrl)
  if (!target || target.canonical !== post.postUrl) return null
  if (!(SUBREDDIT_CAMPAIGN_ACTIONS as readonly unknown[]).includes(post.requiredAction)) {
    return null
  }
  return post.previewAuthor === `r/${target.subreddit}`
    ? { subreddit: target.subreddit }
    : null
}

/** The preview author a subreddit campaign is stored with. */
export const subredditPreviewAuthor = (subreddit: string) => `r/${subreddit}`

/**
 * The Reddit thing a thread or comment link names: the post id, and the
 * comment id for a comment. Reddit ignores the slug and accepts
 * `/comments/<post>/<slug>/<comment>/` and `/comments/<post>/comment/<comment>/`
 * alike, so two links to one reply differ only here. `key` is Reddit's own
 * full name for it (`t1_<comment>` or `t3_<post>`).
 */
export function parseRedditThingUrl(raw: string): {
  postId: string
  commentId: string | null
  key: string
} | null {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return null
  }
  const host = url.hostname.toLowerCase().replace(/^(www|old|new|m)\./, '')
  if (host !== 'reddit.com') return null
  const parts = url.pathname.split('/').filter(Boolean)
  const at = parts.indexOf('comments')
  const postId = parts[at + 1]?.toLowerCase()
  if (at < 0 || !postId || !/^[a-z0-9]{1,13}$/.test(postId)) return null
  // `<slug>/<comment>` or `comment/<comment>`: the comment id is second.
  const commentPart = parts[at + 3]
  const commentId = commentPart && /^[a-z0-9]{1,13}$/i.test(commentPart)
    ? commentPart.toLowerCase()
    : null
  return {
    postId,
    commentId,
    key: commentId ? `t1_${commentId}` : `t3_${postId}`,
  }
}

/** The one link a reply or post is stored and compared under. */
export function canonicalRedditThingUrl(
  subreddit: string,
  thing: { postId: string; commentId: string | null },
): string {
  return thing.commentId
    ? `https://www.reddit.com/r/${subreddit}/comments/${thing.postId}/comment/${thing.commentId}/`
    : `https://www.reddit.com/r/${subreddit}/comments/${thing.postId}/`
}

/** The line in a campaign's comment guidance that carries the link a
 *  "share this link" campaign shares. */
export const SHARE_LINK_PREFIX = 'Link to share: '

export function withShareLink(guidance: string, shareUrl: string | null): string {
  const base = guidance
    .split('\n')
    .filter((line) => !line.startsWith(SHARE_LINK_PREFIX))
    .join('\n')
    .trim()
  return shareUrl ? `${base}${base ? '\n' : ''}${SHARE_LINK_PREFIX}${shareUrl}` : base
}

export function shareLinkFrom(guidance: string | null | undefined): string | null {
  const line = (guidance ?? '')
    .split('\n')
    .find((entry) => entry.startsWith(SHARE_LINK_PREFIX))
  const url = line?.slice(SHARE_LINK_PREFIX.length).trim()
  return url && /^https:\/\/\S+$/.test(url) ? url : null
}

/** The guidance without its share line, as a user reads it. */
export function guidanceWithoutShareLink(
  guidance: string | null | undefined,
): string {
  return (guidance ?? '')
    .split('\n')
    .filter((line) => !line.startsWith(SHARE_LINK_PREFIX))
    .join('\n')
    .trim()
}

/**
 * Why a campaign's brief asks for something we do not do, or null.
 *
 * Users act from their own one account, in each community's rules, and say
 * that an engagement is sponsored when asked. A brief that asks to get past
 * moderators, AutoModerator, filters or bans, to post from throwaway or extra
 * accounts, or to hide the sponsorship is refused before anything is
 * created, whatever the platform.
 *
 * Narrow on purpose: it runs on every campaign, so it names the evasion asks
 * and lets ordinary caution through ("follow the rules so we don't get
 * removed", "avoid anything that looks like spam", "don't mention pricing").
 * A reworded ask can get past it; the assistants' prompts carry the rest.
 */
export function promotionEvasionReason(text: string): string | null {
  const t = text.toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ')
  if (EVADE_MODERATION.some((pattern) => pattern.test(t))) {
    return 'We do not help get around a community’s moderators, filters or bans. Users post where self-promotion is allowed, from their own account.'
  }
  if (EXTRA_ACCOUNTS.some((pattern) => pattern.test(t))) {
    return 'Each person posts from their own one account. A brief cannot ask for several or throwaway accounts.'
  }
  if (HIDE_SPONSORSHIP.some((pattern) => pattern.test(t)) || asksToHide(t)) {
    return 'A brief cannot ask people to hide that a post is sponsored. They write in their own words and say so if asked.'
  }
  return null
}

const MODERATION =
  '(mods?|moderators?|moderation|auto-?mod\\w*|filters?|spam filters?|bans?|detection|the rules|subreddit rules|its rules|their rules)'

const EVADE_MODERATION = [
  // Getting past moderation by any verb that means it.
  new RegExp(
    `\\b(evade\\w*|evading|bypass\\w*|dodg\\w*|circumvent\\w*|get around|getting around|slip(ping)? past|sneak(ing)? past|get past|getting past)\\b[^.]{0,30}\\b${MODERATION}`,
  ),
  // "Avoid" only where what is avoided is being caught, not breaking rules.
  /\bavoid\w*\b[^.]{0,20}\b(detection|being detected|getting caught|being caught|getting flagged|being flagged|the mods|moderators|automod\w*|auto-mod\w*|spam filters?|the filters?)\b/,
  /\bwithout (getting |being )?(caught|noticed|flagged|detected)\b/,
  /\bwithout (the )?(mods|moderators|automod\w*) (noticing|knowing|seeing|catching)\b/,
  /\bfly(ing)? under the radar\b/,
]

const EXTRA_ACCOUNTS = [
  /\b(throwaways?|throwaway accounts?|burner accounts?|sock ?puppets?|alt accounts?)\b/,
  /\b(use|using|from|create|creating|make|making|set up|post (from|with)|posting (from|with)|comment (from|with)|switch(ing)? (to|between)|rotate|rotating)\b[^.]{0,20}\b(multiple|several|different|extra|second|other|new|fake|many) (reddit |x |twitter |youtube )?accounts\b/,
]

const SPONSOR_FACT =
  "(sponsor\\w*|advert\\w*|affiliat\\w*|freebuff|compensat\\w*|that (it is|it's|this is|they are|they're|you are|you're) (an ad|paid|sponsored)|(we|they|someone|casco|the company) paid|paid (for|to)|being paid|getting paid|get paid|you're paid|you are paid|is an ad|it's an ad|rewarded)"

const HIDE_SPONSORSHIP = [
  new RegExp(
    `\\b(don't|do not|never|without|no need to|avoid)\\b[^.]{0,15}\\b(say\\w*|mention\\w*|disclos\\w*|reveal\\w*|admit\\w*|tell\\w*|let on|flag\\w*|label\\w*)\\b[^.]{0,30}\\b${SPONSOR_FACT}`,
  ),
  /\b(pretend\w*|pose as|posing as|act like|acting like|as if (you|they) (are|were))\b[^.]{0,25}\b(customer|user|unaffiliated|organic|random|regular|ordinary|independent)\b/,
]

/** "Hide that it is sponsored", but not "do not hide that it is an ad". */
function asksToHide(t: string): boolean {
  const pattern = new RegExp(
    `\\b(hide|hiding|conceal\\w*|mask\\w*|disguis\\w*|obscur\\w*)\\b[^.]{0,30}\\b(${SPONSOR_FACT}|ad|ads|paid)\\b`,
    'g',
  )
  for (const match of t.matchAll(pattern)) {
    const before = t.slice(Math.max(0, match.index - 16), match.index)
    if (!/(n't|\bnot|\bnever|\bno)\s*$/.test(before)) return true
  }
  return false
}
