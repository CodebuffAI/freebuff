import { useState } from 'react'
import { openCheckout, paddleConfigFromEnv, closeCheckout } from '../lib/paddle'
import { useStore } from '../state/store'

/** Upgrade dialog: explains the one-time Pro purchase and opens checkout. */
export default function UpgradeDialog() {
  const open = useStore((s) => s.upgrading)
  const setUpgrading = useStore((s) => s.setUpgrading)
  const state = useStore((s) => s.state)
  const activate = useStore((s) => s.activate)
  const note = useStore((s) => s.note)
  const refresh = useStore((s) => s.refresh)
  const [busy, setBusy] = useState(false)

  if (!open || !state) return null

  const config = paddleConfigFromEnv(
    {
      VITE_PADDLE_TOKEN: import.meta.env.VITE_PADDLE_TOKEN,
      VITE_PADDLE_PRICE_ID: import.meta.env.VITE_PADDLE_PRICE_ID,
      VITE_PADDLE_ENV: import.meta.env.VITE_PADDLE_ENV,
    },
    state.device_id,
  )

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Upgrade to Pro"
    >
      <div className="modal">
        <h2>Upgrade to Pro — $59 once</h2>
        <ul className="ticks">
          <li>Unlimited dictation — no daily cap</li>
          <li>Whisper large-v3-turbo for far better accuracy</li>
          <li>Custom modes that clean up text per app</li>
          <li>Snippets and a personal vocabulary</li>
          <li>ask_user_by_voice for coding agents via MCP</li>
        </ul>
        <p className="muted">
          Audio is transcribed on this machine either way — upgrading never
          sends your voice anywhere.
        </p>
        {config ? (
          <div className="row end">
            <button className="ghost" onClick={() => setUpgrading(false)}>
              Not now
            </button>
            <button
              disabled={busy}
              onClick={() => {
                setBusy(true)
                openCheckout(config, (code) => {
                  closeCheckout()
                  setUpgrading(false)
                  // Paddle hands us the transaction id directly; the deep link
                  // is the fallback path when the browser swallows the event.
                  void activate(code)
                })
                  .then(() => refresh())
                  .catch((e: unknown) => {
                    note(e instanceof Error ? e.message : String(e))
                  })
                  .finally(() => setBusy(false))
              }}
            >
              {busy ? 'Opening checkout…' : 'Buy Pro'}
            </button>
          </div>
        ) : (
          <>
            <p className="muted">
              Checkout is not configured in this build. Set{' '}
              <code>VITE_PADDLE_TOKEN</code> and{' '}
              <code>VITE_PADDLE_PRICE_ID</code>, or activate a license you
              already bought.
            </p>
            <div className="row end">
              <button onClick={() => setUpgrading(false)}>Close</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
