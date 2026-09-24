/**
 * The sponsored consent question: one sentence, asked in the same words on every surface.
 *
 * COD-410. The dialog used to be a field list -- advertiser, task, summary, folder, branch, and a
 * paragraph of assurances under it -- and a list nobody reads is not informed consent however much
 * it contains. What is left is the advertiser's name, one sentence of ours, and two buttons.
 *
 * The name is ADVERTISER-AUTHORED and the sentence is OURS, which is why they are never one string:
 * every surface sets the name into its own element (a `<span>` on Desktop, a bold `<span>` in the
 * TUI) with our words outside it, so their text can neither become markup nor be read as a promise
 * the product is making.
 *
 * Desktop's `freebuff-desktop/electron/mcp-consent-bridge.cjs` carries its own copy of these two
 * values rather than importing them: it is a plain CJS module loaded by the Electron main process,
 * deliberately free of workspace requires so it unit-tests under Bun and survives packaging
 * untouched. `consent-window.render.test.ts` pins the copies equal to these, so a change here that
 * is not mirrored there fails rather than ships two different questions.
 */

/**
 * The words after the advertiser's name -- note the leading space; the name is concatenated
 * directly onto the front of it.
 */
export const SPONSORED_CONSENT_SENTENCE =
  ' wants to integrate itself into this project, on its own branch. Nothing is pushed until you review it.'

/**
 * The second sentence, shown ONLY where the run has no OS sandbox: Windows (COD-642). Plain words
 * for the three things a user is agreeing to there -- their own permissions, no sandbox, and
 * credentials that are kept out of the run's way rather than locked away. Product-owned and fixed:
 * a surface decides from its own platform whether to show it, never from anything it was sent.
 */
export const SPONSORED_CONSENT_WINDOWS_FLOOR_SENTENCE =
  'On Windows there is no sandbox. This task runs with your own Windows permissions, and your credentials are hidden from it but not locked away.'

/**
 * What a surface shows when it cannot name who is asking. Blank is not a legal render: a sentence
 * about nobody asks a human to consent to nothing, so the surfaces refuse instead of asking.
 */
export const SPONSORED_CONSENT_NO_NAME =
  'This dialog could not say who is asking — do not approve.'

/**
 * The name is the whole attack surface of a one-sentence dialog, so it is capped well short of the
 * general display cap (4,000, sized for a connector's argv): at that length a name pushes the
 * buttons off a dialog and wraps a terminal card into a wall.
 */
export const SPONSORED_CONSENT_MAX_NAME_CHARS = 80

// Escaped, never stripped -- dropping the character hides the payload just as well, only quietly.
// Same set as the consent bridge's `UNSAFE_DISPLAY`: C0/C1 controls, the bidi overrides and
// isolates, the zero-width joiners and the line/paragraph separators. All of them can make a name
// render as text it is not, which on a consent screen is the entire game.
const ESCAPES: Record<string, string> = { '\n': '\\n', '\r': '\\r', '\t': '\\t' }
const UNSAFE_DISPLAY =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\u2028\u2029\ufeff]/g

/** The advertiser's name, made safe to render and short enough not to move the buttons. */
export function sponsoredConsentName(advertiser: string | null | undefined): string {
  const text = String(advertiser ?? '')
    .replace(
      UNSAFE_DISPLAY,
      (c) => ESCAPES[c] ?? `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
    )
    .trim()
  return text.length > SPONSORED_CONSENT_MAX_NAME_CHARS
    ? `${text.slice(0, SPONSORED_CONSENT_MAX_NAME_CHARS)}…`
    : text
}

/**
 * The whole sentence as one string, for a surface that cannot keep the name in its own element --
 * the OS message box Desktop falls back to when it cannot draw its own window. Surfaces that CAN
 * separate them must, and use {@link sponsoredConsentName} plus
 * {@link SPONSORED_CONSENT_SENTENCE} instead.
 */
export function sponsoredConsentSentence(advertiser: string | null | undefined): string {
  const who = sponsoredConsentName(advertiser)
  return who ? `${who}${SPONSORED_CONSENT_SENTENCE}` : SPONSORED_CONSENT_NO_NAME
}
