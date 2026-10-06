import { z } from 'zod'

/** An optional incentive attached to an advertiser's creative, never its replacement. */
export const adRewardOfferSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  reward: z.number().int().positive(),
  taskUrl: z
    .string()
    .url()
    .refine((value) => {
      const url = new URL(value)
      return (
        url.protocol === 'https:' ||
        (url.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      )
    }),
})

export type AdRewardOffer = z.infer<typeof adRewardOfferSchema>

export const AD_REWARD_CONDITION =
  'After proof approval and advertiser confirmation.'
