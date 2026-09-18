import z from 'zod/v4'

export const CLIENT_ENV_PREFIX = 'NEXT_PUBLIC_'

export const clientEnvSchema = z.object({
  NEXT_PUBLIC_CB_ENVIRONMENT: z.enum(['dev', 'test', 'prod']),
  NEXT_PUBLIC_CODEBUFF_APP_URL: z.url().min(1),
  NEXT_PUBLIC_FREEBUFF_APP_URL: z.url().optional(),
  NEXT_PUBLIC_SUPPORT_EMAIL: z.email().min(1),
  NEXT_PUBLIC_POSTHOG_API_KEY: z.string().min(1),
  NEXT_PUBLIC_POSTHOG_HOST_URL: z.url().min(1),
  NEXT_PUBLIC_GRAVITY_PIXEL_ID: z.uuid().optional(),
  /** Public Meta dataset/pixel ID. Unset disables Freebuff landing tracking. */
  NEXT_PUBLIC_META_PIXEL_ID: z.string().regex(/^\d+$/).max(32).optional(),
  /** Optional paid-social dataset IDs; absent leaves first-party capture off. */
  NEXT_PUBLIC_X_PIXEL_ID: z
    .string()
    .regex(/^[a-z0-9]+$/)
    .max(32)
    .optional(),
  NEXT_PUBLIC_TIKTOK_PIXEL_ID: z
    .string()
    .regex(/^[A-Za-z0-9]+$/)
    .max(64)
    .optional(),
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: z.string().min(1),
  NEXT_PUBLIC_STRIPE_CUSTOMER_PORTAL: z.url().min(1),
  NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION_ID: z.string().optional(),
  NEXT_PUBLIC_WEB_PORT: z.coerce.number().min(1000),
  /** Cloudflare Turnstile site key for the signup challenge. Public by design —
   *  the secret half is server-only (`TURNSTILE_SECRET_KEY`). Optional so a dev
   *  checkout without Turnstile configured still boots; the server gate decides
   *  whether a missing key means "skip" or "refuse". */
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: z.string().min(1).optional(),
  /**
   * Google reCAPTCHA site keys — BOTH versions, which run together rather than
   * as alternatives. v3 scores the session invisibly; v2 asks the human to click
   * a box. Public by design; the secret halves are `RECAPTCHA_V2_SECRET_KEY` and
   * `RECAPTCHA_V3_SECRET_KEY`.
   *
   * These are two separate registrations in the reCAPTCHA console with two
   * separate secrets, and the versions are NOT interchangeable: using a v2 key
   * where a v3 one is expected throws `Invalid site key type`, mints no token,
   * and is indistinguishable at the gate from a bot. Either may be omitted to
   * run only the other; both optional so a dev checkout still boots.
   */
  NEXT_PUBLIC_RECAPTCHA_V2_SITE_KEY: z.string().min(1).optional(),
  NEXT_PUBLIC_RECAPTCHA_V3_SITE_KEY: z.string().min(1).optional(),
  /**
   * Whether the v2 widget is a checkbox everyone clicks or an invisible check.
   *
   * `checkbox` buys nothing against bots that `invisible` does not: both are the
   * same key type hitting the same risk engine, and both escalate to the same
   * image challenge when Google is suspicious. The choice is purely how much
   * friction to show a clean user, which is why it is one env value and not a
   * design. NOTE that the key itself is registered as one or the other, so this
   * has to match the registration — an invisible-registered key rejects
   * `checkbox` outright.
   *
   * Optional rather than `.default('checkbox')`, with the default applied at the
   * point of use. A `.default()` here would make this the only field in this
   * schema whose OUTPUT type is required, and `clientEnv` is built as an object
   * literal by fixtures across agent-runtime, evals and web — so it breaks all
   * of them at the type level over a value none of them care about. Adding a
   * DEFAULTED client env var is quietly a breaking change; an optional one is
   * not.
   */
  NEXT_PUBLIC_RECAPTCHA_V2_SIZE: z.enum(['checkbox', 'invisible']).optional(),
  /** Human Behavior session-replay write key for Freebuff Web. Public by
   *  design — it only authorizes ingestion. Optional so a dev checkout without
   *  it boots with replay simply switched off. */
  NEXT_PUBLIC_HUMANBEHAVIOR_API_KEY: z.string().min(1).optional(),
} satisfies Record<`${typeof CLIENT_ENV_PREFIX}${string}`, any>)
export const clientEnvVars = clientEnvSchema.keyof().options
export type ClientEnvVar = (typeof clientEnvVars)[number]
export type ClientInput = {
  [K in (typeof clientEnvVars)[number]]: string | undefined
}
export type ClientEnv = z.infer<typeof clientEnvSchema>

// Bun will inject all these values, so we need to reference them individually (no for-loops)
export const clientProcessEnv: ClientInput = {
  NEXT_PUBLIC_CB_ENVIRONMENT: process.env.NEXT_PUBLIC_CB_ENVIRONMENT,
  NEXT_PUBLIC_CODEBUFF_APP_URL: process.env.NEXT_PUBLIC_CODEBUFF_APP_URL,
  NEXT_PUBLIC_FREEBUFF_APP_URL: process.env.NEXT_PUBLIC_FREEBUFF_APP_URL,
  NEXT_PUBLIC_SUPPORT_EMAIL: process.env.NEXT_PUBLIC_SUPPORT_EMAIL,
  NEXT_PUBLIC_POSTHOG_API_KEY: process.env.NEXT_PUBLIC_POSTHOG_API_KEY,
  NEXT_PUBLIC_POSTHOG_HOST_URL: process.env.NEXT_PUBLIC_POSTHOG_HOST_URL,
  NEXT_PUBLIC_GRAVITY_PIXEL_ID: process.env.NEXT_PUBLIC_GRAVITY_PIXEL_ID,
  NEXT_PUBLIC_META_PIXEL_ID: process.env.NEXT_PUBLIC_META_PIXEL_ID,
  NEXT_PUBLIC_X_PIXEL_ID: process.env.NEXT_PUBLIC_X_PIXEL_ID,
  NEXT_PUBLIC_TIKTOK_PIXEL_ID: process.env.NEXT_PUBLIC_TIKTOK_PIXEL_ID,
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY:
    process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY,
  NEXT_PUBLIC_STRIPE_CUSTOMER_PORTAL:
    process.env.NEXT_PUBLIC_STRIPE_CUSTOMER_PORTAL,
  NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION_ID:
    process.env.NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION_ID,
  NEXT_PUBLIC_WEB_PORT: process.env.NEXT_PUBLIC_WEB_PORT,
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY,
  NEXT_PUBLIC_RECAPTCHA_V2_SITE_KEY:
    process.env.NEXT_PUBLIC_RECAPTCHA_V2_SITE_KEY,
  NEXT_PUBLIC_RECAPTCHA_V3_SITE_KEY:
    process.env.NEXT_PUBLIC_RECAPTCHA_V3_SITE_KEY,
  NEXT_PUBLIC_RECAPTCHA_V2_SIZE: process.env.NEXT_PUBLIC_RECAPTCHA_V2_SIZE,
  NEXT_PUBLIC_HUMANBEHAVIOR_API_KEY:
    process.env.NEXT_PUBLIC_HUMANBEHAVIOR_API_KEY,
}
