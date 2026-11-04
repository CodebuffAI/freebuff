import { z } from 'zod/v4'
import { validGitHubBranch } from './github'

/** Server-owned repository and short-lived credential; never supplied by the renderer. */
export const deviceGitHubRequest = z.object({
  method: z.literal('github_connect'),
  fullName: z.string().regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/),
  branch: z.string().refine(validGitHubBranch),
  token: z.string().min(1).max(4096),
  author: z.object({ name: z.string().max(256), email: z.string().max(256) }).nullable(),
}).strict()
export type DeviceGitHubRequest = z.infer<typeof deviceGitHubRequest>
