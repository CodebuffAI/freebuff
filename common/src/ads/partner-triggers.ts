/**
 * When a PARTNER slot whose subject is pull requests may appear.
 *
 * Shared by Desktop's composer pill, the CLI's composer row and the console
 * caption that tells an advertiser when their slot is shown, because those
 * three disagreeing is an advertiser reading one rule and buying another.
 */

/**
 * The words that mean somebody is talking about a pull request.
 *
 * A NAIVE WHOLE-WORD SET, and deliberately so. This replaced a pair of
 * regexes that required a verb and a noun in a particular order ("open a new
 * PR", "merge this branch"), which read as precise and in practice matched
 * almost nothing: "can you review this", "pr is failing" and "ready to
 * merge?" are all the moment the ad is for, and none of them matched.
 * Precision is not the property worth optimising here -- the slot is one
 * advertiser's chrome next to the feature it is about, so a false positive
 * costs a line of colour above the composer while a false negative costs the
 * impression entirely.
 *
 * WHAT IS DELIBERATELY ABSENT. `open`, `create` and `branch` say nothing on
 * their own: they are in a large share of all coding requests, and including
 * them would make the trigger "the user typed something", which is not a
 * trigger. `pull` IS included even though it also matches `git pull`, which
 * is the loose end we accepted knowingly -- it is the only way "pull request"
 * spelled in full matches, since the set is checked word by word.
 */
export const PR_INTENT_KEYWORDS: ReadonlySet<string> = new Set([
  'pr',
  'prs',
  'pull',
  'merge',
  'merges',
  'merged',
  'merging',
  'review',
  'reviews',
  'reviewed',
  'reviewing',
  'reviewer',
])

/**
 * Whether `text` mentions pull requests, merging or code review.
 *
 * WHOLE WORDS, not substrings. A substring test is the one way this shape of
 * rule goes obviously wrong: `pr` appears in "print", "improve" and
 * "reprocess", and an ad that appeared while somebody typed "print the logs"
 * would read as an ad that appears always.
 *
 * Splitting on non-alphanumerics is what makes the punctuation cases work
 * without a list of them: `PR#12`, `pr-123`, `(review)` and `merge?` all
 * yield the bare keyword.
 */
export function mentionsPrKeyword(text: string): boolean {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .some((word) => PR_INTENT_KEYWORDS.has(word))
}
