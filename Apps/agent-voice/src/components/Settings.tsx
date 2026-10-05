import { useEffect } from 'react'
import { listen } from '@tauri-apps/api/event'
import { useStore } from '../state/store'
import {
  formatBytes,
  formatDuration,
  isPro,
  remainingSeconds,
  usageFraction,
} from '../lib/format'
import LicenseForm from './LicenseForm'
import ProFeatures from './ProFeatures'

const LANGUAGES = [
  ['', 'Auto-detect'],
  ['en', 'English'],
  ['es', 'Spanish'],
  ['fr', 'French'],
  ['de', 'German'],
  ['pt', 'Portuguese'],
  ['it', 'Italian'],
  ['nl', 'Dutch'],
  ['ja', 'Japanese'],
  ['ko', 'Korean'],
  ['zh', 'Chinese'],
] as const

export default function Settings() {
  const state = useStore((s) => s.state)
  const draft = useStore((s) => s.draft)
  const setDraft = useStore((s) => s.setDraft)
  const save = useStore((s) => s.save)
  const refresh = useStore((s) => s.refresh)
  const download = useStore((s) => s.download)
  const remove = useStore((s) => s.remove)
  const setUpgrading = useStore((s) => s.setUpgrading)
  const error = useStore((s) => s.error)
  const note = useStore((s) => s.note)

  useEffect(() => {
    void refresh()
    const unlisten = listen<{
      id: string
      progress: number
      done: boolean
      error?: string
    }>('model-progress', (e) => {
      if (e.payload.error) note(e.payload.error)
      void refresh()
    })
    return () => {
      void unlisten.then((f) => f())
    }
  }, [refresh, note])

  if (!state || !draft) {
    return (
      <main className="shell">
        <p className="muted">{error ?? 'Loading…'}</p>
      </main>
    )
  }

  const pro = isPro(state)
  const left = remainingSeconds(state)
  const fraction = usageFraction(state)

  return (
    <main className="shell">
      <header>
        <h1>agent-voice</h1>
        <span className={`badge ${pro ? 'pro' : ''}`}>
          {pro ? 'Pro' : 'Free'}
        </span>
      </header>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <section className="card">
        <h2>Push to talk</h2>
        <label>
          Hotkey
          <input
            value={draft.hotkey}
            spellCheck={false}
            onChange={(e) => setDraft({ hotkey: e.target.value })}
            onBlur={() => void save()}
          />
        </label>
        <label>
          Language
          <select
            value={draft.language ?? ''}
            onChange={(e) => setDraft({ language: e.target.value || null })}
            onBlur={() => void save()}
          >
            {LANGUAGES.map(([code, label]) => (
              <option key={code} value={code}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <p className="muted">
          Audio is captured only while the hotkey is held and transcribed on
          this machine.
        </p>
      </section>

      <section className="card">
        <h2>Model</h2>
        <p className="muted">
          {left === null
            ? 'Unlimited transcription.'
            : `${formatDuration(left)} of ${formatDuration(state.usage.limit_seconds ?? 0)} left today.`}
        </p>
        <div className="meter" aria-hidden="true">
          <span style={{ width: `${Math.round(fraction * 100)}%` }} />
        </div>
        <ul className="models">
          {state.models.map((model) => {
            const locked = model.tier === 'pro' && !pro
            const busy = model.progress !== null
            return (
              <li key={model.id}>
                <label className="model-pick">
                  <input
                    type="radio"
                    name="model"
                    checked={draft.selected_model === model.id}
                    disabled={locked}
                    onChange={() => setDraft({ selected_model: model.id })}
                    onBlur={() => void save()}
                  />
                  <span>
                    {model.name} <em>{formatBytes(model.size_bytes)}</em>
                  </span>
                </label>
                {locked ? (
                  <button className="ghost" onClick={() => setUpgrading(true)}>
                    Upgrade to unlock
                  </button>
                ) : model.downloaded ? (
                  <button
                    className="ghost"
                    onClick={() => void remove(model.id)}
                  >
                    Delete
                  </button>
                ) : (
                  <button
                    disabled={busy}
                    onClick={() => void download(model.id)}
                  >
                    {busy
                      ? `${Math.round((model.progress ?? 0) * 100)}%`
                      : 'Download'}
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      </section>

      <ProFeatures visible={pro} />

      <LicenseForm />

      {pro && (
        <div className="row end">
          <button onClick={() => void save()}>Save changes</button>
        </div>
      )}
    </main>
  )
}
