/** Pure display helpers shared by the settings window and the overlay.
 *  Kept free of Tauri imports so they can be unit tested with `bun test`. */

import type { DictationEvent, StateView, Tier } from './types'

/** `95` → `"1:35"`, `3675` → `"1:01:15"`. */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  const hours = Math.floor(s / 3600)
  const minutes = Math.floor((s % 3600) / 60)
  const seconds = s % 60
  const pad = (n: number) => n.toString().padStart(2, '0')
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${minutes}:${pad(seconds)}`
}

/** `1_620_000_000` → `"1.51 GB"`. */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value < 10 && unit > 0 ? value.toFixed(2) : Math.round(value)} ${units[unit]}`
}

/** Seconds of quota left today, or `null` when unlimited (Pro). */
export function remainingSeconds(state: StateView): number | null {
  const { used_seconds, limit_seconds } = state.usage
  if (limit_seconds === null) return null
  return Math.max(0, limit_seconds - used_seconds)
}

/** Fraction of the daily quota consumed, 0..1. Unlimited plans report 0. */
export function usageFraction(state: StateView): number {
  const { used_seconds, limit_seconds } = state.usage
  if (!limit_seconds) return 0
  return Math.min(1, used_seconds / limit_seconds)
}

export function isPro(state: StateView | null): boolean {
  return state?.entitlement.tier === ('pro' satisfies Tier)
}

/** Unix seconds → `2026-10-05`, or `null` when unset. */
export function formatExpiry(expiresAt: number | null): string | null {
  if (!expiresAt) return null
  return new Date(expiresAt * 1000).toISOString().slice(0, 10)
}

/** One-line explanation of a dictation event, shown in the overlay. */
export function describeEvent(event: DictationEvent): string {
  switch (event.phase) {
    case 'listening':
      return event.prompt ? `Agent asks: ${event.prompt}` : 'Listening…'
    case 'processing':
      return 'Transcribing…'
    case 'done':
      return event.text ?? ''
    case 'blocked':
      return event.remaining_seconds
        ? `Daily limit reached — ${formatDuration(event.remaining_seconds)} left`
        : 'Daily limit reached'
    case 'error':
      return event.error ?? 'Something went wrong'
  }
}

/** Trigger words must be non-empty and free of runs of whitespace. */
export function isValidTrigger(trigger: string): boolean {
  const trimmed = trigger.trim()
  return trimmed.length > 0 && !/\s{2,}/.test(trimmed)
}

/** A mode needs a name and instructions before it can be saved. */
export function isValidMode(name: string, prompt: string): boolean {
  return name.trim().length > 0 && prompt.trim().length > 0
}
