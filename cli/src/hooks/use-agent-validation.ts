import { validateAgents } from '@codebuff/sdk'
import { useCallback, useState } from 'react'

import { loadAgentDefinitions } from '../utils/local-agent-registry'
import { hasSelectedByokConnection } from '../utils/byok'
import { IS_FREEBUFF } from '../utils/constants'
import { logger } from '../utils/logger'
import { filterNetworkErrors } from '../utils/validation-error-helpers'

import type { AgentDefinition } from '@codebuff/sdk'

export type ValidationError = {
  id: string
  message: string
}

export type ValidationCheckResult = {
  success: boolean
  errors: ValidationError[]
}

/** BYOK runs validate local agent definitions without sending them to Freebuff. */
export const shouldValidateAgentsRemotely = (
  isFreebuff = IS_FREEBUFF,
): boolean => !isFreebuff || !hasSelectedByokConnection()

/** Invoke SDK validation using the inference source selected when a send starts. */
export const validateSelectedAgentDefinitions = (
  agentDefinitions: AgentDefinition[],
  options?: { isFreebuff?: boolean },
) =>
  validateAgents(agentDefinitions, {
    remote: shouldValidateAgentsRemotely(options?.isFreebuff),
  })

type UseAgentValidationResult = {
  validationErrors: ValidationError[]
  isValidating: boolean
  validate: () => Promise<ValidationCheckResult>
}

/**
 * Hook that provides agent validation functionality.
 * Call validate() manually to trigger validation (e.g., on message send).
 */
export const useAgentValidation = (): UseAgentValidationResult => {
  const [validationErrors, setValidationErrors] = useState<ValidationError[]>(
    [],
  )
  const [isValidating, setIsValidating] = useState(false)

  // Validate agents and update state
  // Returns validation result with success status and any errors
  const validate = useCallback(async (): Promise<ValidationCheckResult> => {
    setIsValidating(true)

    try {
      const agentDefinitions = loadAgentDefinitions()

      // Read selection at send time so changing provider never leaves a stale
      // render using the hosted validation endpoint.
      const validationResult = await validateSelectedAgentDefinitions(
        agentDefinitions,
      )

      if (validationResult.success) {
        setValidationErrors([])
        return { success: true, errors: [] }
      } else {
        const filteredValidationErrors = filterNetworkErrors(
          validationResult.validationErrors,
        )
        setValidationErrors(filteredValidationErrors)
        return { success: false, errors: filteredValidationErrors }
      }
    } catch (error) {
      logger.error({ error }, 'Agent validation failed with exception')
      // Don't update validation errors on exception - keep previous state
      // Return failure to block message sending on validation errors
      return { success: false, errors: [] }
    } finally {
      setIsValidating(false)
    }
  }, [])

  return {
    validationErrors,
    isValidating,
    validate,
  }
}
