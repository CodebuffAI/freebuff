import { useState } from 'react'
import { useStore } from '../state/store'
import { formatExpiry } from '../lib/format'

/** Paste-a-license-key activation, plus the Pro status line. */
export default function LicenseForm() {
  const state = useStore((s) => s.state)
  const activate = useStore((s) => s.activate)
  const deactivate = useStore((s) => s.deactivate)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)

  if (!state) return null
  const { entitlement } = state

  if (entitlement.activated) {
    return (
      <section className="card">
        <h2>License</h2>
        <p className="pro-line">
          <strong>Pro active</strong>
          {entitlement.key_masked ? ` · ${entitlement.key_masked}` : ''}
          {formatExpiry(entitlement.expires_at)
            ? ` · valid until ${formatExpiry(entitlement.expires_at)}`
            : ''}
        </p>
        <button
          className="ghost"
          onClick={() => void deactivate()}
          disabled={busy}
        >
          Deactivate this device
        </button>
      </section>
    )
  }

  return (
    <section className="card">
      <h2>License</h2>
      <p className="muted">
        Free includes local transcription with 30 minutes a day. Pro unlocks
        unlimited minutes and the large-v3-turbo model for a one-time $59.
      </p>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault()
          const trimmed = key.trim()
          if (!trimmed) return
          setBusy(true)
          void activate(trimmed).finally(() => setBusy(false))
        }}
      >
        <input
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="PA-XXXX-XXXX-XXXX-XXXX"
          spellCheck={false}
          autoComplete="off"
          aria-label="License key"
        />
        <button type="submit" disabled={busy || !key.trim()}>
          Activate
        </button>
      </form>
    </section>
  )
}
