import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react'
import type { AdReport } from '@codebuff/common/ads/ad-report'
import type { MouseEvent, RGBA } from '@opentui/core'

import { Clickable } from './clickable'
import { adReports, type AdReportRegistry } from '../ads/ad-reports'
import { useTheme } from '../hooks/use-theme'

export const AdReportRegistryContext = createContext(adReports)
export const AD_REPORT_CONTROL_COLUMNS = 16

/** A compact control that fits existing ad rows without changing their height. */
export function AdReportButton({
  ad,
  color,
  registry: suppliedRegistry,
}: {
  ad: AdReport
  color?: string | RGBA
  registry?: AdReportRegistry
}) {
  const theme = useTheme()
  const contextRegistry = useContext(AdReportRegistryContext)
  const registry = suppliedRegistry ?? contextRegistry
  const generation = useSyncExternalStore(
    registry.subscribe,
    registry.getGeneration,
  )
  const key = JSON.stringify(ad)
  const entry = useMemo(
    () => registry.register(JSON.parse(key) as AdReport),
    [registry, key, generation],
  )
  const pressed = useRef(false)
  useEffect(() => {
    entry.mounted++
    return () => {
      entry.mounted--
    }
  }, [entry])
  const status = useSyncExternalStore(
    (listener) => {
      entry.listeners.add(listener)
      return () => {
        entry.listeners.delete(listener)
      }
    },
    () => entry.status,
  )
  const label =
    status === 'sending'
      ? 'Sending…'
      : status === 'sent'
        ? 'Reported'
        : status === 'error'
          ? 'Retry'
          : 'Report'
  return (
    <Clickable
      onMouseDown={(event) => {
        ;(event as MouseEvent | undefined)?.stopPropagation()
        pressed.current = true
      }}
      onMouseUp={(event) => {
        ;(event as MouseEvent | undefined)?.stopPropagation()
        if (pressed.current) registry.open(entry)
        pressed.current = false
      }}
      onMouseOut={() => {
        pressed.current = false
      }}
      style={{ flexShrink: 0, height: 1 }}
    >
      <text style={{ fg: color ?? theme.muted, wrapMode: 'none' }}>
        {` [${label} ${entry.id}]`}
      </text>
    </Clickable>
  )
}
