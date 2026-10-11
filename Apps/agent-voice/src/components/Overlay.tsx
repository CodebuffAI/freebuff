import { useEffect, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { getAudioLevel } from '../lib/api'
import { describeEvent, formatDuration } from '../lib/format'
import { useStore } from '../state/store'

/** Always-on-top overlay: listening → processing → done. */
export default function Overlay() {
  const lastEvent = useStore((s) => s.lastEvent)
  const handleDictation = useStore((s) => s.handleDictation)
  const [level, setLevel] = useState(0)

  useEffect(() => {
    const unlisten = listen<Parameters<typeof handleDictation>[0]>(
      'dictation',
      (e) => handleDictation(e.payload),
    )
    return () => {
      void unlisten.then((f) => f())
    }
  }, [handleDictation])

  // Poll the mic level only while we are actually recording.
  const listening = lastEvent?.phase === 'listening'
  const raf = useRef<number | null>(null)
  useEffect(() => {
    if (!listening) {
      setLevel(0)
      return
    }
    let cancelled = false
    const tick = async () => {
      try {
        const value = await getAudioLevel()
        if (!cancelled) setLevel(value)
      } catch {
        // The command is unavailable before setup finishes; retry next frame.
      }
      if (!cancelled) raf.current = requestAnimationFrame(() => void tick())
    }
    void tick()
    return () => {
      cancelled = true
      if (raf.current !== null) cancelAnimationFrame(raf.current)
    }
  }, [listening])

  const phase = lastEvent?.phase ?? 'idle'
  const message = lastEvent ? describeEvent(lastEvent) : ''
  const busy = phase === 'processing'
  const failed = phase === 'error' || phase === 'blocked'

  return (
    <div className="overlay" data-phase={phase}>
      <div className="overlay-card">
        <div className="overlay-head">
          {listening && (
            <span className="overlay-meter" aria-hidden="true">
              <span
                style={{ transform: `scaleX(${Math.min(1, level * 4)})` }}
              />
            </span>
          )}
          <span className="overlay-phase">
            {listening
              ? 'Listening'
              : busy
                ? 'Transcribing'
                : failed
                  ? 'Stopped'
                  : phase === 'done'
                    ? 'Done'
                    : 'agent-voice'}
          </span>
        </div>
        {message && <p className="overlay-message">{message}</p>}
        {lastEvent?.remaining_seconds !== undefined && (
          <p className="overlay-meta">
            {formatDuration(lastEvent.remaining_seconds)} left today
          </p>
        )}
        <p className="overlay-hint">
          {listening
            ? 'Release the hotkey to send'
            : 'Hold Ctrl+Shift+Space to talk'}
        </p>
      </div>
    </div>
  )
}
