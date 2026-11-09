import { z } from 'zod'
import { templateAnalyticsFields } from '../templates/analytics'

export const PRODUCT_FUNNEL_EVENT = 'freebuff.product_funnel_step'
export const productFunnelProductSchema = z.enum([
  'web',
  'app_builder',
  'students',
  'cli',
  'desktop',
])
export const productFunnelStageSchema = z.enum([
  'landing',
  'cta',
  'copy',
  'download',
  'install',
  'launch',
  'login',
  /** the first-sign-in welcome in the hosted Desktop workspace: shown, copied (the invite link), closed */
  'welcome',
  'browser',
  'context',
  'composer',
  'draft',
  'project',
  'template',
  'model_picker',
  'model_selection',
  'admission',
  'send',
  'turn',
  'response',
  'preview',
])
export const productFunnelStateSchema = z.enum([
  'shown',
  'clicked',
  'copied',
  'started',
  'opened',
  'ready',
  'selected',
  'applied',
  'accepted',
  'received',
  'visible',
  'succeeded',
  'failed',
  'cancelled',
  'closed',
  'blocked',
  'skipped',
  'recovered',
])
/**
 * The Desktop welcome's invite links carry `?via=` naming the share that made
 * them, so the friend's landing pageview (its `$current_url`) ties their
 * signup and first message back to the welcome in PostHog: one funnel per
 * person on the invitee's side, next to the inviter's shown → shared tile. Not
 * a UTM on purpose: a `utm_source` would turn the account's first-touch
 * channel from `referral` into `campaign_other` (gravity-acquisition-tags.ts).
 */
export const WELCOME_INVITE_VIA_PARAM = 'via'
export const WELCOME_INVITE_VIA = Object.freeze({
  email: 'welcome_email',
  link: 'welcome_link',
})
/**
 * The workspace's other invite placements mark their links the same way:
 * `<placement>_link` for a copied link, `<placement>_email` for an emailed one,
 * so each charts apart from the welcome's `via=welcome_`. The invite route
 * only puts an email value from this list in the emailed link; anything else
 * is the welcome's. docs/referrals.md lists where each placement is.
 */
export const REFERRAL_INVITE_VIA = Object.freeze({
  dock: Object.freeze({ link: 'dock_link', email: 'dock_email' }),
  inline: Object.freeze({ link: 'inline_link', email: 'inline_email' }),
  sidebar: Object.freeze({ link: 'sidebar_link', email: 'sidebar_email' }),
  settings: Object.freeze({ link: 'settings_link', email: 'settings_email' }),
})
export type ReferralInvitePlacement = keyof typeof REFERRAL_INVITE_VIA
export type ReferralInviteEmailVia =
  | typeof WELCOME_INVITE_VIA.email
  | (typeof REFERRAL_INVITE_VIA)[ReferralInvitePlacement]['email']
export const REFERRAL_INVITE_EMAIL_VIA: readonly ReferralInviteEmailVia[] =
  Object.freeze([
    WELCOME_INVITE_VIA.email,
    ...Object.values(REFERRAL_INVITE_VIA).map((via) => via.email),
  ])

/**
 * The PostHog person property naming a signed-in account's OWN invite code
 * (`user.referral_code`), set once per account per browser when the workspace
 * learns the code (freebuff/web `lib/own-referral-code.ts`). A friend's landing
 * carries the code they arrived through (`referral_code`, an event property;
 * `ref=` in the landing URL), which is random, so this is the only key that
 * ties an inviter's share to the friends it brought: the Referrals dashboard's
 * cohort tiles join the two (scripts/posthog-referrals-dashboard.ts).
 */
export const OWN_REFERRAL_CODE_PERSON_PROPERTY = 'own_referral_code'

/**
 * `via` values of links that carry only the account's own `/?ref=` link, with
 * no email invite behind them, so the invite route never accepts them.
 * `lifecycle_email`: the Activated sequence's day-7 referral ask
 * (docs/freebuff-lifecycle-email.md).
 */
export const REFERRAL_LINK_ONLY_VIA = Object.freeze({
  lifecycleEmail: 'lifecycle_email',
})

/** A placement's invite link: the referral code and the placement's `via`. */
export function referralInviteUrl(
  origin: string,
  referralCode: string,
  placement: ReferralInvitePlacement,
): string {
  return `${origin}/?ref=${encodeURIComponent(referralCode)}&${WELCOME_INVITE_VIA_PARAM}=${REFERRAL_INVITE_VIA[placement].link}`
}

/** The Desktop welcome's H1 test: one arm per account, stable, on every `welcome` event. */
export const welcomeVariantSchema = z.enum([
  'unlocked',
  'give',
  'share',
  'paying',
])
export const productEntryRouteSchema = z.enum([
  '/',
  '/app',
  '/app-builder',
  '/students',
  '/cloud',
  '/chat',
  '/cli',
  'cli',
  'other',
])
const opaqueId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/)
const modelId = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-zA-Z0-9_./:@-]+$/)

/** Closed payload: no prompts, paths, URLs, account IDs, auth IDs or provider errors. */
export const productFunnelPropertiesSchema = z
  .object({
    ...templateAnalyticsFields,
    entry_account_state: z
      .enum(['signed_out', 'signed_in', 'stored_credentials'])
      .optional(),
    run_id: opaqueId.optional(),
    thread_id: opaqueId.optional(),
    project_id: opaqueId.optional(),
    input_id: opaqueId.optional(),
    model: modelId.optional(),
    previous_model: modelId.optional(),
    harness: z
      .enum(['codebuff', 'codex', 'claude-code', 'external', 'unknown'])
      .optional(),
    project_kind: z
      .enum([
        'folder',
        'no_folder',
        'cloud',
        'cloud_repo',
        'cloud_empty',
        'local',
        'template',
        'unknown',
      ])
      .optional(),
    destination: z
      .enum(['desktop', 'cli', 'web', 'app_builder', 'cowork', 'mobile'])
      .optional(),
    location: z
      .enum([
        'nav',
        'hero',
        'everywhere',
        'footer',
        'workspace',
        'picker',
        'unknown',
      ])
      .optional(),
    reason: z
      .enum([
        'empty',
        'error',
        'refused',
        'recovered',
        'paywall',
        'setup',
        'cancel',
        'navigation',
        'escape',
        'outside',
        'unavailable',
        'timeout',
        'invalid',
        'unsupported',
        'blocked',
        'already_running',
        'default',
        'unknown',
        'compacting',
        'moving',
        'too_long',
        'admission',
        'existing',
        'closed',
        'completed',
        'stopped',
        'failed',
        'cancelled',
        'selection',
        'retry',
        'queue',
        'history',
      ])
      .optional(),
    /** `send:failed` `blocked`: the refusing admission's `status`, which is the
     *  why a bare `blocked` never said (~23% of hosted Desktop senders a day, 2026-11-07). */
    admission_status: z
      .string()
      .regex(/^[a-z_]{1,40}$/)
      .optional(),
    /** `send:failed` `error`: the error's class (`sendErrorKind`), never its text. */
    error_kind: z
      .string()
      .regex(/^[a-z0-9_]{1,40}$/)
      .optional(),
    selection_kind: z
      .enum([
        'default',
        'changed',
        'unchanged',
        'reselected',
        'blocked',
        'unknown',
      ])
      .optional(),
    has_attachments: z.boolean().optional(),
    attachment_count: z.number().int().min(0).max(1000).optional(),
    character_count: z.number().int().min(0).max(10_000_000).optional(),
    duration_ms: z
      .number()
      .int()
      .min(0)
      .max(7 * 24 * 60 * 60 * 1000)
      .optional(),
    has_output: z.boolean().optional(),
    output_kind: z.enum(['text', 'tool', 'file_change']).optional(),
    restored: z.boolean().optional(),
    queued: z.boolean().optional(),
    release: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-zA-Z0-9.+_-]+$/)
      .optional(),
    platform: z.enum(['darwin', 'win32', 'linux', 'other']).optional(),
    originApp: z.enum(['desktop', 'web']).optional(),
    executionTarget: z.enum(['device', 'cloud']).optional(),
    welcome_variant: welcomeVariantSchema.optional(),
    renderer: z.literal('web-workspace').optional(),
    appVersion: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-zA-Z0-9.+_-]+$/)
      .optional(),
  })
  .strict()

/** Product identifies the entry cohort; Students/Builder share the web runtime. */
export const productFunnelEventSchema = productFunnelPropertiesSchema.extend({
  product: productFunnelProductSchema,
  flow_id: z.string().uuid(),
  entry_route: productEntryRouteSchema,
  funnel_stage: productFunnelStageSchema,
  funnel_state: productFunnelStateSchema,
  event_version: z.literal(1),
  surface: z.enum(['web', 'cli', 'desktop']),
  observer: z.enum(['ui', 'cli', 'server']),
})

export type ProductFunnelProduct = z.infer<typeof productFunnelProductSchema>
export type ProductEntryRoute = z.infer<typeof productEntryRouteSchema>
export type ProductFunnelStage = z.infer<typeof productFunnelStageSchema>
export type ProductFunnelState = z.infer<typeof productFunnelStateSchema>
export type WelcomeVariant = z.infer<typeof welcomeVariantSchema>
export type ProductFunnelProperties = z.infer<
  typeof productFunnelPropertiesSchema
>
export type ProductFunnelEvent = z.infer<typeof productFunnelEventSchema>
export type ProductJourney = Pick<
  ProductFunnelEvent,
  'flow_id' | 'product' | 'entry_route'
>

/** Strip SDK URL/person enrichment before either capture or the log mirror. */
export function sanitizeProductFunnelCapture<
  T extends {
    event: string
    properties: Record<string, unknown>
  },
>(event: T, projectToken: string): T | null {
  if (event.event !== PRODUCT_FUNNEL_EVENT) return event
  const fields: Record<string, unknown> = {}
  for (const key of productFunnelEventSchema.keyof().options) {
    if (event.properties[key] !== undefined) fields[key] = event.properties[key]
  }
  const parsed = productFunnelEventSchema.safeParse(fields)
  if (!parsed.success) return null
  // posthog-js adds this public ingest key before before_send; transport does
  // not restore it after sanitization. Never copy an untrusted event token.
  const properties: Record<string, unknown> = {
    ...parsed.data,
    token: projectToken,
  }
  for (const key of [
    'distinct_id',
    '$insert_id',
    '$session_id',
    '$is_identified',
  ]) {
    const value = event.properties[key]
    if (typeof value === 'string' || typeof value === 'boolean')
      properties[key] = value
  }
  const sanitized = { ...event, properties }
  Reflect.deleteProperty(sanitized, '$set')
  Reflect.deleteProperty(sanitized, '$set_once')
  return sanitized
}
