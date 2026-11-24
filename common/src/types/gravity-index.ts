import z from 'zod/v4'

import { jsonObjectSchema } from './json'

// Shared field constraints reused by both the per-action schemas
// (gravityIndexApiInputSchema) and the flat tool-facing schema below, so the
// bounds and error messages stay in sync. Descriptions are applied per use
// site because they differ between the two contexts (single-action vs. the
// `For action "X":` prefixes the flat LLM schema needs).
const queryField = z
  .string()
  .min(1, 'Query cannot be empty')
  .max(1000, 'Query cannot exceed 1000 characters')
const slugField = z.string().min(1, 'Slug cannot be empty')
const integratedSlugField = z.string().min(1, 'integrated_slug cannot be empty')

const searchInputSchema = z.object({
  action: z.literal('search').describe('Search for the best service.'),
  query: queryField.describe(
    `What the user needs, including stack, constraints, and required capabilities when known. Example: "serverless database with branching for a Next.js app".`,
  ),
  search_id: z
    .string()
    .optional()
    .describe('Continue a previous Gravity Index search as a follow-up.'),
  context: jsonObjectSchema
    .optional()
    .describe(
      'Optional structured JSON context about the project, stack, or constraints.',
    ),
})

const browseInputSchema = z.object({
  action: z
    .literal('browse')
    .describe('Browse catalog services by category and/or keyword.'),
  category: z
    .string()
    .optional()
    .describe(
      'Optional category filter, e.g. Database, Auth, Payments, Hosting, Email, Cache, Monitoring, Analytics, AI, Storage, CMS, Search, Realtime, Background Jobs, Infrastructure, CRM, Support, Productivity, Commerce, Video, Webhooks, SMS.',
    ),
  q: z
    .string()
    .optional()
    .describe('Optional keyword filter, e.g. sendgrid or postgres.'),
})

const listCategoriesInputSchema = z.object({
  action: z
    .literal('list_categories')
    .describe('List every category with service counts.'),
})

const getServiceInputSchema = z.object({
  action: z
    .literal('get_service')
    .describe('Fetch full detail for a single service by slug.'),
  slug: slugField.describe('Service slug, e.g. supabase, stripe, sendgrid.'),
})

/**
 * Ask Gravity to create the account on the user's behalf and hand back working
 * credentials, instead of sending the user off to a signup page. Gravity mints
 * a `grclid` and emits the conversion at provision time, so a provision that
 * succeeds is a conversion — there is no click to lose in between.
 *
 * `user_email` is deliberately absent: the account is created under a verified
 * address, so the server injects it from the authenticated identity and ignores
 * anything the model supplies. A tool-facing email field would let a
 * prompt-injected model open accounts under someone else's address.
 */
const provisionInputSchema = z.object({
  action: z
    .literal('provision')
    .describe('Create an account on the user’s behalf and receive credentials.'),
  slug: slugField.describe('Service slug to provision, e.g. neon.'),
  search_id: z
    .string()
    .min(1, 'search_id cannot be empty')
    .describe('search_id from the earlier search result.'),
  user_consent: z
    .literal(true)
    .describe(
      'Must be true, and only after the user has explicitly approved creating an account on this service.',
    ),
})

const reportIntegrationInputSchema = z.object({
  action: z
    .literal('report_integration')
    .describe('Report that an integration from a prior search was done.'),
  search_id: z
    .string()
    .min(1, 'search_id cannot be empty')
    .describe('search_id from the earlier search result.'),
  integrated_slug: integratedSlugField.describe(
    'Slug of the service that was actually integrated.',
  ),
})

const runtimeAttributionFields = {
  external_session_id: z
    .string()
    .optional()
    .describe(
      'Stable Codebuff session ID for Gravity API key attribution. Codebuff usually fills this automatically.',
    ),
  // Raw, stable per-end-user identifier for Gravity attribution + payout
  // matching. Surfaces that run under a shared service account (e.g. Freebuff
  // Web) set this to the real end user so conversions don't all collapse onto
  // the service account. The server hashes it before sending it to Gravity.
  // Codebuff usually fills this automatically.
  external_user_id: z
    .string()
    .optional()
    .describe(
      'Stable per-end-user identifier for Gravity attribution. Codebuff usually fills this automatically.',
    ),
  metadata: jsonObjectSchema
    .optional()
    .describe(
      'Non-sensitive API key metadata for Gravity attribution and debugging. Codebuff usually fills this automatically.',
    ),
}

// Tool-facing schema presented to the LLM provider. Native function-calling
// providers require the top-level `parameters` to be a JSON Schema of
// `type: "object"`, so this MUST be a flat `z.object` rather than a top-level
// discriminated union (which serializes to `oneOf`/`anyOf` with no top-level
// type). Per-action requiredness is enforced server-side by
// `gravityIndexApiInputSchema` below.
export const gravityIndexInputSchema = z
  .object({
    action: z
      .enum([
        'search',
        'browse',
        'list_categories',
        'get_service',
        'provision',
        'report_integration',
      ])
      .describe(
        'Which Gravity Index operation to perform. search: recommend a provider; browse: list catalog services; list_categories: list categories with counts; get_service: full detail for a known slug; provision: create the account for the user and receive credentials; report_integration: report a completed integration.',
      ),
    query: queryField
      .optional()
      .describe(
        `For action "search": what the user needs, including stack, constraints, and required capabilities when known. Example: "serverless database with branching for a Next.js app".`,
      ),
    search_id: z
      .string()
      .optional()
      .describe(
        'For action "search": continue a previous Gravity Index search as a follow-up. For actions "provision" and "report_integration": the search_id from the earlier search result (required).',
      ),
    context: jsonObjectSchema
      .optional()
      .describe(
        'For action "search": optional structured JSON context about the project, stack, or constraints.',
      ),
    category: z
      .string()
      .optional()
      .describe(
        'For action "browse": optional category filter, e.g. Database, Auth, Payments, Hosting, Email, Cache, Monitoring, Analytics, AI, Storage, CMS, Search, Realtime, Background Jobs, Infrastructure, CRM, Support, Productivity, Commerce, Video, Webhooks, SMS.',
      ),
    q: z
      .string()
      .optional()
      .describe(
        'For action "browse": optional keyword filter, e.g. sendgrid or postgres.',
      ),
    slug: slugField
      .optional()
      .describe(
        'For actions "get_service" and "provision": service slug, e.g. supabase, stripe, sendgrid (required).',
      ),
    integrated_slug: integratedSlugField
      .optional()
      .describe(
        'For action "report_integration": slug of the service that was actually integrated (required).',
      ),
    user_consent: z
      .literal(true)
      .optional()
      .describe(
        'For action "provision": must be true, and only after the user has explicitly approved creating an account on this service (required).',
      ),
  })
  .describe(`Use the Gravity Index tool discovery and install API.`)

// Catalog reads (browse / list_categories / get_service) keep only the
// runtime-stamped `metadata`, so the server's attribution log can record which
// surface made the call. They are plain GETs upstream: the server does not
// forward metadata to Gravity for them, and they carry no user attribution.
// Like every runtime field, this is server-side only: the flat tool-facing
// schema above never offers `metadata` to the model.
const catalogMetadataFields = {
  metadata: runtimeAttributionFields.metadata,
}

export const gravityIndexApiInputSchema = z
  .discriminatedUnion('action', [
    searchInputSchema.extend(runtimeAttributionFields),
    browseInputSchema.extend(catalogMetadataFields),
    listCategoriesInputSchema.extend(catalogMetadataFields),
    getServiceInputSchema.extend(catalogMetadataFields),
    provisionInputSchema.extend(runtimeAttributionFields),
    reportIntegrationInputSchema.extend(runtimeAttributionFields),
  ])
  .describe(`Use the Gravity Index tool discovery and install API.`)

export type GravityIndexInput = z.infer<typeof gravityIndexApiInputSchema>
