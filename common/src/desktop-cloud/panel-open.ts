/**
 * What made a client open a Cloud workspace's panel (`POST activity?open=1&from=`), which can
 * restore an archived VM. The restore logs it as `panelOpen` (panel-resume.ts), so a VM created
 * with no run behind it is attributed to its trigger. An absent or unknown value is a `panel`.
 */
export const PANEL_OPEN_TRIGGERS = [
  'files',
  'editor',
  'terminal',
  'image',
  'mention',
  'download',
] as const

export type PanelOpenTrigger = (typeof PANEL_OPEN_TRIGGERS)[number]

export function panelOpenTrigger(value: string | null): PanelOpenTrigger | null {
  return (PANEL_OPEN_TRIGGERS as readonly string[]).includes(value ?? '')
    ? (value as PanelOpenTrigger)
    : null
}
