import { describe, expect, it } from 'bun:test'

import {
  canonicalRedditThingUrl,
  guidanceWithoutShareLink,
  isSubredditCampaignUrl,
  parseRedditThingUrl,
  parseSubredditUrl,
  promotionEvasionReason,
  shareLinkFrom,
  subredditCampaign,
  withShareLink,
} from '../reddit-campaign'

describe('parseSubredditUrl', () => {
  it('reads a subreddit in the shapes advertisers paste', () => {
    for (const raw of [
      'r/cybersecurity',
      '/r/cybersecurity/',
      'https://www.reddit.com/r/cybersecurity/',
      'https://reddit.com/r/CyberSecurity',
      'old.reddit.com/r/cybersecurity/new/',
      'https://www.reddit.com/r/cybersecurity/top/?t=week',
    ]) {
      expect(parseSubredditUrl(raw)).toEqual({
        subreddit: 'cybersecurity',
        canonical: 'https://www.reddit.com/r/cybersecurity/',
      })
    }
  })

  it('refuses posts, comments, users and other sites', () => {
    for (const raw of [
      'https://www.reddit.com/r/cybersecurity/comments/1abc/title/',
      'https://www.reddit.com/r/cybersecurity/comments/1abc/title/xyz/',
      'https://www.reddit.com/user/someone/',
      'https://www.reddit.com/',
      'https://x.com/r/cybersecurity',
      'r/a',
      'not a link',
    ]) {
      expect(parseSubredditUrl(raw)).toBeNull()
    }
    expect(isSubredditCampaignUrl('https://www.reddit.com/r/netsec/')).toBe(true)
  })
})

describe('the share link in a campaign’s guidance', () => {
  it('round-trips, and a user reads the guidance without it', () => {
    const stored = withShareLink(
      'Say what the research found about OAuth token reuse.',
      'https://casco.com/blog/oauth-research',
    )
    expect(shareLinkFrom(stored)).toBe('https://casco.com/blog/oauth-research')
    expect(guidanceWithoutShareLink(stored)).toBe(
      'Say what the research found about OAuth token reuse.',
    )
    // Writing it again replaces the line instead of adding a second one.
    expect(withShareLink(stored, 'https://casco.com/blog/two').split('\n')).toHaveLength(2)
    expect(withShareLink(stored, null)).toBe(
      'Say what the research found about OAuth token reuse.',
    )
  })

  it('ignores a line that is not an https link', () => {
    expect(shareLinkFrom('Link to share: javascript:alert(1)')).toBeNull()
    expect(shareLinkFrom(null)).toBeNull()
  })
})

describe('promotionEvasionReason', () => {
  const refused = (text: string) => promotionEvasionReason(text) !== null

  it('refuses briefs that ask to get past moderation', () => {
    for (const text of [
      'Reply in a way that evades the mods.',
      'Word it to bypass AutoModerator.',
      'Avoid detection by the mods.',
      'Avoid getting caught by the spam filters.',
      'Post it without getting flagged.',
      'Slip past the subreddit rules if you can.',
      'Find a way to get around the ban on vendor posts.',
      'Do it without the mods noticing.',
    ]) {
      expect(promotionEvasionReason(text), text).toContain('moderators')
    }
  })

  it('refuses throwaway, alt and extra accounts used to post', () => {
    for (const text of [
      'Use a throwaway account if needed.',
      'Post from alt accounts so it looks organic.',
      'Use multiple accounts to upvote each other.',
      'Create several new accounts for this.',
      'Burner accounts are fine.',
    ]) {
      expect(promotionEvasionReason(text), text).toContain('own one account')
    }
  })

  it('refuses hiding the sponsorship, in any form', () => {
    for (const text of [
      'Do not mention that this is sponsored by us.',
      'Without mentioning that we paid for it.',
      'Never disclose the sponsorship.',
      "Don't say you're getting paid.",
      'Hide that it is sponsored.',
      'Pretend to be an unaffiliated customer.',
    ]) {
      expect(promotionEvasionReason(text), text).toContain('sponsored')
    }
  })

  it('lets ordinary briefs and ordinary caution through', () => {
    for (const text of [
      'Follow the sub’s rules so we don’t get removed.',
      "Follow the sub's rules so we don't get removed",
      'Avoid breaking the subreddit rules.',
      'Avoid being salesy; respect the rules.',
      'Avoid anything that looks like spam.',
      'Our app lets teams manage multiple accounts.',
      "Don't mention pricing or the paid plan.",
      'Do not hide that it is an ad.',
      'Never hide that it is sponsored.',
      'Answer founders asking how to pass SOC 2 for their first enterprise customer; mention Casco where it helps.',
      'Follow each subreddit’s self-promotion rules.',
    ]) {
      expect(refused(text), text).toBe(false)
    }
  })
})

describe('subredditCampaign: only campaigns made as one', () => {
  const made = {
    postUrl: 'https://www.reddit.com/r/cybersecurity/',
    requiredAction: 'comment',
    previewAuthor: 'r/cybersecurity',
  }

  it('is a reply or post campaign on the canonical link, marked by its preview author', () => {
    expect(subredditCampaign(made)).toEqual({ subreddit: 'cybersecurity' })
    expect(subredditCampaign({ ...made, requiredAction: 'post' })).toEqual({
      subreddit: 'cybersecurity',
    })
  })

  it('is not a like campaign, an older campaign on a subreddit link, or a link written another way', () => {
    expect(subredditCampaign({ ...made, requiredAction: 'like' })).toBeNull()
    expect(subredditCampaign({ ...made, previewAuthor: null })).toBeNull()
    expect(subredditCampaign({ ...made, postUrl: 'https://reddit.com/r/cybersecurity' })).toBeNull()
    expect(
      subredditCampaign({ ...made, postUrl: 'https://www.reddit.com/r/cybersecurity/new/' }),
    ).toBeNull()
  })
})

describe('parseRedditThingUrl', () => {
  it('reads the post and comment ids whatever the slug', () => {
    for (const raw of [
      'https://www.reddit.com/r/x/comments/1abc/some_slug/k9z/',
      'https://www.reddit.com/r/x/comments/1abc/other_slug/k9z',
      'https://www.reddit.com/r/x/comments/1abc/comment/k9z/',
      'https://old.reddit.com/r/X/comments/1ABC/s/K9Z/?context=3',
    ]) {
      expect(parseRedditThingUrl(raw)).toEqual({ postId: '1abc', commentId: 'k9z', key: 't1_k9z' })
    }
    expect(parseRedditThingUrl('https://www.reddit.com/r/x/comments/1abc/some_slug/')).toEqual({
      postId: '1abc',
      commentId: null,
      key: 't3_1abc',
    })
    expect(parseRedditThingUrl('https://www.reddit.com/r/x/')).toBeNull()
    expect(
      canonicalRedditThingUrl('x', { postId: '1abc', commentId: 'k9z' }),
    ).toBe('https://www.reddit.com/r/x/comments/1abc/comment/k9z/')
  })
})
