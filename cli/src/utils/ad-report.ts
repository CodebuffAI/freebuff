import {
  AdReportReasonSchema,
  toAdReport,
  type AdReport,
} from '@codebuff/common/ads/ad-report'

import { FREEBUFF_WEB_URL } from '../login/constants'
import { getCliAdRequestUserAgent } from './ad-client-identity'
import { getAuthToken } from './auth'

/** Reporting never opens the ad destination or records a click. */
export function createAdReportClient(
  deps: {
    baseUrl?: string
    getToken?: () => string | null | undefined
    fetchImpl?: typeof fetch
  } = {},
) {
  return async (ad: AdReport, expectedToken?: string): Promise<void> => {
    const token = (deps.getToken ?? getAuthToken)()
    if (!token) throw new Error('Sign in to report this ad.')
    if (expectedToken !== undefined && token !== expectedToken) {
      throw new Error('The report account changed. Open a new report.')
    }
    const report = {
      ...toAdReport(ad),
      reason: AdReportReasonSchema.parse(ad.reason),
    }
    const response = await (deps.fetchImpl ?? fetch)(
      `${(deps.baseUrl ?? FREEBUFF_WEB_URL).replace(/\/+$/, '')}/api/ads/report`,
      {
        method: 'POST',
        redirect: 'error',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'user-agent': getCliAdRequestUserAgent(),
        },
        body: JSON.stringify(report),
        signal: AbortSignal.timeout(15_000),
      },
    )
    const result = await response.json().catch(() => null)
    if (!response.ok || result?.ok !== true) {
      throw new Error('Could not send the ad report. Try again.')
    }
  }
}

export const reportAd = createAdReportClient()
