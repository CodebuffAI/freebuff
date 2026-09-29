import { pluralize } from '@codebuff/common/util/string'
import { useMemo } from 'react'


import { formatQueuedPreview } from '../utils/helpers'

import type { QueuedMessage } from './use-message-queue'

interface UseQueueUiParams {
  queuePaused: boolean
  queuedMessages: QueuedMessage[]
  separatorWidth: number
  terminalWidth: number
  /** A run the user's next plain message will be added to (steering). */
  steersRun?: boolean
}

/** Below this the title has no room for a second segment, so the expand hint
 *  is omitted rather than crowding out the preview itself. */
const HINT_MIN_WIDTH = 80

export const useQueueUi = ({
  queuePaused,
  queuedMessages,
  separatorWidth,
  terminalWidth,
  steersRun = false,
}: UseQueueUiParams) => {
  const queuedCount = queuedMessages.length
  const shouldShowQueuePreview = queuedCount > 0 && !queuePaused

  /** The composer's border title: what is queued, and how to expand it.
   *  Queuing is discoverable (you just type while it runs); editing what you
   *  queued is not, so the hint rides along with the preview. */
  const inputBoxTitle = useMemo(() => {
    let preview: string | undefined
    if (shouldShowQueuePreview) {
      preview = formatQueuedPreview(
        queuedMessages,
        Math.max(30, separatorWidth - 20),
      )
    } else if (queuePaused && queuedCount > 0) {
      preview = `⏸ ${pluralize(queuedCount, 'message')} queued — your next message sends first`
    }

    if (!preview) return undefined
    if (terminalWidth < HINT_MIN_WIDTH) return ` ▸ ${preview} `
    return ` ▸ ${preview}   click to expand `
  }, [
    shouldShowQueuePreview,
    queuePaused,
    queuedCount,
    queuedMessages,
    separatorWidth,
    terminalWidth,
  ])

  const inputPlaceholder = useMemo(() => {
    const base =
      terminalWidth < 65
        ? 'Enter a coding task'
        : 'Enter a coding task or / for commands'

    if (queuePaused && queuedCount > 0) {
      return 'Ctrl-C to cancel queued messages'
    }

    // Mid-run, Enter adds the message to the running task rather than
    // queueing a new one (the router's steering path). Say so: users expected
    // a queue and read the agent answering it as their first task skipped.
    // With messages already queued, a submit queues too, so no hint then.
    if (steersRun && queuedCount === 0) {
      return terminalWidth < 65
        ? 'Add to the current task'
        : 'Add to the current task (/ for commands)'
    }

    return base
  }, [queuePaused, queuedCount, terminalWidth, steersRun])

  return {
    queuedCount,
    shouldShowQueuePreview,
    inputBoxTitle,
    inputPlaceholder,
  }
}
