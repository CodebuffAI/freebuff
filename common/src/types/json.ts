import z from 'zod/v4'

export type JSONValue =
  | null
  | string
  | number
  | boolean
  | JSONObject
  | JSONArray
export const jsonValueSchema: z.ZodType<JSONValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.string(),
    z.number(),
    z.boolean(),
    jsonObjectSchema,
    jsonArraySchema,
  ]),
)

export const jsonObjectSchema: z.ZodType<JSONObject> = z.lazy(() =>
  z.record(z.string(), jsonValueSchema.optional()),
)
/**
 * JSON as it actually crosses boundaries: read-only. The model SDKs type their
 * payloads with `Readonly<...>` objects and arrays, and a mutable index
 * signature does not accept them, so every `providerOptions` assignment was a
 * type error. Reading is all the CLI does with this data anyway; the one place
 * that needs a mutable copy builds `Record<string, unknown>` for itself.
 */
export type JSONObject = { readonly [key in string]: JSONValue | undefined }

export const jsonArraySchema: z.ZodType<JSONArray> = z.lazy(() =>
  z.array(jsonValueSchema),
)
export type JSONArray = readonly JSONValue[]
