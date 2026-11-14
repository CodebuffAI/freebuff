import { z } from 'zod/v4'

/**
 * Optional product-discovery hints, separate from training-only ad telemetry.
 * These client reports may suppress an irrelevant free house tip only; they
 * never grant access, change paid inventory, or determine billing. Missing
 * feature state is unknown, not evidence that the user has not tried it.
 */
export const houseAdContextSchema = z.object({
  app: z.enum(['desktop', 'web']),
  isDefaultTheme: z.boolean().optional(),
  hasIntegrations: z.boolean().optional(),
  hasDeployedSite: z.boolean().optional(),
  hasUsedTemplate: z.boolean().optional(),
})

export type HouseAdContext = z.infer<typeof houseAdContextSchema>

export function parseHouseAdContext(
  input: unknown,
): HouseAdContext | undefined {
  const result = houseAdContextSchema.safeParse(input)
  return result.success ? result.data : undefined
}
