/**
 * MOCK sponsors for the display-ad placements: the single source of truth for
 * each sponsor's name, link, logo, copy and COLOURS, on every surface.
 *
 * Colour lives here and nowhere else: `colors: { fill, ink? }`. Placements
 * never write a hex; they read `sponsorFor(placement).theme` (see
 * `sponsor-theme.ts`), and Desktop/Cloud turn that into `--ad-fill` /
 * `--ad-ink` on the unit's wrapper. Omit `ink` to derive a 4.5:1 one.
 *
 * Which sponsor fills which placement is `DISPLAY_AD_LINEUP`, below.
 *
 * Nothing here is served: no campaign, auction or impression stands behind
 * these. Copy and MCP endpoints are illustrative and must be re-checked with
 * the advertiser before any of this is wired to real serving. Logos are the
 * brands' Simple Icons marks (CC0), the same ones as
 * `freebuff/web/public/logos/services/*.svg`, kept inline as path data so Desktop
 * and Cloud draw them in the sponsor's ink with no asset pipeline. The CLI
 * draws `lettermark`.
 */
import { resolveSponsorTheme } from './sponsor-theme'

export type { DisplayAdSlot } from './placements'

import type { DisplayAdSlot } from './placements'
import type { SponsorColors, SponsorTheme } from './sponsor-theme'

export type SponsorId = 'neon' | 'sentry' | 'deepgram' | 'clerk' | 'upstash'

/** A single-path mark drawn with `fill="currentColor"` (the sponsor's ink). */
export interface SponsorLogo {
  viewBox: string
  path: string
}

export interface SponsorCopy {
  /** Bold line. */
  headline: string
  /** One supporting sentence. */
  body: string
  /** CTA label. Placements that show the domain as the CTA ignore it. */
  cta: string
  /** Short one-liner for single-row units (statusline, one-line splash). */
  tagline: string
}

/** What the MCP featured card adds when the user clicks "Add server". */
export interface SponsorMcpServer {
  /** The entry's name in the user's MCP config. */
  configKey: string
  description: string
  connection:
    | { transport: 'http'; url: string }
    | { transport: 'stdio'; command: string; args: string[] }
}

export interface DisplayAdSponsor {
  id: SponsorId
  name: string
  /** Shown as the link text, e.g. on a "neon.com ↗" CTA chip. */
  domain: string
  /** Where the unit links. Opened with `rel="noreferrer noopener sponsored"`. */
  url: string
  colors: SponsorColors
  logo?: SponsorLogo
  /** Fallback mark where a logo cannot draw (the CLI, a failed SVG). */
  lettermark: string
  copy: SponsorCopy
  /** Per-placement copy overrides, merged over `copy` by `sponsorFor`. */
  placementCopy?: Partial<Record<DisplayAdSlot, Partial<SponsorCopy>>>
  mcp?: SponsorMcpServer
}

const VIEWBOX = '0 0 24 24'

export const DISPLAY_AD_SPONSORS: Readonly<Record<SponsorId, DisplayAdSponsor>> = {
  neon: {
    id: 'neon',
    name: 'Neon',
    domain: 'neon.com',
    url: 'https://neon.com',
    colors: { fill: '#34d59a', ink: '#0a0a0a' },
    logo: {
      viewBox: VIEWBOX,
      path: 'M24 0V24l-9.365-8.045V24H0V0ZM2.942 21.087h8.751V9.563l9.365 8.204V2.919L2.942 2.914Z',
    },
    lettermark: 'N',
    copy: {
      headline: 'Serverless Postgres that branches like git',
      body: 'Give every preview its own database branch, created in about a second.',
      cta: 'Try Neon',
      tagline: 'Postgres that branches like git',
    },
    mcp: {
      configKey: 'neon',
      description: 'Create projects, branch databases and run SQL from chat.',
      connection: { transport: 'http', url: 'https://mcp.neon.tech/mcp' },
    },
  },
  sentry: {
    id: 'sentry',
    name: 'Sentry',
    domain: 'sentry.io',
    url: 'https://sentry.io',
    colors: { fill: '#6c5fc7', ink: '#ffffff' },
    logo: {
      viewBox: VIEWBOX,
      path: 'M13.91 2.505c-.873-1.448-2.972-1.448-3.844 0L6.904 7.92a15.478 15.478 0 0 1 8.53 12.811h-2.221A13.301 13.301 0 0 0 5.784 9.814l-2.926 5.06a7.65 7.65 0 0 1 4.435 5.848H2.194a.365.365 0 0 1-.298-.534l1.413-2.402a5.16 5.16 0 0 0-1.614-.913L.296 19.275a2.182 2.182 0 0 0 .812 2.999 2.24 2.24 0 0 0 1.086.288h6.983a9.322 9.322 0 0 0-3.845-8.318l1.11-1.922a11.47 11.47 0 0 1 4.95 10.24h5.915a17.242 17.242 0 0 0-7.885-15.28l2.244-3.845a.37.37 0 0 1 .504-.13c.255.14 9.75 16.708 9.928 16.9a.365.365 0 0 1-.327.543h-2.287c.029.612.029 1.223 0 1.831h2.297a2.206 2.206 0 0 0 1.922-3.31z',
    },
    lettermark: 'S',
    copy: {
      headline: 'See the stack trace before your users report it',
      body: 'Errors, traces and replays for the app you are building, in one place.',
      cta: 'Start free',
      tagline: 'Catch errors before your users do',
    },
    mcp: {
      configKey: 'sentry',
      description: 'Look up issues, stack traces and releases without leaving the chat.',
      connection: { transport: 'http', url: 'https://mcp.sentry.dev/mcp' },
    },
  },
  deepgram: {
    id: 'deepgram',
    name: 'Deepgram',
    domain: 'deepgram.com',
    url: 'https://deepgram.com',
    colors: { fill: '#13ef93', ink: '#0a0a0a' },
    logo: {
      viewBox: VIEWBOX,
      path: 'M11.203 24H1.517a.364.364 0 0 1-.258-.62l6.239-6.275a.366.366 0 0 1 .259-.108h3.52c2.723 0 5.025-2.127 5.107-4.845a5.004 5.004 0 0 0-4.999-5.148H7.613v4.646c0 .2-.164.364-.365.364H.968a.365.365 0 0 1-.363-.364V.364C.605.164.768 0 .969 0h10.416c6.684 0 12.111 5.485 12.01 12.187C23.293 18.77 17.794 24 11.202 24z',
    },
    lettermark: 'D',
    copy: {
      headline: 'Add real-time voice to your app',
      body: 'Speech-to-text and text-to-speech APIs with streaming built in.',
      cta: 'Get an API key',
      tagline: 'Voice AI APIs for builders',
    },
  },
  clerk: {
    id: 'clerk',
    name: 'Clerk',
    domain: 'clerk.com',
    url: 'https://clerk.com',
    colors: { fill: '#6c47ff', ink: '#ffffff' },
    logo: {
      viewBox: VIEWBOX,
      path: 'm21.47 20.829-2.881-2.881a.572.572 0 0 0-.7-.084 6.854 6.854 0 0 1-7.081 0 .576.576 0 0 0-.7.084l-2.881 2.881a.576.576 0 0 0-.103.69.57.57 0 0 0 .166.186 12 12 0 0 0 14.113 0 .58.58 0 0 0 .239-.423.576.576 0 0 0-.172-.453Zm.002-17.668-2.88 2.88a.569.569 0 0 1-.701.084A6.857 6.857 0 0 0 8.724 8.08a6.862 6.862 0 0 0-1.222 3.692 6.86 6.86 0 0 0 .978 3.764.573.573 0 0 1-.083.699l-2.881 2.88a.567.567 0 0 1-.864-.063A11.993 11.993 0 0 1 6.771 2.7a11.99 11.99 0 0 1 14.637-.405.566.566 0 0 1 .232.418.57.57 0 0 1-.168.448Zm-7.118 12.261a3.427 3.427 0 1 0 0-6.854 3.427 3.427 0 0 0 0 6.854Z',
    },
    lettermark: 'C',
    copy: {
      headline: 'Add sign-in to your app in minutes',
      body: 'Drop-in auth, user profiles and organizations for React and Next.js.',
      cta: 'Start building',
      tagline: 'Auth and user management, done',
    },
  },
  upstash: {
    id: 'upstash',
    name: 'Upstash',
    domain: 'upstash.com',
    url: 'https://upstash.com',
    colors: { fill: '#00e9a3', ink: '#0a0a0a' },
    logo: {
      viewBox: VIEWBOX,
      path: 'M13.8027 0C11.193 0 8.583.9952 6.5918 2.9863c-3.9823 3.9823-3.9823 10.4396 0 14.4219 1.9911 1.9911 5.2198 1.9911 7.211 0 1.991-1.9911 1.991-5.2198 0-7.211L12 12c.9956.9956.9956 2.6098 0 3.6055-.9956.9955-2.6099.9955-3.6055 0-2.9866-2.9868-2.9866-7.8297 0-10.8164 2.9868-2.9868 7.8297-2.9868 10.8164 0l1.8028-1.8028C19.0225.9952 16.4125 0 13.8027 0zM12 12c-.9956-.9956-.9956-2.6098 0-3.6055.9956-.9955 2.6098-.9955 3.6055 0 2.9867 2.9868 2.9867 7.8297 0 10.8164-2.9867 2.9868-7.8297 2.9868-10.8164 0l-1.8028 1.8028c3.9823 3.9822 10.4396 3.9822 14.4219 0 3.9823-3.9824 3.9823-10.4396 0-14.4219-.9956-.9956-2.3006-1.4922-3.6055-1.4922-1.3048 0-2.6099.4966-3.6054 1.4922-1.9912 1.9912-1.9912 5.2198 0 7.211z',
    },
    lettermark: 'U',
    copy: {
      headline: 'Serverless Redis with a free tier',
      body: 'Rate limits, caches and queues that scale to zero between requests.',
      cta: 'Open',
      tagline: 'Serverless Redis, pay per request',
    },
    mcp: {
      configKey: 'upstash',
      description: 'Manage Redis databases and inspect keys from chat.',
      connection: {
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@upstash/mcp-server@latest'],
      },
    },
  },
}

/**
 * WHICH SPONSOR FILLS WHICH PLACEMENT. Edit here to recast the mock lineup.
 * Single-unit placements use the first entry; `mcpFeatured` shows up to three
 * (one row), `deals` lists every entry.
 */
export const DISPLAY_AD_LINEUP: Readonly<
  Record<DisplayAdSlot, readonly SponsorId[]>
> = {
  cliSplash: ['neon'],
  homeTakeover: ['deepgram'],
  topBanner: ['sentry'],
  mcpFeatured: ['neon', 'sentry', 'upstash'],
  cliStatusline: ['upstash'],
  deals: ['upstash', 'neon', 'clerk'],
}

/** A sponsor as one slot draws it: copy merged for the slot, colours resolved. */
export interface PlacedSponsor extends Omit<DisplayAdSponsor, 'placementCopy'> {
  theme: SponsorTheme
}

export function placeSponsor(id: SponsorId, slot: DisplayAdSlot): PlacedSponsor {
  const { placementCopy, ...sponsor } = DISPLAY_AD_SPONSORS[id]
  return {
    ...sponsor,
    copy: { ...sponsor.copy, ...placementCopy?.[slot] },
    theme: resolveSponsorTheme(sponsor.colors),
  }
}

/** Every sponsor a slot shows, in lineup order. */
export function sponsorsFor(slot: DisplayAdSlot): PlacedSponsor[] {
  return DISPLAY_AD_LINEUP[slot].map((id) => placeSponsor(id, slot))
}

/** The sponsor a single-unit slot shows, or null when its lineup is empty. */
export function sponsorFor(slot: DisplayAdSlot): PlacedSponsor | null {
  const id = DISPLAY_AD_LINEUP[slot][0]
  return id ? placeSponsor(id, slot) : null
}
