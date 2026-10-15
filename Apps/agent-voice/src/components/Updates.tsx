import { useState } from 'react'
import * as api from '../lib/api'
import { useStore } from '../state/store'
import type { UpdateView } from '../lib/types'

/** Release updates: check the feed, then download and install. */
export default function Updates() {
  const note = useStore((s) => s.note)
  const [status, setStatus] = useState<string | null>(null)
  const [update, setUpdate] = useState<UpdateView | null>(null)
  const [busy, setBusy] = useState(false)

  const check = async () => {
    setBusy(true)
    setStatus(null)
    try {
      const result = await api.checkForUpdate()
      setUpdate(result)
      setStatus(
        result.available
          ? `Version ${result.version} is available.`
          : `You are on the latest version (${result.version}).`,
      )
    } catch (e) {
      note(api.errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const install = async () => {
    setBusy(true)
    try {
      await api.installUpdate()
      setStatus('Update installed — restart to finish.')
    } catch (e) {
      note(api.errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card">
      <h2>Updates</h2>
      <p className="muted">
        Updates are signed by the release key and verified before anything is
        installed.
      </p>
      {update?.notes && <p className="notes">{update.notes}</p>}
      {status && <p className="muted">{status}</p>}
      <div className="row end">
        <button className="ghost" onClick={() => void check()} disabled={busy}>
          Check for updates
        </button>
        {update?.available && (
          <button onClick={() => void install()} disabled={busy}>
            Install {update.version}
          </button>
        )}
      </div>
    </section>
  )
}
