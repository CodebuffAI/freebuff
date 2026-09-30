import { useEffect } from 'react'

import { getAuthTokenDetails } from '../utils/auth'
import { IS_FREEBUFF } from '../utils/constants'
import { startFreebuffModelCatalog } from '../utils/freebuff-model-catalog'

/**
 * Keeps the server model catalog (docs/freebuff-model-catalog.md) for the
 * signed-in account while mounted. Must be called BEFORE `useFreebuffSession`
 * in the same component: effects run in order, and the session's first
 * request waits for the first catalog only if the fetch has already started.
 */
export function useFreebuffModelCatalog({
  enabled = true,
}: { enabled?: boolean } = {}): void {
  useEffect(() => {
    if (!IS_FREEBUFF || !enabled) return
    const { token } = getAuthTokenDetails()
    if (!token) return
    return startFreebuffModelCatalog(token)
  }, [enabled])
}
