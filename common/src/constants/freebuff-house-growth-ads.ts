import { FEATURED_INTEGRATIONS } from '../desktop-cloud/integrations'
import { HOUSE_AD_FAVICON_URL } from './freebuff-house-ad'
import { FREEBUFF_WEB_URL_PROD } from './hosts'

import type { HouseAdCreative } from './freebuff-house-ad'

/**
 * GROWTH house campaigns: feature discovery for the house-only inventory a
 * Gravity 204 leaves (docs/freebuff-house-subscription-promo.md, "Growth
 * campaigns"). Seeded PAUSED by `scripts/seed-house-growth-campaigns.ts`.
 *
 * Each campaign may name a GATE: a fact about the account that, once true,
 * retires the campaign for that user (they deployed, they use Desktop, they
 * connected Slack). Gates are read server-side
 * (`first-party-pipeline/features/user/house-campaign-gates.ts`), so they
 * work on the CLI, which sends no `houseAdContext` hints. An unknown answer
 * withholds the campaign.
 *
 * Stable ids bind the seeded rows to this policy; copy may change without
 * creating another campaign.
 */

/** A fact that, when true for the viewer, withholds a gated campaign. */
export type HouseCampaignGate =
  | 'deployed'
  | 'desktop_user'
  | 'chatgpt_connected'
  | 'byok_connected'
  | 'profile_survey_done'
  | `integration:${string}`

/**
 * Which inline slots a campaign targets. `all` is every inline catalog slot
 * the house leg may fill; the others subtract the surface the campaign
 * advertises, so nobody is pitched the app they are already in.
 */
export type HouseGrowthTargeting =
  | 'all'
  | 'not_android'
  | 'not_desktop'
  | 'cli_only'

export type HouseGrowthCampaign = {
  id: string
  name: string
  gate: HouseCampaignGate | null
  targeting: HouseGrowthTargeting
  /** Per-campaign cap; the shared house caps still apply on top. */
  frequencyCap: { maxImpressions: number; windowMinutes: number }
  creatives: readonly HouseAdCreative[]
}

/** The Desktop download page (the landing site's Desktop product view). */
export const HOUSE_DESKTOP_DOWNLOAD_URL = `${FREEBUFF_WEB_URL_PROD}/?product=desktop`

export const HOUSE_ANDROID_PLAY_STORE_URL =
  'https://play.google.com/store/apps/details?id=com.freebuff.app'

/** One-time actions: one impression a day at most per campaign. */
const DAILY = { maxImpressions: 1, windowMinutes: 24 * 60 } as const

function creative(
  title: string,
  adText: string,
  cta: string,
  url: string,
): HouseAdCreative {
  return {
    title,
    adText,
    cta,
    url: url.startsWith('https://') ? url : `${FREEBUFF_WEB_URL_PROD}${url}`,
    favicon: HOUSE_AD_FAVICON_URL,
  }
}

/** Display names for the featured integrations, in catalog order. */
const INTEGRATION_NAMES: Record<(typeof FEATURED_INTEGRATIONS)[number], string> =
  {
    gmail: 'Gmail',
    googlecalendar: 'Google Calendar',
    googledrive: 'Google Drive',
    slack: 'Slack',
    notion: 'Notion',
    linear: 'Linear',
    posthog: 'PostHog',
    sentry: 'Sentry',
    stripe: 'Stripe',
    supabase: 'Supabase',
    hubspot: 'HubSpot',
    outlook: 'Outlook',
  }

/**
 * Value-prop copy per integration: what Freebuff does for the user once the
 * app is connected, never "give us access". Each claim is a tool the
 * integration exposes to the agent (docs/freebuff-integrations.md).
 */
const INTEGRATION_COPY: Record<
  (typeof FEATURED_INTEGRATIONS)[number],
  readonly [title: string, body: string][]
> = {
  gmail: [
    ['Let Freebuff handle your inbox', 'Connect Gmail and Freebuff can draft, send and reply to email.'],
    ['Freebuff can reply to your emails', 'Connect Gmail to triage, draft and send without leaving chat.'],
  ],
  googlecalendar: [
    ['Let Freebuff plan your day', 'Connect Google Calendar and Freebuff can schedule meetings for you.'],
    ['Freebuff can schedule your meetings', 'Connect Google Calendar to find times and book events from chat.'],
  ],
  googledrive: [
    ['Freebuff can work from your Drive docs', 'Connect Google Drive and Freebuff can find and summarize your files.'],
    ['Bring your Drive files into Freebuff', 'Connect Google Drive so Freebuff can use your docs as context.'],
  ],
  slack: [
    ['Let Freebuff catch you up on Slack', 'Connect Slack and Freebuff can summarize threads and post updates.'],
    ['Freebuff can post your updates to Slack', 'Connect Slack to share progress with your team from chat.'],
  ],
  notion: [
    ['Freebuff can write in your Notion', 'Connect Notion and Freebuff can draft and update your pages.'],
    ['Turn your Notion docs into context', 'Connect Notion so Freebuff can read your specs and notes.'],
  ],
  linear: [
    ['Freebuff can manage your Linear issues', 'Connect Linear and Freebuff can file, update and close issues.'],
    ['Go from Linear issue to code', 'Connect Linear so Freebuff can pick up an issue and start on it.'],
  ],
  posthog: [
    ['Ask Freebuff about your product data', 'Connect PostHog and Freebuff can answer analytics questions.'],
    ['Freebuff can check your PostHog metrics', 'Connect PostHog to see how a feature is doing from chat.'],
  ],
  sentry: [
    ['Let Freebuff fix your Sentry errors', 'Connect Sentry and Freebuff can pull up errors while it debugs.'],
    ['Debug faster with Sentry in Freebuff', 'Connect Sentry so Freebuff sees the stack trace, not a guess.'],
  ],
  stripe: [
    ['Freebuff can look up your Stripe data', 'Connect Stripe and Freebuff can check payments and customers.'],
    ['Ask Freebuff about your revenue', 'Connect Stripe to answer billing questions from chat.'],
  ],
  supabase: [
    ['Freebuff can work with your Supabase', 'Connect Supabase and Freebuff can query and manage your project.'],
    ['Build on Supabase with Freebuff', 'Connect Supabase so Freebuff knows your tables and data.'],
  ],
  hubspot: [
    ['Freebuff can update your HubSpot CRM', 'Connect HubSpot and Freebuff can look up and update deals.'],
    ['Ask Freebuff about your pipeline', 'Connect HubSpot to check contacts and deals from chat.'],
  ],
  outlook: [
    ['Let Freebuff handle your Outlook inbox', 'Connect Outlook and Freebuff can draft, send and reply to email.'],
    ['Freebuff can reply to your emails', 'Connect Outlook to triage, draft and send without leaving chat.'],
  ],
}

export const HOUSE_GROWTH_INTEGRATION_CAMPAIGNS: readonly HouseGrowthCampaign[] =
  FEATURED_INTEGRATIONS.map((slug) => ({
    id: `house-growth-integration-${slug}-v1`,
    name: `Connect ${INTEGRATION_NAMES[slug]} (house)`,
    gate: `integration:${slug}` as const,
    targeting: 'all' as const,
    frequencyCap: DAILY,
    creatives: INTEGRATION_COPY[slug].map(([title, body]) =>
      creative(title, body, 'Connect', '/?settings=integrations'),
    ),
  }))

/**
 * CLI tips: real slash commands only (`cli/src/data/slash-commands.ts`).
 * Each headline is the command to run; the line says what it gets you.
 */
const TIPS: readonly HouseAdCreative[] = [
  creative('Use /plan before big changes', 'Review the approach before Freebuff writes any code.', 'Learn more', '/docs'),
  creative('Use /review before you commit', 'Freebuff checks its own changes for bugs.', 'Learn more', '/docs'),
  creative('Run /interview to turn an idea into a spec', 'Freebuff asks the questions so the build matches your idea.', 'Learn more', '/docs'),
  creative('Use /history to pick up where you left off', 'Resume any past conversation with its context.', 'Learn more', '/docs'),
  creative('Use /image to show Freebuff a screenshot', 'Or paste one with Ctrl+V. Freebuff can see the bug.', 'Learn more', '/docs'),
  creative('Use /model to pick the right model', 'Switch models for the next message, mid-chat.', 'Learn more', '/docs'),
  creative('Use /todo to see what is left', 'Track Freebuff\'s checklist while it works.', 'Learn more', '/docs'),
  creative('Use /queue to line up your next asks', 'Edit or reorder messages waiting to be sent.', 'Learn more', '/docs'),
  creative('Start a line with ! to run a command', 'Run shell commands without leaving the chat.', 'Learn more', '/docs'),
  creative('Use /export to keep a record', 'Save the whole conversation as a Markdown file.', 'Learn more', '/docs'),
]

export const HOUSE_GROWTH_FEATURE_CAMPAIGNS: readonly HouseGrowthCampaign[] = [
  {
    id: 'house-growth-android-v1',
    name: 'Freebuff for Android (house)',
    // No per-account Android signal exists yet; the Android slots are
    // excluded instead, so the app is never pitched inside itself.
    gate: null,
    targeting: 'not_android',
    frequencyCap: DAILY,
    creatives: [
      creative('Keep coding from your phone', 'Freebuff for Android: your chats and Cloud projects on the go.', 'Get the app', HOUSE_ANDROID_PLAY_STORE_URL),
      creative('Check on Freebuff from anywhere', 'Follow your Cloud work and reply from the Android app.', 'Get the app', HOUSE_ANDROID_PLAY_STORE_URL),
    ],
  },
  {
    // A second Android campaign on purpose: house campaigns take turns and
    // share one cap, so a priority gets more turns by having more campaigns
    // (its own daily cap included), not by new ranking logic.
    id: 'house-growth-android-2-v1',
    name: 'Freebuff for Android, second (house)',
    gate: null,
    targeting: 'not_android',
    frequencyCap: DAILY,
    creatives: [
      creative('Control Freebuff Desktop from your phone', 'The Android app reaches your Desktop threads too.', 'Get the app', HOUSE_ANDROID_PLAY_STORE_URL),
      creative('Start a Cloud task from your phone', 'Kick off work on Android and check results later.', 'Get the app', HOUSE_ANDROID_PLAY_STORE_URL),
    ],
  },
  {
    id: 'house-growth-android-3-v1',
    name: 'Freebuff for Android, third (house)',
    gate: null,
    targeting: 'not_android',
    frequencyCap: DAILY,
    creatives: [
      creative('Your Freebuff chats, now on Android', 'Pick up any conversation from your phone.', 'Get the app', HOUSE_ANDROID_PLAY_STORE_URL),
      creative('Reply to Freebuff on the go', 'Answer its questions from Android so work keeps moving.', 'Get the app', HOUSE_ANDROID_PLAY_STORE_URL),
    ],
  },
  {
    id: 'house-growth-android-4-v1',
    name: 'Freebuff for Android, fourth (house)',
    gate: null,
    targeting: 'not_android',
    frequencyCap: DAILY,
    creatives: [
      creative('Freebuff fits in your pocket', 'Get the Android app on Google Play.', 'Get the app', HOUSE_ANDROID_PLAY_STORE_URL),
      creative('Step away while Freebuff works', 'Follow along from the Android app.', 'Get the app', HOUSE_ANDROID_PLAY_STORE_URL),
    ],
  },
  {
    id: 'house-growth-referrals-v1',
    name: 'Invite friends (house)',
    // Ungated: referrals are uncapped, so a user who already referred can
    // still earn from the next one.
    gate: null,
    targeting: 'all',
    frequencyCap: DAILY,
    creatives: [
      creative('Get more daily sessions free', 'Invite a friend. Each one who joins adds sessions.', 'Invite', '/earn/referrals'),
      creative('Know someone who codes?', 'Invite them to Freebuff and earn extra daily sessions.', 'Invite', '/earn/referrals'),
    ],
  },
  {
    id: 'house-growth-hosting-v1',
    name: 'Deploy on Freebuff hosting (house)',
    gate: 'deployed',
    targeting: 'all',
    frequencyCap: DAILY,
    creatives: [
      creative('Put your app online in one click', 'Freebuff builds and hosts it on a freebuff.app link.', 'Deploy', '/?view=sites'),
      creative('Share what you built with a live link', 'Press Deploy. Freebuff handles the build and hosting.', 'Deploy', '/?view=sites'),
    ],
  },
  {
    id: 'house-growth-chatgpt-v1',
    name: 'Sign in with ChatGPT (house)',
    gate: 'chatgpt_connected',
    targeting: 'all',
    frequencyCap: DAILY,
    creatives: [
      creative('Already pay for ChatGPT? Use it here', 'Sign in with ChatGPT and run Freebuff on your plan.', 'Sign in', '/?settings=providers'),
      creative('Get more out of your ChatGPT plan', 'Use it to power Freebuff. Sign in with ChatGPT.', 'Sign in', '/?settings=providers'),
    ],
  },
  {
    id: 'house-growth-desktop-v1',
    name: 'Freebuff Desktop (house)',
    gate: 'desktop_user',
    targeting: 'not_desktop',
    frequencyCap: DAILY,
    creatives: [
      creative('Get the Freebuff Desktop app', 'The best Freebuff experience, on Mac, Windows and Linux.', 'Download', HOUSE_DESKTOP_DOWNLOAD_URL),
      creative('See your app as Freebuff builds it', 'Desktop puts chat, code and live previews side by side.', 'Download', HOUSE_DESKTOP_DOWNLOAD_URL),
    ],
  },
  {
    // Second Desktop campaign: more turns for a priority (see Android above).
    id: 'house-growth-desktop-2-v1',
    name: 'Freebuff Desktop, second (house)',
    gate: 'desktop_user',
    targeting: 'not_desktop',
    frequencyCap: DAILY,
    creatives: [
      creative('Freebuff works best on Desktop', 'Free for Mac, Windows and Linux.', 'Download', HOUSE_DESKTOP_DOWNLOAD_URL),
      creative('Run Freebuff on your own machine', 'Desktop runs your code locally with live previews.', 'Download', HOUSE_DESKTOP_DOWNLOAD_URL),
    ],
  },
  {
    id: 'house-growth-desktop-3-v1',
    name: 'Freebuff Desktop, third (house)',
    gate: 'desktop_user',
    targeting: 'not_desktop',
    frequencyCap: DAILY,
    creatives: [
      creative('Get live previews in Freebuff Desktop', 'Watch your app update as Freebuff edits it.', 'Download', HOUSE_DESKTOP_DOWNLOAD_URL),
      creative('All your Freebuff projects in one window', 'Desktop keeps chats, code and previews together.', 'Download', HOUSE_DESKTOP_DOWNLOAD_URL),
    ],
  },
  {
    id: 'house-growth-desktop-4-v1',
    name: 'Freebuff Desktop, fourth (house)',
    gate: 'desktop_user',
    targeting: 'not_desktop',
    frequencyCap: DAILY,
    creatives: [
      creative('Upgrade your Freebuff setup', 'The Desktop app is free on Mac, Windows and Linux.', 'Download', HOUSE_DESKTOP_DOWNLOAD_URL),
      creative('Built for long Freebuff sessions', 'Desktop handles big projects and long chats.', 'Download', HOUSE_DESKTOP_DOWNLOAD_URL),
    ],
  },
  {
    id: 'house-growth-byok-v1',
    name: 'Bring your own key (house)',
    gate: 'byok_connected',
    targeting: 'all',
    frequencyCap: DAILY,
    creatives: [
      creative('Bring your own API key', 'Use your own key inside Freebuff.', 'Set up', '/?settings=providers'),
      creative('Have an API key? Use it in Freebuff', 'Add your key and pick from your provider\'s models.', 'Set up', '/?settings=providers'),
    ],
  },
  {
    id: 'house-growth-profile-survey-v1',
    name: 'Profile survey (house)',
    gate: 'profile_survey_done',
    targeting: 'all',
    frequencyCap: DAILY,
    creatives: [
      creative('Help shape what Freebuff builds next', 'Answer a few questions about how you build.', 'Start', '/account'),
    ],
  },
  {
    id: 'house-growth-cli-tips-v1',
    name: 'Freebuff CLI tips (house)',
    gate: null,
    targeting: 'cli_only',
    // Lowest priority: once a day, like every other growth campaign, so the
    // ten tips never crowd the shared house cap.
    frequencyCap: DAILY,
    creatives: TIPS,
  },
]

export const HOUSE_GROWTH_CAMPAIGNS: readonly HouseGrowthCampaign[] = [
  ...HOUSE_GROWTH_FEATURE_CAMPAIGNS,
  ...HOUSE_GROWTH_INTEGRATION_CAMPAIGNS,
]

const GATE_BY_ID: ReadonlyMap<string, HouseCampaignGate> = new Map(
  HOUSE_GROWTH_CAMPAIGNS.flatMap((campaign) =>
    campaign.gate ? [[campaign.id, campaign.gate] as const] : [],
  ),
)

/** The gate a campaign id carries, or null for an ungated or unknown id. */
export function houseCampaignGateFor(id: string): HouseCampaignGate | null {
  return GATE_BY_ID.get(id) ?? null
}

/** The integration slug an `integration:<slug>` gate names, else null. */
export function integrationSlugForGate(gate: HouseCampaignGate): string | null {
  return gate.startsWith('integration:') ? gate.slice('integration:'.length) : null
}
