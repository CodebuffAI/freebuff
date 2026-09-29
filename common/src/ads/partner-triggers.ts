/**
 * When a PARTNER slot may appear: one whose subject is pull requests, or one
 * whose subject is LAUNCHING what was built.
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
  return mentionsAnyWord(text, PR_INTENT_KEYWORDS)
}

/** The whole-word test both triggers share, so they tokenize identically. */
function mentionsAnyWord(text: string, words: ReadonlySet<string>): boolean {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .some((word) => words.has(word))
}

/**
 * The words that mean somebody is about to put what they built in front of
 * people: ship it, deploy it, announce it, demo it.
 *
 * The same naive whole-word rule as {@link PR_INTENT_KEYWORDS}, for the same
 * reason: a false positive costs a line of colour above the composer, and a
 * false negative costs the impression. `deploy` is in deliberately -- the
 * moment somebody deploys is the moment the launch assets are missing.
 *
 * WHAT IS DELIBERATELY ABSENT. `release` also names a build configuration
 * and `post` an HTTP verb; either would put the pill on requests that have
 * nothing to do with a launch. `video`, `deck`, `slides` and `demo` are in:
 * in a coding agent they are almost always about showing the work off.
 */
export const LAUNCH_INTENT_KEYWORDS: ReadonlySet<string> = new Set([
  'launch',
  'launches',
  'launched',
  'launching',
  'ship',
  'ships',
  'shipped',
  'shipping',
  'deploy',
  'deploys',
  'deployed',
  'deploying',
  'deployment',
  'announce',
  'announces',
  'announced',
  'announcing',
  'announcement',
  'demo',
  'demos',
  'video',
  'videos',
  'deck',
  'slides',
  'pitch',
  'landing',
  'producthunt',
  'changelog',
])

/** Whether `text` is about launching, deploying or showing off the work. */
export function mentionsLaunchKeyword(text: string): boolean {
  return mentionsAnyWord(text, LAUNCH_INTENT_KEYWORDS)
}
