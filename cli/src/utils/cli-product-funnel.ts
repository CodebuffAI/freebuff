import { createHash, randomUUID } from 'node:crypto'

import { AnalyticsEvent } from '@codebuff/common/constants/analytics-events'
import {
  productFunnelEventSchema,
  type ProductFunnelEvent,
  type ProductFunnelProperties,
  type ProductFunnelStage,
  type ProductFunnelState,
} from '@codebuff/common/constants/product-funnel'

import { loadPackageVersion } from '../cli-args'
import { trackEvent } from './analytics'
import { IS_FREEBUFF } from './constants'

export function cliFunnelKey(value: string): string {
  return createHash('sha256').update(`cli-funnel:v1:${value}`).digest('hex')
}

export type CliFunnelDetails = ProductFunnelProperties

export function createCliFunnelCapture(deps: {
  enabled(): boolean
  flowId: string
  release(): string
  platform: string
  capture(properties: ProductFunnelEvent): boolean | void
}) {
  const seen = new Set<string>()
  return (
    stage: ProductFunnelStage,
    state: ProductFunnelState,
    details: CliFunnelDetails = {},
    once?: string,
  ): void => {
    try {
      if (!deps.enabled()) return
      const key = once ? `${stage}:${state}:${once}` : undefined
      if (key && seen.has(key)) return
      const parsed = productFunnelEventSchema.safeParse({
        ...details,
        product: 'cli',
        flow_id: deps.flowId,
        event_version: 1,
        entry_route: 'cli',
        surface: 'cli',
        observer: 'cli',
        funnel_stage: stage,
        funnel_state: state,
        release: deps.release(),
        platform: ['darwin', 'win32', 'linux'].includes(deps.platform)
          ? deps.platform
          : 'other',
      })
      if (!parsed.success) return
      if (deps.capture(parsed.data) === false) return
      if (key && seen.size < 500) seen.add(key)
    } catch {
      // Analytics can fail before initialization or while exiting.
    }
  }
}

/** Native launch identity is unrelated to fingerprints or browser auth flows. */
export const captureCliFunnel = createCliFunnelCapture({
  enabled: () => IS_FREEBUFF,
  flowId: randomUUID(),
  release: loadPackageVersion,
  platform: process.platform,
  capture: (properties) =>
    trackEvent(AnalyticsEvent.PRODUCT_FUNNEL_STEP, properties),
})
