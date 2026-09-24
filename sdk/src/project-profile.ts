import { createHash } from 'crypto'
import path from 'path'

import { FREEBUFF_ACTING_USER_HEADER } from '@codebuff/common/constants/freebuff-models'
import z from 'zod/v4'

import { getWebsiteUrl } from './constants'

import type {
  GetProjectProfileFn,
  ReportProjectProfileFn,
} from '@codebuff/common/types/contracts/database'

const PROJECT_PROFILE_PATH = '/api/v1/project-profile'

const projectProfileResponseSchema = z.object({
  due: z.boolean(),
  profile: z
    .object({
      appKinds: z.array(z.string()),
      technologies: z.array(z.string()),
    })
    .nullable(),
})

export async function resolveProjectKey(params: {
  projectKey?: string
  cwd?: string
  readFile: (filePath: string) => Promise<string>
}): Promise<string | undefined> {
  if (params.projectKey) return params.projectKey
  if (!params.cwd) return undefined
  let root = path.resolve(params.cwd)
  try {
    const gitFile = await params.readFile(path.join(root, '.git'))
    const gitDir = gitFile.match(/^gitdir:\s*(.+)$/m)?.[1]?.trim()
    const marker = `${path.sep}.git${path.sep}worktrees${path.sep}`
    const markerIndex = gitDir ? gitDir.indexOf(marker) : -1
    if (gitDir && markerIndex > 0) {
      root = path.resolve(root, gitDir.slice(0, markerIndex))
    }
  } catch {}
  return `local:${createHash('sha256').update(root).digest('hex').slice(0, 32)}`
}

export function projectProfileSurface(
  extraCodebuffMetadata: Record<string, string> | undefined,
): string {
  return (
    extraCodebuffMetadata?.surface ??
    (extraCodebuffMetadata?.freebuff_multi_session === '1' ? 'desktop' : 'cli')
  )
}

export function createProjectProfileClient(params: {
  apiKey: string
  userId?: string
  projectKey: string
  surface: string
}): {
  getProjectProfile: GetProjectProfileFn
  reportProjectProfile: ReportProjectProfileFn
} {
  const headers = {
    Authorization: `Bearer ${params.apiKey}`,
    'Content-Type': 'application/json',
    ...(params.userId ? { [FREEBUFF_ACTING_USER_HEADER]: params.userId } : {}),
  }
  return {
    getProjectProfile: async ({ logger, signal }) => {
      const url = new URL(PROJECT_PROFILE_PATH, getWebsiteUrl())
      url.searchParams.set('project_key', params.projectKey)
      const response = await fetch(url, { headers, signal })
      if (!response.ok) {
        logger.warn(
          { status: response.status },
          'getProjectProfile request failed',
        )
        return null
      }
      const parsed = projectProfileResponseSchema.safeParse(
        await response.json(),
      )
      return parsed.success ? parsed.data : null
    },
    reportProjectProfile: async ({ report, logger, signal }) => {
      const response = await fetch(
        new URL(PROJECT_PROFILE_PATH, getWebsiteUrl()),
        {
          method: 'POST',
          headers,
          signal,
          body: JSON.stringify({
            projectKey: params.projectKey,
            surface: params.surface,
            ...report,
          }),
        },
      )
      if (!response.ok) {
        logger.warn(
          { status: response.status },
          'reportProjectProfile request failed',
        )
      }
      return response.ok
    },
  }
}
