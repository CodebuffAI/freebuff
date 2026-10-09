import { z } from 'zod/v4'

export const labAdSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(200).optional(),
    advertiserName: z.string().trim().min(1).max(120),
    headline: z.string().trim().min(1).max(200),
    body: z.string().trim().max(2000),
    procedure: z.string().trim().min(1).max(30000),
    targeting: z.string().max(10000).default(''),
    signupUrl: z
      .string()
      .max(2000)
      .default('')
      .refine((value) => {
        if (!value) return true
        try {
          const url = new URL(value)
          return url.protocol === 'https:' && !url.username && !url.password
        } catch {
          return false
        }
      }, 'Use an HTTPS signup URL.'),
  })
  .strict()
export type LabAd = z.infer<typeof labAdSchema>
export const labSelectionSchema = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('creative'), id: z.string().min(1).max(120) })
    .strict(),
  z.object({ kind: z.literal('campaign'), id: z.string().uuid() }).strict(),
  z.object({ kind: z.literal('draft'), id: z.string().uuid() }).strict(),
])
export type LabSelection = z.infer<typeof labSelectionSchema>
export type LabAdSearchPage = {
  items: Array<{
    id: string
    name: string
    campaignName: string
    advertiserName: string
    status: string
    deliveryPaused: boolean
  }>
  nextOffset: number | null
}
export type LabRepository = {
  projectId: string
  fullName: string
  branch: string
}
export type LabSettings = {
  revision: number
  selection: LabSelection | null
  drafts: LabAd[]
  repositories: LabRepository[]
}
export type LabOffer = {
  id: string
  workspaceId: string
  projectId: string
  runId: string
  ad: LabAd
  state: 'offered' | 'accepted' | 'declined'
  signup: 'idle' | 'requested' | 'confirmed' | 'declined'
  signupUrl: string | null
  signupExpiresAt: string | null
  runStatus: string | null
  runError: string | null
}
/** Accept only a GitHub repository, never a user-supplied fetch host or revision. */
export function publicRepositoryName(input: string): string | null {
  let name = input
    .trim()
    .replace(/\/$/, '')
    .replace(/\.git$/, '')
  if (name.startsWith('https://github.com/')) name = name.slice(19)
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(name) &&
    !name.split('/').some((part) => part === '.' || part === '..')
    ? name
    : null
}
export const LAB_SIGNUP_YES = 'Yes, I’m signed in'
export const LAB_SIGNUP_NO = 'No, I don’t want to sign up'
export const LAB_RUN_GUIDANCE = `This is an accepted sponsored implementation in the agentic ads lab. Execute only the accepted advertiser procedure, fitted to this project. Even if signup is listed first, finish useful implementation and checks that do not require authentication before calling request_sponsored_signup. Call it only when remaining progress requires the account. The host supplies the approved URL; never substitute another signup destination. Wait for the tool result. If the user declines, preserve progress and explain what remains incomplete without asking again. Browser sign-in is not CLI authentication or a verified conversion. Never request API keys, passwords or tokens in chat. If more credentials are required, report the blocked step. Leave changes uncommitted; do not push, deploy, publish, or access another project. Finish with completed work and remaining blockers.`
