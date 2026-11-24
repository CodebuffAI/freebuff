import {
  AdReportReasonSchema,
  toAdReport,
  type AdReport,
} from '@codebuff/common/ads/ad-report'

export type AdReportStatus = 'idle' | 'sending' | 'error'
export type AdReportPrompt = Readonly<{
  ad: AdReport
  send: (ad: AdReport) => Promise<void>
  status: AdReportStatus
}>

/** The one open report form: which ad it reports, how it sends, and its status. */
export function createAdReportRegistry() {
  let prompt: AdReportPrompt | null = null
  const listeners = new Set<() => void>()
  const set = (next: AdReportPrompt | null) => {
    prompt = next
    for (const listener of listeners) listener()
  }
  return {
    open(ad: AdReport, send: AdReportPrompt['send']) {
      if (prompt) return
      // Copy only report fields; no answers, prompt or targeting context.
      const { reason: _reason, ...creative } = toAdReport(ad)
      set({ ad: creative, send, status: 'idle' })
    },
    cancel() {
      if (prompt?.status !== 'sending') set(null)
    },
    reset() {
      set(null)
    },
    async submit(reason: string) {
      if (!prompt || prompt.status === 'sending') return
      const explanation = AdReportReasonSchema.parse(reason)
      const sending: AdReportPrompt = { ...prompt, status: 'sending' }
      set(sending)
      try {
        await sending.send({ ...sending.ad, reason: explanation })
        if (prompt === sending) set(null)
      } catch {
        // A reset while sending (an account change) leaves the new state alone.
        if (prompt === sending) set({ ...sending, status: 'error' })
      }
    },
    getPrompt: () => prompt,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

export const adReports = createAdReportRegistry()
export type AdReportRegistry = ReturnType<typeof createAdReportRegistry>
