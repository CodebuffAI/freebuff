import { useState } from 'react'
import { useStore } from '../state/store'
import { formatExpiry } from '../lib/format'

/** Paste-a-license-code activation, plus the Pro status line. */
export default function LicenseForm() {
  const state = useStore((s) => s.state)
  const activate = useStore((s) => s.activate)
  const deactivate = useStore((s) => s.deactivate)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)

  if (!state) return null
  const { entitlement } = state

  if (entitlement.activated) {
    return (
      <section className="card">
        <h2>License</h2>
        <p className="pro-line">
          <strong>Pro active</strong>
          {entitlement.code_masked ? ` · ${entitlement.code_masked}` : ''}
          {formatExpiry(entitlement.expires_at)
            ? ` · valid until ${formatExpiry(entitlement.expires_at)}`
            : ''}
        </p>
        {entitlement.license_code ? (
          <p className="muted">
            Your license code is the <code>txn_…</code> id in your Paddle
            receipt. Copy it here to activate Pro on another machine.
            <br />
            <code className="license-code">
              {entitlement.license_code}
            </code>{' '}
            <button
              className="ghost"
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(entitlement.license_code ?? '')
                  .then(() => setCopied(true))
                  .catch(() => setCopied(false))
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </p>
        ) : null}
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
      <p className="muted">
        Already bought it? Paste the <code>txn_…</code> id from your Paddle
        receipt — buying in the app does this for you automatically.
      </p>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault()
          const trimmed = code.trim()
          if (!trimmed) return
          setBusy(true)
          void activate(trimmed).finally(() => setBusy(false))
        }}
      >
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="txn_…"
          spellCheck={false}
          autoComplete="off"
          aria-label="License code"
        />
        <button type="submit" disabled={busy || !code.trim()}>
          Activate
        </button>
      </form>
    </section>
  )
}
