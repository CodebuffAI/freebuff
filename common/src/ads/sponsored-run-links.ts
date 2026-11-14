/**
 * The links a sponsored run's account step shows or opens, resolved ONCE
 * (COD-965).
 *
 * Every Freebuff client (Desktop, the CLI, Cloud) used to fill the signed
 * click id into the procedure's tracked sign-up link and each declared key
 * page itself, call site by call site. One missed site (the CLI key form)
 * opened a key page with a literal `{bfcid}`, so that sign-up was never
 * attributed. Now:
 *
 * - {@link resolveSponsoredRunLinks} is the one resolver. Its output never
 *   carries an unfilled click id: a link that cannot be resolved is null
 *   (sign-up) or dropped (key page).
 * - The funded Accept's 200 carries its answer as `resolvedLinks`, an
 *   additive optional field old clients ignore. {@link sponsoredRunLinks}
 *   prefers it when it is well formed and matches the consented procedure,
 *   and otherwise resolves locally, so client and server rollout order does
 *   not matter.
 * - {@link guardSponsoredLink} runs at every open or display point anyway:
 *   a link with an unfilled click id is never opened.
 *
 * Pure and dependency-free beyond the shared ad helpers, so every surface can
 * call it. Nothing here logs: the guard's caller emits
 * {@link UNFILLED_CLICK_ID_BLOCKED_METRIC} with its surface, never the URL.
 */
import { signupUrlWithEmail } from './sponsored-instant-setup'
import {
  advertiserClickIdFromLink,
  resolveSponsoredBfcidTemplate,
  type SponsoredProcedureRuntimeInputs,
} from './sponsored-procedure-inputs'
import {
  declaredRunCredentials,
  sponsoredCredentialGetUrl,
  type SponsoredRunCredential,
} from './sponsored-run-credentials'
import {
  sponsoredSignupStep,
  trackedAdvertiserLink,
  type SponsoredSignupStep,
} from './sponsored-signup-step'

import type { SponsoredSkill } from './sponsored-skill'

/**
 * Where the sign-up link came from:
 * - `procedure`: the procedure's own tracked link, click id filled in;
 * - `landing`: the Accept's signed advertiser link (the procedure has no
 *   tracked link but needs an account);
 * - `unresolved`: the procedure has a tracked link this Accept cannot fill
 *   (no signed click id), so there is a sign-up step and nothing to open;
 * - null: no sign-up step.
 */
export type SponsoredRunSignupSource = 'procedure' | 'landing' | 'unresolved'

export type SponsoredRunLinks = {
  /**
   * The sign-up link with its click id filled in, or null. An `{email}` slot
   * is KEPT: a surface that asks the user may fill it, every other removes it
   * (`signupUrlWithEmail`) before opening.
   */
  signupUrl: string | null
  signupSource: SponsoredRunSignupSource | null
  /**
   * The procedure's declared credentials, in order, each key page resolved:
   * click id filled in and any `{email}` slot removed (nobody agreed to share
   * the email on the key form, COD-830). A key page that cannot be attributed
   * is dropped, never shown with a placeholder.
   */
  credentials: SponsoredRunCredential[]
}

/** The warning a surface logs when the guard refuses a link. */
export const UNFILLED_CLICK_ID_BLOCKED_METRIC = 'ads.unfilled_click_id_blocked'

/**
 * `{bfcid}`, its URL-encoded `%7Bbfcid%7D` and double-encoded `%257Bbfcid%257D`
 * spellings, in any letter case.
 */
const UNFILLED_CLICK_ID = /\{bfcid\}|%7Bbfcid%7D|%257Bbfcid%257D/i

/** Whether `url` still carries an unfilled click id slot. */
export function isUnfilledClickIdUrl(url: string | null | undefined): boolean {
  return typeof url === 'string' && UNFILLED_CLICK_ID.test(url)
}

const MAX_LINK_CHARS = 2048

/** An https link with no userinfo and no unfilled click id, else null. */
function safeLink(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_LINK_CHARS) return null
  const checked = sponsoredCredentialGetUrl(value)
  return checked && !isUnfilledClickIdUrl(checked) ? checked : null
}

/**
 * The one resolver. Behaviour matches what each client did at its own call
 * sites (`sponsoredSignupStep` for the sign-up link, Desktop's
 * `requiredCredentials` for key pages), plus a final check that nothing it
 * returns still carries an unfilled click id.
 */
export function resolveSponsoredRunLinks(
  procedure: string,
  runtimeInputs: SponsoredProcedureRuntimeInputs,
  skill?: SponsoredSkill | null,
): SponsoredRunLinks {
  const step = sponsoredSignupStep(procedure, runtimeInputs, skill)
  let signupUrl: string | null = null
  let signupSource: SponsoredRunSignupSource | null = null
  if (step) {
    signupUrl = step.url && !isUnfilledClickIdUrl(step.url) ? step.url : null
    // With no click id to fill, only the procedure's own tracked link still
    // makes a step ({ url: null }): the landing fallback needs the link.
    const ownLink =
      sponsoredSignupStep(procedure, { advertiserLink: null }) !== undefined
    signupSource = !signupUrl ? 'unresolved' : ownLink ? 'procedure' : 'landing'
  }
  const credentials = resolveSponsoredCredentialLinks(
    declaredRunCredentials(procedure),
    runtimeInputs,
  )
  return { signupUrl, signupSource, credentials }
}

/**
 * Each key page with its `{bfcid}` slot filled from this run's signed click
 * id (Desktop's `requiredCredentials`, COD-665). The key form may be the
 * first advertiser visit, so a link that cannot be attributed is dropped
 * rather than shown with a placeholder, and an `{email}` slot is removed:
 * nobody agreed to share the email on this form (COD-830).
 */
export function resolveSponsoredCredentialLinks(
  credentials: readonly SponsoredRunCredential[],
  runtimeInputs: SponsoredProcedureRuntimeInputs,
): SponsoredRunCredential[] {
  return credentials.map(({ getUrl, ...credential }) => {
    const bfcidResolved = getUrl
      ? resolveSponsoredBfcidTemplate(getUrl, runtimeInputs)
      : null
    const resolved = bfcidResolved
      ? signupUrlWithEmail(bfcidResolved, null)
      : null
    return {
      ...credential,
      ...(resolved && !isUnfilledClickIdUrl(resolved)
        ? { getUrl: resolved }
        : {}),
    }
  })
}

/**
 * The server's `resolvedLinks` when it is well formed AND matches what the
 * consented procedure declares: the same credentials (names and labels, in
 * order), each key page and the sign-up link an https URL with no unfilled
 * click id. Null for anything else, and the client resolves locally.
 */
export function parseSponsoredRunLinks(
  value: unknown,
  procedure: string,
): SponsoredRunLinks | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const source = raw.signupSource
  if (
    source !== null &&
    source !== 'procedure' &&
    source !== 'landing' &&
    source !== 'unresolved'
  )
    return null
  let signupUrl: string | null = null
  if (source === 'procedure' || source === 'landing') {
    signupUrl = safeLink(raw.signupUrl)
    if (!signupUrl) return null
  } else if (raw.signupUrl !== null) return null
  if (!Array.isArray(raw.credentials)) return null
  const declared = declaredRunCredentials(procedure)
  if (raw.credentials.length !== declared.length) return null
  const credentials: SponsoredRunCredential[] = []
  for (const [index, expected] of declared.entries()) {
    const entry = raw.credentials[index] as Record<string, unknown> | null
    if (!entry || typeof entry !== 'object') return null
    if (entry.env !== expected.env || entry.label !== expected.label)
      return null
    if (entry.getUrl === undefined) {
      credentials.push({ env: expected.env, label: expected.label })
      continue
    }
    const getUrl = safeLink(entry.getUrl)
    if (!getUrl) return null
    credentials.push({ env: expected.env, label: expected.label, getUrl })
  }
  return { signupUrl, signupSource: source, credentials }
}

/**
 * What a client uses: the server's resolved links when present and valid,
 * else the shared resolver over the same inputs.
 */
export function sponsoredRunLinks(input: {
  procedure: string
  runtimeInputs: SponsoredProcedureRuntimeInputs
  skill?: SponsoredSkill | null
  /** The Accept's `resolvedLinks`, raw and untrusted. */
  serverLinks?: unknown
}): SponsoredRunLinks & { from: 'server' | 'local' } {
  const local = resolveSponsoredRunLinks(
    input.procedure,
    input.runtimeInputs,
    input.skill,
  )
  const server =
    input.serverLinks === undefined || input.serverLinks === null
      ? null
      : parseSponsoredRunLinks(input.serverLinks, input.procedure)
  // A server link is used only where it points at the page the procedure
  // itself names (same origin and path, and the same source), so a server bug
  // can never open a page the user did not consent to, e.g. another
  // campaign's key page. With no signed click id of its own, the client
  // checks against the procedure's templates through a probe id; a landing
  // answer then cannot be checked and is not used.
  const expected = advertiserClickIdFromLink(input.runtimeInputs.advertiserLink)
    ? local
    : resolveSponsoredRunLinks(
        input.procedure,
        { advertiserLink: TARGET_PROBE_LINK },
        input.skill,
      )
  if (server && sameLinkTargets(server, expected))
    return { ...server, from: 'server' }
  return { ...local, from: 'local' }
}

/** A stand-in signed link, only ever used to read the procedure's link targets. */
const TARGET_PROBE_LINK = 'https://target-probe.invalid/?bfcid=bfc_1.probe.probe'

/** Origin + path of a URL, or null when it does not parse. */
function linkTarget(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return null
  }
}

function sameLinkTargets(
  server: SponsoredRunLinks,
  local: SponsoredRunLinks,
): boolean {
  if (
    server.signupSource === 'landing' &&
    linkTarget(local.signupUrl)?.startsWith('https://target-probe.invalid')
  )
    return false
  if (server.signupSource !== local.signupSource) return false
  if (linkTarget(server.signupUrl) !== linkTarget(local.signupUrl)) return false
  if (server.credentials.length !== local.credentials.length) return false
  return server.credentials.every((credential, index) => {
    const mine = local.credentials[index]!
    return (
      credential.env === mine.env &&
      linkTarget(credential.getUrl) === linkTarget(mine.getUrl)
    )
  })
}

/** The account step's sign-up shape (`sponsoredSignupStep`) from resolved links. */
export function sponsoredRunLinksSignupStep(
  links: Pick<SponsoredRunLinks, 'signupUrl' | 'signupSource'>,
): SponsoredSignupStep | undefined {
  return links.signupSource ? { url: links.signupUrl } : undefined
}

/**
 * The guard every open or display point runs. A link with no unfilled click
 * id is returned as it is. One with an unfilled click id is never opened:
 * the Accept's advertiser link takes its place when that carries a signed
 * click id, otherwise nothing is shown (null). `onBlocked` is told either
 * way, for the {@link UNFILLED_CLICK_ID_BLOCKED_METRIC} warning; it is given
 * no URL.
 */
export function guardSponsoredLink(
  url: string | null | undefined,
  options: {
    advertiserLink?: string | null
    onBlocked?: (fallback: 'advertiser_link' | 'none') => void
  } = {},
): string | null {
  if (!url) return null
  if (!isUnfilledClickIdUrl(url)) return url
  const landing =
    advertiserClickIdFromLink(options.advertiserLink) !== null
      ? trackedAdvertiserLink({ advertiserLink: options.advertiserLink })
      : null
  const fallback = landing && !isUnfilledClickIdUrl(landing) ? landing : null
  try {
    options.onBlocked?.(fallback ? 'advertiser_link' : 'none')
  } catch {
    // A logging failure never opens the link.
  }
  return fallback
}

/** The credentials with every key page passed through {@link guardSponsoredLink}. */
export function guardSponsoredCredentials(
  credentials: readonly SponsoredRunCredential[],
  options: Parameters<typeof guardSponsoredLink>[1] = {},
): SponsoredRunCredential[] {
  return credentials.map(({ getUrl, ...credential }) => {
    const guarded = getUrl ? guardSponsoredLink(getUrl, options) : null
    return { ...credential, ...(guarded ? { getUrl: guarded } : {}) }
  })
}
