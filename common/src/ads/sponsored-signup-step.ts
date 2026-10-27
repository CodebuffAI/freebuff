import {
  resolveSponsoredBfcidTemplate,
  type SponsoredProcedureRuntimeInputs,
} from '@codebuff/common/ads/sponsored-procedure-inputs'
import { declaredRunCredentials } from '@codebuff/common/ads/sponsored-run-credentials'

import type { SponsoredSkill } from '@codebuff/common/ads/sponsored-skill'

export type SponsoredSignupStep = {
  /** Null when the reviewed link cannot be resolved safely for this Accept. */
  url: string | null
  /** The account tab opened by Desktop, never supplied by the advertiser. */
  tabId?: string
}

const MAX_SIGNUP_URL_CHARS = 2048

/**
 * Manual review makes the FIRST explicitly tracked link the account entry
 * point. When the procedure has none but still needs an account (it declares
 * a credential, or its skill has a user step), the Accept's own
 * `advertiserLink` is the entry point: the reviewed campaign landing URL
 * carrying the signed click id, so the account is still attributed. Without
 * a usable one, nothing is opened, as before.
 */
export function sponsoredSignupStep(
  procedure: string,
  inputs: SponsoredProcedureRuntimeInputs,
  skill?: SponsoredSkill | null,
): SponsoredSignupStep | undefined {
  for (const match of procedure.matchAll(/https:\/\/[^\s<>"'`]+/gi)) {
    let raw = match[0].replace(/[.,;!?]+$/, '')
    for (const [open, close] of [
      ['(', ')'],
      ['[', ']'],
    ] as const) {
      while (
        raw.endsWith(close) &&
        raw.split(close).length > raw.split(open).length
      )
        raw = raw.slice(0, -1).replace(/[.,;!?]+$/, '')
    }
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      continue
    }
    const ids = url.searchParams.getAll('bfcid')
    if (!ids.some((value) => /^\{bfcid\}$/i.test(value))) continue
    if (
      ids.length !== 1 ||
      url.username ||
      url.password ||
      raw.length > MAX_SIGNUP_URL_CHARS
    )
      return { url: null }
    return { url: resolveSponsoredBfcidTemplate(raw, inputs) }
  }
  const needsAccount =
    declaredRunCredentials(procedure).length > 0 ||
    Boolean(skill?.steps?.some((step) => step.kind === 'user'))
  const landing = needsAccount ? trackedAdvertiserLink(inputs) : null
  return landing ? { url: landing } : undefined
}

/**
 * The Accept's advertiser link when it is safe to open as the account entry
 * point: absolute https, no credentials, within the size cap, and carrying
 * exactly one SIGNED click id (never the `{bfcid}` slot), so opening it is
 * attributed. Null otherwise.
 */
export function trackedAdvertiserLink(
  inputs: SponsoredProcedureRuntimeInputs,
): string | null {
  const raw = inputs.advertiserLink?.trim()
  if (!raw || raw.length > MAX_SIGNUP_URL_CHARS) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null
  const ids = url.searchParams.getAll('bfcid')
  return ids.length === 1 && ids[0] && !/[{}]/.test(ids[0]) ? url.href : null
}
