/**
 * The account step of a CLI sponsored run: the sign-in and the API key a
 * skill's user step needs (COD-665, COD-827 on Desktop).
 *
 * THE SAME SHAPE AS DESKTOP'S (`SponsoredSignupHandoff` in
 * `freebuff-desktop/src/server/services/sponsored-signup.ts`), and the words
 * the model reads are the shared ones the Lab already mirrors
 * (`agentic-ad-lab-run.ts`, held to Desktop's text by
 * `lab-sponsored-parity.test.ts`):
 * - The turn is queued at once. The agent does every step that needs no
 *   account, then calls `request_sponsored_signup` (no arguments: the link,
 *   the question and the form are the host's, never the model's).
 * - With a tracked signup link: the CLI opens it in the user's browser, prints
 *   it, and asks whether they signed in. A Yes satisfies a skill's
 *   `user_confirmed` check. Then any declared credentials are asked for.
 * - Without one (a credential-only campaign): the masked key form IS the
 *   question, and Skip is the decline.
 * - A decline, a skip or the deadline is final for the run.
 *
 * A key is held in memory for THIS run only ({@link SponsoredHeldCredentials}),
 * injected only as its declared variable into the run's terminal commands,
 * redacted from everything the model reads, and saved for the user to the
 * project's git-ignored env file (`sponsored-env-file.ts`), which the run
 * itself can never read.
 *
 * Not ported: Desktop's Instant setup and its `{email}` prefill question. The
 * `{email}` slot is removed from the link, so the email never reaches the
 * advertiser.
 */
import {
  LAB_SIGNUP_DECLINED_NOTE,
  LAB_SIGNUP_NO_STEP_NOTE,
  LAB_SIGNUP_STOPPED_NOTE,
  labConnectedNote,
  labCredentialSection,
  labSignInConfirmedNote,
} from '@codebuff/common/ads/agentic-ad-lab-run'
import { signupUrlWithEmail } from '@codebuff/common/ads/sponsored-instant-setup'
import { resolveSponsoredBfcidTemplate } from '@codebuff/common/ads/sponsored-procedure-inputs'
import {
  redactSponsoredCredentialDeep,
  redactSponsoredCredentialText,
  sponsoredCredentialValueProblem,
} from '@codebuff/common/ads/sponsored-run-credentials'
import { inspect } from 'node:util'

import type {
  SponsoredRedactableSecret,
  SponsoredRunCredential,
} from '@codebuff/common/ads/sponsored-run-credentials'
import type { SponsoredProcedureRuntimeInputs } from '@codebuff/common/ads/sponsored-procedure-inputs'
import type { SponsoredSignupStep } from '@codebuff/common/ads/sponsored-signup-step'

export const SPONSORED_SIGNUP_TOOL_NAME = 'request_sponsored_signup'

/**
 * How long before the run's local cutoff the account step gives up, as
 * Desktop's `SPONSORED_CONNECT_GRANT_MARGIN_MS`: the question has no timer of
 * its own, so it waits while the grant can still fund the rest of the run.
 */
export const SPONSORED_ACCOUNT_STEP_MARGIN_MS = 5 * 60_000

/** MIRRORED: Desktop's answers to the sign-in question. */
export const SPONSORED_SIGNUP_YES = 'Yes, I’m signed in'
export const SPONSORED_SIGNUP_NO = 'No, I don’t want to sign up'

/** What the chat shows while the run waits on the user. Never a value. */
export type SponsoredAccountAsk =
  | {
      kind: 'signin'
      offerName: string
      url: string
      /** False when no browser could be opened here: the link is the way in. */
      opened: boolean
    }
  | {
      kind: 'credentials'
      offerName: string
      credentials: readonly SponsoredRunCredential[]
      /** Why the last submission was refused, to show under the field. */
      error: string | null
    }

export type SponsoredAccountAnswer =
  | { kind: 'signin'; confirmed: boolean }
  | { kind: 'credentials'; values: Readonly<Record<string, string>> }
  | { kind: 'skip' }

export type SponsoredAccountResult = {
  status: 'confirmed' | 'declined' | 'unavailable'
  note: string
}

/**
 * A run's connected credentials. A class with a PRIVATE field, as Desktop's
 * `SponsoredRunCredentialSet`: spread, `Object.entries`, `JSON.stringify` and
 * `util.inspect` see nothing, so a stray log line cannot carry a value.
 */
export class SponsoredHeldCredentials {
  #secrets: SponsoredRedactableSecret[] = []

  hold(secrets: readonly SponsoredRedactableSecret[]): void {
    this.#secrets = secrets.map((secret) => ({ ...secret }))
  }

  forget(): void {
    this.#secrets = []
  }

  /** The declared names held. Names are not secret. */
  get names(): string[] {
    return this.#secrets.map((secret) => secret.name)
  }

  get size(): number {
    return this.#secrets.length
  }

  /** What the sandbox broker injects, after its scrub. A fresh object. */
  env(): Record<string, string> | undefined {
    if (this.#secrets.length === 0) return undefined
    const env: Record<string, string> = {}
    for (const secret of this.#secrets) env[secret.name] = secret.value
    return env
  }

  redact(text: string): string {
    return this.#secrets.length === 0
      ? text
      : redactSponsoredCredentialText(text, this.#secrets)
  }

  redactDeep<T>(value: T): T {
    return this.#secrets.length === 0
      ? value
      : redactSponsoredCredentialDeep(value, this.#secrets)
  }

  toJSON(): string {
    return '[redacted]'
  }

  toString(): string {
    return '[redacted]'
  }

  [inspect.custom](): string {
    return `SponsoredHeldCredentials(${this.names.join(', ') || 'empty'}) [redacted]`
  }
}

/**
 * MIRRORED from Desktop's `requiredCredentials` (COD-965): each declared key
 * page with its `{bfcid}` slot filled from this run's signed click id. The
 * key form may be the first advertiser visit, so a link that cannot be
 * attributed (no signed id) is dropped rather than shown with a literal
 * placeholder, and an `{email}` slot is removed: nobody agreed to share the
 * email on this form (COD-830).
 */
export function trackedSponsoredCredentials(
  credentials: readonly SponsoredRunCredential[],
  inputs: SponsoredProcedureRuntimeInputs,
): SponsoredRunCredential[] {
  return credentials.map(({ getUrl, ...credential }) => {
    const bfcidResolved = getUrl
      ? resolveSponsoredBfcidTemplate(getUrl, inputs)
      : null
    const resolved = bfcidResolved
      ? signupUrlWithEmail(bfcidResolved, null)
      : null
    return { ...credential, ...(resolved ? { getUrl: resolved } : {}) }
  })
}

/** User copy for a refused key. Never names a value. */
export function sponsoredCredentialRefusalCopy(
  credential: SponsoredRunCredential,
  problem: string,
): string {
  if (problem === 'empty') return `Enter your ${credential.label}, or skip.`
  if (problem === 'too_short')
    return `That ${credential.label} looks too short. Paste the whole key.`
  if (problem === 'too_long')
    return `That ${credential.label} is too long. Paste the key on its own.`
  return `That ${credential.label} has spaces or line breaks in it. Paste the key on its own.`
}

/**
 * MIRRORED from Desktop's `sponsoredCredentialSection` `savedTo` lines: where
 * the key went for the app to read after the run.
 */
export function sponsoredCredentialSavedLine(
  count: number,
  savedTo: string | undefined,
): string {
  return savedTo
    ? `- Freebuff already saved ${count === 1 ? 'it' : 'them'} to \`${savedTo}\` in this project for the user, under the same name${count === 1 ? '' : 's'}, so the app can read ${count === 1 ? 'it' : 'them'} after this run. Do not write an env file yourself: this run cannot read or write one. Tell the user it is in \`${savedTo}\`.`
    : '- Freebuff did NOT save the value to an env file in this project, and this run cannot write one. In your final message, tell the user to add it to their local env file themselves, naming the variable.'
}

export type SponsoredAccountStepDeps = {
  offerName: string
  /** The tracked signup link (`sponsoredSignupStep`), or none. */
  signup: SponsoredSignupStep | undefined
  /** What the procedure declares (`declaredRunCredentials`). */
  credentials: readonly SponsoredRunCredential[]
  held: SponsoredHeldCredentials
  /** Opens a link in the user's browser; false when none could be opened. */
  openUrl: (url: string) => Promise<boolean>
  /** Shows (or, with null, clears) what the chat asks the user. */
  show: (ask: SponsoredAccountAsk | null) => void
  /** Saves accepted keys to the project's env file; the file name, if saved. */
  save: (
    values: Readonly<Record<string, string>>,
  ) => Promise<string | undefined>
  /** When the step stops waiting and continues without the user. */
  deadlineMs: () => number
  now: () => number
}

type Waiting = {
  ask: SponsoredAccountAsk
  answer: (answer: SponsoredAccountAnswer | 'timeout') => void
}

/**
 * One run's account step. `request` is what the tool calls; `answer` is what
 * the chat calls when the user responds.
 */
export class SponsoredAccountStep {
  private result: SponsoredAccountResult | null = null
  private pending: Promise<SponsoredAccountResult> | null = null
  private waiting: Waiting | null = null
  private confirmed = false
  private disposed = false

  constructor(private readonly deps: SponsoredAccountStepDeps) {}

  /** The user said Yes to the sign-in: a skill's `user_confirmed` passes. */
  get signupConfirmed(): boolean {
    return this.confirmed
  }

  /** Whether the run is waiting on the user right now. */
  get asking(): SponsoredAccountAsk | null {
    return this.waiting?.ask ?? null
  }

  /** The run ended: anything waiting continues as declined. */
  dispose(): void {
    this.disposed = true
    this.waiting?.answer({ kind: 'skip' })
  }

  request(signal: AbortSignal): Promise<SponsoredAccountResult> {
    if (signal.aborted || this.disposed)
      return Promise.resolve({
        status: 'unavailable',
        note: LAB_SIGNUP_STOPPED_NOTE,
      })
    if (this.result) return Promise.resolve(this.result)
    if (this.pending) return this.pending
    this.pending = this.run(signal)
      .then((result) => {
        if (result.status !== 'unavailable') this.result = result
        return result
      })
      .finally(() => {
        this.pending = null
      })
    return this.pending
  }

  /**
   * The user's response. A refused key leaves the form up with the reason and
   * returns it; everything else resolves the step and returns null.
   */
  answer(answer: SponsoredAccountAnswer): string | null {
    const waiting = this.waiting
    if (!waiting) return null
    if (answer.kind === 'credentials' && waiting.ask.kind === 'credentials') {
      for (const credential of waiting.ask.credentials) {
        const value = answer.values[credential.env]?.trim() ?? ''
        const problem = sponsoredCredentialValueProblem(value)
        if (problem) {
          const error = sponsoredCredentialRefusalCopy(credential, problem)
          waiting.ask = { ...waiting.ask, error }
          this.deps.show(waiting.ask)
          return error
        }
      }
    }
    waiting.answer(answer)
    return null
  }

  private async run(signal: AbortSignal): Promise<SponsoredAccountResult> {
    const { signup, credentials } = this.deps
    if (!signup) {
      if (credentials.length === 0)
        return { status: 'unavailable', note: LAB_SIGNUP_NO_STEP_NOTE }
      const connected = await this.connect(signal)
      if (!connected) return this.declined()
      return { status: 'confirmed', note: labConnectedNote(connected) }
    }
    // The `{email}` slot, if any, is removed: no prefill without consent.
    const url = signup.url ? signupUrlWithEmail(signup.url, null) : null
    if (!url) {
      return {
        status: 'unavailable',
        note: 'Tracked signup is unavailable. Do not open an untracked link. Report the remaining account-dependent steps as blocked.',
      }
    }
    const opened = await this.deps.openUrl(url).catch(() => false)
    const answer = await this.wait(
      { kind: 'signin', offerName: this.deps.offerName, url, opened },
      signal,
    )
    if (answer.kind !== 'signin' || !answer.confirmed) return this.declined()
    this.confirmed = true
    const credentialNote =
      credentials.length > 0 ? ((await this.connect(signal)) ?? '') : ''
    if (signal.aborted) return this.declined()
    return { status: 'confirmed', note: labSignInConfirmedNote(credentialNote) }
  }

  /**
   * The masked form. The credential note the model reads (names only), or
   * null when the user skipped or the deadline passed -- in which case the
   * model still reads why, in the declined note's place.
   */
  private async connect(signal: AbortSignal): Promise<string | null> {
    const { credentials, offerName } = this.deps
    const answer = await this.wait(
      { kind: 'credentials', offerName, credentials, error: null },
      signal,
    )
    if (answer.kind !== 'credentials') return null
    const values: Record<string, string> = {}
    for (const credential of credentials)
      values[credential.env] = answer.values[credential.env]!.trim()
    this.deps.held.hold(
      credentials.map((credential) => ({
        name: credential.env,
        value: values[credential.env]!,
      })),
    )
    const savedTo = await this.deps.save(values).catch(() => undefined)
    return [
      labCredentialSection(credentials, 'provided', offerName),
      sponsoredCredentialSavedLine(credentials.length, savedTo),
    ].join('\n')
  }

  /** Show `ask` until the user answers, the run stops, or the deadline. */
  private wait(
    ask: SponsoredAccountAsk,
    signal: AbortSignal,
  ): Promise<SponsoredAccountAnswer | { kind: 'timeout' }> {
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null
      const finish = (answer: SponsoredAccountAnswer | 'timeout') => {
        if (this.waiting !== waiting) return
        this.waiting = null
        if (timer) clearTimeout(timer)
        signal.removeEventListener('abort', aborted)
        this.deps.show(null)
        resolve(answer === 'timeout' ? { kind: 'timeout' } : answer)
      }
      const aborted = () => finish({ kind: 'skip' })
      const waiting: Waiting = { ask, answer: finish }
      if (signal.aborted || this.disposed) {
        resolve({ kind: 'skip' })
        return
      }
      this.waiting = waiting
      signal.addEventListener('abort', aborted, { once: true })
      timer = setTimeout(
        () => finish('timeout'),
        Math.max(0, this.deps.deadlineMs() - this.deps.now()),
      )
      timer.unref?.()
      this.deps.show(ask)
    })
  }

  private declined(): SponsoredAccountResult {
    return { status: 'declined', note: LAB_SIGNUP_DECLINED_NOTE }
  }
}
