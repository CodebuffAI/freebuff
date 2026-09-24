import {
  buildProjectProfileRequest,
  PROJECT_PROFILE_TOOL_NAME,
} from '@codebuff/common/constants/project-profile'
import { toolParams } from '@codebuff/common/tools/list'
import { getErrorObject } from '@codebuff/common/util/error'
import { userMessage } from '@codebuff/common/util/messages'

import type { ProjectProfileReport } from '@codebuff/common/constants/project-profile'
import type {
  GetProjectProfileFn,
  ReportProjectProfileFn,
} from '@codebuff/common/types/contracts/database'
import type { PromptAiSdkStreamFn } from '@codebuff/common/types/contracts/llm'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { Message } from '@codebuff/common/types/messages/codebuff-message'

export const PROJECT_PROFILE_REPORT_TIMEOUT_MS = 90_000

export function shouldOfferProjectProfileTool(params: {
  costMode: string | undefined
  isRoot: boolean
  toolNames: readonly string[]
  getProjectProfile: GetProjectProfileFn | undefined
  reportProjectProfile: ReportProjectProfileFn | undefined
}): boolean {
  return (
    params.costMode === 'free' &&
    params.isRoot &&
    params.toolNames.includes('read_files') &&
    params.getProjectProfile !== undefined &&
    params.reportProjectProfile !== undefined
  )
}

export function parseProjectProfileToolInput(
  input: unknown,
): ProjectProfileReport | 'not_enough_context' | null {
  const parsed =
    toolParams[PROJECT_PROFILE_TOOL_NAME].inputSchema.safeParse(input)
  if (!parsed.success) return null
  if (parsed.data.status === 'not_enough_context') return 'not_enough_context'
  if (parsed.data.status === 'unchanged') return { changed: false }
  if (!parsed.data.app_kinds?.length || !parsed.data.technologies) return null
  return {
    changed: true,
    appKinds: [...new Set(parsed.data.app_kinds)],
    technologies: parsed.data.technologies,
  }
}

export async function runProjectProfileReport(params: {
  history: Message[]
  getProjectProfile: GetProjectProfileFn
  reportProjectProfile: ReportProjectProfileFn
  stream: (
    messages: Message[],
    signal: AbortSignal,
  ) => ReturnType<PromptAiSdkStreamFn>
  logger: Logger
}): Promise<void> {
  const { logger } = params
  const signal = AbortSignal.timeout(PROJECT_PROFILE_REPORT_TIMEOUT_MS)
  try {
    const state = await params.getProjectProfile({ logger, signal })
    if (!state?.due) return

    const stream = params.stream(
      [
        ...params.history,
        userMessage({ content: buildProjectProfileRequest(state.profile) }),
      ],
      signal,
    )
    let answer: ReturnType<typeof parseProjectProfileToolInput> = null
    for (;;) {
      const next = await stream.next()
      if (next.done) break
      const chunk = next.value
      if (chunk.type === 'error') throw new Error(chunk.message)
      if (
        chunk.type === 'tool-call' &&
        chunk.toolName === PROJECT_PROFILE_TOOL_NAME &&
        answer === null
      ) {
        answer = parseProjectProfileToolInput(chunk.input)
      }
    }

    if (!answer) {
      logger.warn(
        { metric: 'project_profile_report_missing' },
        'Project profile request returned no valid report',
      )
      return
    }
    if (answer === 'not_enough_context') return
    await params.reportProjectProfile({ report: answer, logger, signal })
  } catch (error) {
    logger.warn(
      { error: getErrorObject(error), metric: 'project_profile_report_failed' },
      'Project profile report failed',
    )
  }
}
