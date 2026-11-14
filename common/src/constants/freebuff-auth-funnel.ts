import { z } from 'zod'

export const FREEBUFF_AUTH_EVENT = 'freebuff.auth_step'
export const authOriginSchema = z.enum(['web', 'desktop', 'cli', 'unknown'])
export const authProviderSchema = z.enum([
  'email',
  'google',
  'github',
  'apple',
  'existing',
])
export const authContextSchema = z
  .object({
    flow_id: z.string().uuid(),
    attempt_id: z.string().uuid(),
    origin: authOriginSchema,
    provider: authProviderSchema.optional(),
    started_at: z.number().int().positive(),
  })
  .strict()
export const authEventSchema = authContextSchema
  .omit({ started_at: true })
  .extend({
    event_version: z.literal(1),
    step: z.enum(['login', 'provider', 'auth', 'connect']),
    outcome: z.enum([
      'shown',
      'selected',
      'submitted',
      'succeeded',
      'failed',
      'cancelled',
      'reused',
    ]),
    reason: z
      .enum([
        'oauth',
        'blocked',
        'configuration',
        'invalid',
        'expired',
        'error',
        'phone_required',
        'already_connected',
        'invalid_credentials',
        'invalid_link',
        'invalid_code',
        'rate_limited',
        'unavailable',
        'challenge_incomplete',
        'network',
        'request_failed',
        'invalid_password',
        'password_mismatch',
      ])
      .optional(),
    is_new_user: z.boolean().optional(),
  })
  .strict()
export type AuthContext = z.infer<typeof authContextSchema>
export type AuthEvent = z.infer<typeof authEventSchema>
export type AuthProvider = z.infer<typeof authProviderSchema>

/** All external payloads are closed: never spread a callback, user or error. */
export function authEventProperties(
  context: AuthContext | null | undefined,
  step: AuthEvent['step'],
  outcome: AuthEvent['outcome'],
  details: Pick<AuthEvent, 'provider' | 'reason' | 'is_new_user'> = {},
): AuthEvent | null {
  const parsed = authContextSchema.safeParse(context)
  if (!parsed.success) return null
  const { started_at: _, ...fields } = parsed.data
  const result = authEventSchema.safeParse({
    ...fields,
    ...details,
    step,
    outcome,
    event_version: 1,
  })
  return result.success ? result.data : null
}

export function authInsertId(event: AuthEvent): string {
  return `auth:${event.flow_id}:${event.attempt_id}:${event.step}:${event.outcome}:${event.reason ?? ''}`
}

/** Session-local analytics identity, deliberately unrelated to an account. */
export function authDistinctId(flow: string): string {
  return `freebuff-auth:${flow}`
}
