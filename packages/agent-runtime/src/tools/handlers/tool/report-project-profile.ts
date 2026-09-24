import type { CodebuffToolHandlerFunction } from '../handler-function-type'
import type {
  CodebuffToolCall,
  CodebuffToolOutput,
} from '@codebuff/common/tools/list'

export const handleReportProjectProfile = (async (params: {
  previousToolCallFinished: Promise<any>
  toolCall: CodebuffToolCall<'report_project_profile'>
}): Promise<{ output: CodebuffToolOutput<'report_project_profile'> }> => {
  await params.previousToolCallFinished
  return {
    output: [
      {
        type: 'json',
        value: {
          message:
            'Not requested. Do not call this tool unless explicitly asked.',
        },
      },
    ],
  }
}) satisfies CodebuffToolHandlerFunction<'report_project_profile'>
