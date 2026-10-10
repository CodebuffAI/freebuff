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

/**
 * THE COMPOSER INTENT PLACEMENTS, which replace the keyword triggers above
 * with a model's judgement. A client asks for ONE of these ids from the
 * composer, sending the draft as the newest user message. The ads route
 * knows the id: it expands it into that client's composer partner slots, and
 * Perpetual Flash decides which of their ads, if any, the draft is about
 * (`INTENT_PIPELINE` in `packages/internal`). The winner is served, recorded
 * and billed on its own partner slot, exactly as a keyword-triggered request
 * for that slot was; nothing is ever delivered on these ids.
 *
 * The ad policy announces them in `partnerPlacementIds` while the partner
 * slots are live, so a client asks only a server that knows them.
 */
export const COMPOSER_INTENT_PLACEMENTS: Readonly<
  Record<string, readonly string[]>
> = {
  'Desktop-Intent': [
    'Desktop-Partner-Composer-PR',
    'Desktop-Partner-Composer-Launch',
  ],
  'CLI-Intent': ['CLI-Partner-Composer-PR', 'CLI-Partner-Composer-Launch'],
}
export const DESKTOP_COMPOSER_INTENT_PLACEMENT_ID = 'Desktop-Intent'
export const CLI_COMPOSER_INTENT_PLACEMENT_ID = 'CLI-Intent'
export const COMPOSER_INTENT_PLACEMENT_IDS: readonly string[] = Object.keys(
  COMPOSER_INTENT_PLACEMENTS,
)

/**
 * The partner slots a request is decided over when it names ONE composer
 * intent placement, or null for any other request.
 */
export function composerIntentPartnerSlots(
  placementIds: readonly string[],
): readonly string[] | null {
  if (placementIds.length !== 1) return null
  return COMPOSER_INTENT_PLACEMENTS[placementIds[0]!] ?? null
}

/**
 * What each composer partner slot is FOR, in the words Flash is asked about:
 * the moment the slot's ad belongs beside, stated as what the user is doing.
 * The model-judged counterpart of {@link PR_INTENT_KEYWORDS} and
 * {@link LAUNCH_INTENT_KEYWORDS}.
 */
export const PARTNER_SLOT_INTENTS: Readonly<Record<string, string>> = {
  'Desktop-Partner-Composer-PR':
    'working on a pull request: opening, reviewing, fixing review comments on or merging one, or asking for a code review',
  'CLI-Partner-Composer-PR':
    'working on a pull request: opening, reviewing, fixing review comments on or merging one, or asking for a code review',
  'Desktop-Partner-Composer-Launch':
    'launching or shipping what they built: deploying it, announcing it, or making a demo, video, deck, landing page or launch post for it',
  'CLI-Partner-Composer-Launch':
    'launching or shipping what they built: deploying it, announcing it, or making a demo, video, deck, landing page or launch post for it',
}
