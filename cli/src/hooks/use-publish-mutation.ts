import { useMutation } from '@tanstack/react-query'
import { useShallow } from 'zustand/react/shallow'

import {
  handlePublish as defaultHandlePublish,
  type PublishResult,
} from '../commands/publish'
import { usePublishStore } from '../state/publish-store'

export interface UsePublishMutationDeps {
  handlePublish?: (agentIds: string[]) => Promise<PublishResult>
}

/**
 * Hook for publishing agents to the agent store
 * Uses TanStack Query mutation for proper state management
 */
export function usePublishMutation(deps: UsePublishMutationDeps = {}) {
  const { handlePublish = defaultHandlePublish } = deps

  const { setIsPublishing, setSuccessResult, setErrorResult } = usePublishStore(
    useShallow((state) => ({
      setIsPublishing: state.setIsPublishing,
      setSuccessResult: state.setSuccessResult,
      setErrorResult: state.setErrorResult,
    })),
  )

  return useMutation({
    mutationFn: async (agentIds: string[]) => {
      setIsPublishing(true)
      return handlePublish(agentIds)
    },
    onSuccess: (result) => {
      if (result.success && result.publisherId && result.agents) {
        setSuccessResult({
          publisherId: result.publisherId,
          agents: result.agents,
        })
      } else {
        setErrorResult({
          error: result.error || 'Unknown error',
          details: result.details,
          hint: result.hint,
        })
      }
    },
    onError: (error) => {
      setErrorResult({
        error: 'Publish failed',
        details: error instanceof Error ? error.message : String(error),
      })
    },
  })
}
