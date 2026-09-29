import { describe, expect, it } from 'bun:test'

import {
  LAUNCH_INTENT_KEYWORDS,
  mentionsLaunchKeyword,
  mentionsPrKeyword,
  PR_INTENT_KEYWORDS,
} from './partner-triggers'

/**
 * The trigger for a partner slot above the composer, tested on its own
 * because it is the one rule that decides whether the ad appears at all.
 *
 * It replaced a pair of verb-plus-noun regexes, so these cases are written
 * around the change of trade: the phrasings the old rule missed now match,
 * and the substring accidents it avoided must stay avoided.
 */
describe('mentionsPrKeyword', () => {
  it('fires on any mention of a PR, merging or review', () => {
    for (const prompt of [
      // What the verb-plus-noun regexes matched, and still must.
      'open a PR',
      'Create the pull request',
      'submit a new pull request',
      'merge this',
      'merge my branch',
      // What they missed, which is most of how people actually say it.
      'can you review this',
      'ready to merge?',
      'the pr is failing',
      'reviewing the diff now',
      'fix the merged migration',
      'address the reviewer comments',
    ]) {
      expect([prompt, mentionsPrKeyword(prompt)]).toEqual([prompt, true])
    }
  })

  it('reads a keyword through punctuation and casing', () => {
    // Splitting on non-alphanumerics is what buys these without a list of
    // them: an advertiser's slot must not turn on how somebody punctuates.
    for (const prompt of [
      'PR#12 is green',
      'look at pr-123',
      'is it (merged)?',
      'REVIEW THIS',
      'branch->merge',
    ]) {
      expect([prompt, mentionsPrKeyword(prompt)]).toEqual([prompt, true])
    }
  })

  it('never fires on a substring of a longer word', () => {
    // The one way this shape of rule goes obviously wrong. An ad that
    // appeared while somebody typed "print the logs" would read as an ad
    // that appears always.
    for (const prompt of [
      'print the logs',
      'improve this function',
      'reprocess the queue',
      'emerge from this',
      'prepare release notes',
      'preview the site',
      'what does this function do',
      '',
    ]) {
      expect([prompt, mentionsPrKeyword(prompt)]).toEqual([prompt, false])
    }
  })

  it('matches every word in the set on its own', () => {
    // The set is the rule, so a keyword that cannot fire by itself is a
    // keyword that is not in the rule.
    for (const keyword of PR_INTENT_KEYWORDS) {
      expect([keyword, mentionsPrKeyword(keyword)]).toEqual([keyword, true])
      expect([keyword, mentionsPrKeyword(keyword.toUpperCase())]).toEqual([
        keyword,
        true,
      ])
    }
  })

  it('leaves out the words that are in every coding request', () => {
    // `open`, `create` and `branch` say nothing on their own. Including them
    // would make the trigger "the user typed something".
    for (const word of ['open', 'create', 'branch', 'commit', 'push']) {
      expect([word, mentionsPrKeyword(word)]).toEqual([word, false])
    }
    // `pull` is the knowingly loose one: it is how "pull request" spelled in
    // full matches at all, and it also catches `git pull`.
    expect(mentionsPrKeyword('git pull')).toBe(true)
  })
})

/**
 * The LAUNCH trigger, for the composer slots whose subject is what happens
 * after the code ships. Same whole-word rule as the PR one.
 */
describe('mentionsLaunchKeyword', () => {
  it('fires on launching, deploying, shipping and showing off the work', () => {
    for (const prompt of [
      'deploy this to vercel',
      'we are launching tomorrow, write the post',
      'ship it',
      'make a demo video of the new flow',
      'build a pitch deck from the README',
      'draft the Product Hunt announcement',
      'update the landing page hero',
      'Deploying: fix the build first',
    ]) {
      expect([prompt, mentionsLaunchKeyword(prompt)]).toEqual([prompt, true])
    }
  })

  it('stays quiet on ordinary coding requests and substring accidents', () => {
    for (const prompt of [
      'fix the failing test',
      'relaunchable is not a word we use', // substring, not a whole word
      'shipment tracking api', // `shipment` is not `ship`
      'add a release build config',
      'post the form data to the api',
      '',
    ]) {
      expect([prompt, mentionsLaunchKeyword(prompt)]).toEqual([prompt, false])
    }
  })

  it('shares no keyword with the PR trigger, so one draft picks one slot', () => {
    for (const word of LAUNCH_INTENT_KEYWORDS) {
      expect([word, PR_INTENT_KEYWORDS.has(word)]).toEqual([word, false])
    }
  })
})
