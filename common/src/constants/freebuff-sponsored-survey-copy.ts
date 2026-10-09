/**
 * Sponsored surveys (COD-834): the user-facing consent and disclosure copy,
 * shared by every surface that renders the survey card or the account page.
 *
 * Keep it TRUE to what the advertiser receives
 * (`packages/internal/src/sponsored-survey/results.ts`): aggregates hiding
 * any group under 30 people, and a per-response export keyed by a random
 * respondent id with the answers, the completion date, the country pricing
 * tier, free/paid plan, and coarse bands of three profile answers (monthly
 * tool spend, team size, who pays), the bands shown only where at least 30
 * respondents share them. Never a name, email, account id or exact country.
 * If the export gains a column, this copy changes in the same PR.
 *
 * No imports: this file ships in the public export.
 */

/** `{sponsor}` is the campaign's `sponsor_name`. */
export const SPONSORED_SURVEY_CARD_LABEL = 'Survey from {sponsor}'

/** The one-line footer under every sponsored survey card. */
export const SPONSORED_SURVEY_CARD_FOOTER =
  'Sponsored surveys are from advertisers. They see only anonymous responses, never your name or account.'

/** Expanded "How this works" text behind the footer's info link. */
export const SPONSORED_SURVEY_CARD_DISCLOSURE = [
  '{sponsor} pays Freebuff for each completed response.',
  'They get your answers and the date you answered, under a random ID that is different for every survey, plus your country group, whether you are on a free or paid plan, and broad ranges of your profile answers (dev tool spend, team size, who pays) when at least 30 people share them.',
  'They never get your name, email, account or exact country, and cannot contact you.',
  'Answering is optional. Skipping never affects your account.',
] as const

/** Account page, privacy section heading and body. */
export const SPONSORED_SURVEY_ACCOUNT_PRIVACY_TITLE = 'Sponsored surveys'

export const SPONSORED_SURVEY_ACCOUNT_PRIVACY_TEXT =
  'Some surveys are sponsored by advertisers, who receive anonymous responses only: your answers under a random ID, never your name, email or account. Results they see hide any group smaller than 30 people.'

/** Shown next to the account page "Clear" action. */
export const SPONSORED_SURVEY_CLEAR_EXPLAINER =
  'Clear also removes your answers to sponsored surveys that were not yet delivered, and disconnects the rest from your account. Responses an advertiser already received stay with them, anonymously.'

/** Fill `{sponsor}` in any of the strings above. */
export function sponsoredSurveyCopy(template: string, sponsor: string): string {
  return template.split('{sponsor}').join(sponsor)
}
