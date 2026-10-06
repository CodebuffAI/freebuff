/**
 * The wire schemas of a sponsored run's outcome-row metadata (COD-665): what
 * the Postgres bridge and the off-Cloud state route validate with.
 *
 * The builder, the closed code lists and the diagnostic helpers live in
 * `./sponsored-run-funnel-builder` (zod-free, so Convex can import them
 * without evaluating zod) and are re-exported here, so importers of this
 * module see one surface. Read that module's header first.
 */

import { z } from 'zod'

import { sponsoredExecutionSurfaceSchema } from './sponsored-capability'
import { SPONSORED_CLIENT_VERSION_PATTERN } from './sponsored-client-version'
import {
  SPONSORED_FUNNEL_DIAGNOSTIC_MAX,
  SPONSORED_RUN_CLIENTS,
  SPONSORED_RUN_EXECUTION_MODES,
  SPONSORED_RUN_FAILURE_CODES,
  SPONSORED_RUN_FROM_STATES,
  SPONSORED_RUN_OS,
} from './sponsored-run-funnel-builder'

export * from './sponsored-run-funnel-builder'

/**
 * The shape, as the Postgres bridge validates it. `.strict()` so a producer
 * that grew a field cannot widen the column without this file changing.
 */
export const sponsoredRunFunnelMetadataSchema = z
  .object({
    execution_mode: z.enum(SPONSORED_RUN_EXECUTION_MODES),
    execution_surface: z
      .union([sponsoredExecutionSurfaceSchema, z.literal('cloud')])
      .optional(),
    client: z.enum(SPONSORED_RUN_CLIENTS).optional(),
    os: z.enum(SPONSORED_RUN_OS).optional(),
    containment: z.literal('floor').optional(),
    from_state: z.enum(SPONSORED_RUN_FROM_STATES).optional(),
    failure_code: z.enum(SPONSORED_RUN_FAILURE_CODES).optional(),
    diagnostic_reason: z
      .string()
      .min(1)
      .max(SPONSORED_FUNNEL_DIAGNOSTIC_MAX)
      .optional(),
    llm_called: z.boolean().optional(),
    /** `desktop/<v>` or `cli/<v>` of the build that accepted (`sponsored-client-version.ts`). */
    client_version: z
      .string()
      .regex(SPONSORED_CLIENT_VERSION_PATTERN)
      .optional(),
  })
  .strict()

export type SponsoredRunFunnelMetadata = z.infer<
  typeof sponsoredRunFunnelMetadataSchema
>

/**
 * The schema a RECEIVER validates with: the same closed shape, except that a
 * `failure_code` this build does not know is recorded as `other` instead of
 * refusing the whole row.
 *
 * Convex deploys before Render, and a rollback reverts Next before Convex, so
 * for a window every deploy a newer producer talks to an older receiver. A
 * strict enum there turns each new code into a 400 on the bridge and a null
 * on the state route -- the outcome recorded, the reason lost. Only the
 * failure code is widened: an unknown KEY is still refused, so the bridge
 * cannot become a channel for text this module never named.
 */
export const sponsoredRunFunnelMetadataReceiverSchema = z.preprocess(
  (value) =>
    value !== null &&
    typeof value === 'object' &&
    'failure_code' in value &&
    typeof value.failure_code === 'string' &&
    !(SPONSORED_RUN_FAILURE_CODES as readonly string[]).includes(
      value.failure_code,
    )
      ? { ...value, failure_code: 'other' }
      : value,
  sponsoredRunFunnelMetadataSchema,
)
