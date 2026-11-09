import { useStore } from '../state/store'
import { isValidMode, isValidTrigger } from '../lib/format'
import type { Mode, ProviderKind, Snippet, VocabEntry } from '../lib/types'

const PROVIDER_PRESETS: Record<
  ProviderKind,
  { base_url: string; model: string }
> = {
  openai: { base_url: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  anthropic: {
    base_url: 'https://api.anthropic.com',
    model: 'claude-3-5-haiku-latest',
  },
  // "Ollama" and any other OpenAI-compatible local server.
  openaicompatible: {
    base_url: 'http://localhost:11434/v1',
    model: 'llama3.1',
  },
}

const PROVIDER_LABELS: Record<ProviderKind, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  openaicompatible: 'Ollama / OpenAI-compatible',
}

const uid = () => Math.random().toString(36).slice(2, 10)

/** Pro-only panels: provider, modes, snippets, vocabulary. */
export default function ProFeatures({ visible }: { visible: boolean }) {
  const draft = useStore((s) => s.draft)
  const setDraft = useStore((s) => s.setDraft)
  const save = useStore((s) => s.save)
  const setUpgrading = useStore((s) => s.setUpgrading)

  if (!draft) return null
  if (!visible) {
    return (
      <section className="card locked">
        <h2>Pro features</h2>
        <p className="muted">
          Custom modes, snippets, vocabulary and AI cleanup are Pro-only. Keys
          stay on this machine — nothing is proxied through our servers.
        </p>
        <button onClick={() => setUpgrading(true)}>See what Pro adds</button>
      </section>
    )
  }

  const provider = draft.provider
  const patchProvider = (patch: Partial<NonNullable<typeof provider>>) => {
    const base = provider ?? {
      ...PROVIDER_PRESETS.openai,
      kind: 'openai' as ProviderKind,
      api_key: '',
    }
    setDraft({ provider: { ...base, ...patch } })
  }

  return (
    <>
      <section className="card">
        <h2>AI cleanup</h2>
        <p className="muted">
          Optional. A mode rewrites the raw transcript (fix punctuation, drop
          filler words) using your own key or a local model.
        </p>
        <label>
          Provider
          <select
            value={provider?.kind ?? ''}
            onChange={(e) => {
              const kind = e.target.value as ProviderKind | ''
              if (!kind) {
                setDraft({ provider: null })
                return
              }
              setDraft({
                provider: {
                  kind,
                  api_key: provider?.api_key ?? '',
                  ...PROVIDER_PRESETS[kind],
                },
              })
            }}
          >
            <option value="">Off (paste the raw transcript)</option>
            {(Object.keys(PROVIDER_LABELS) as ProviderKind[]).map((kind) => (
              <option key={kind} value={kind}>
                {PROVIDER_LABELS[kind]}
              </option>
            ))}
          </select>
        </label>
        {provider && (
          <>
            <label>
              Base URL
              <input
                value={provider.base_url}
                spellCheck={false}
                onChange={(e) => patchProvider({ base_url: e.target.value })}
              />
            </label>
            <label>
              API key
              <input
                type="password"
                value={provider.api_key}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => patchProvider({ api_key: e.target.value })}
              />
            </label>
            <label>
              Model
              <input
                value={provider.model}
                spellCheck={false}
                onChange={(e) => patchProvider({ model: e.target.value })}
              />
            </label>
          </>
        )}
      </section>

      <section className="card">
        <h2>Modes</h2>
        <p className="muted">
          A mode applies instructions to the transcript. Pick one manually or
          let the focused window title pick it for you.
        </p>
        <label>
          Active mode
          <select
            value={draft.mode_id ?? ''}
            onChange={(e) => setDraft({ mode_id: e.target.value || null })}
          >
            <option value="">Automatic (match by app)</option>
            {draft.modes.map((mode) => (
              <option key={mode.id} value={mode.id}>
                {mode.name || 'Untitled'}
              </option>
            ))}
          </select>
        </label>
        <ul className="rows">
          {draft.modes.map((mode, index) => {
            const patch = (next: Partial<Mode>) => {
              const modes = draft.modes.map((m, i) =>
                i === index ? { ...m, ...next } : m,
              )
              setDraft({ modes })
            }
            return (
              <li key={mode.id}>
                <div className="row">
                  <input
                    value={mode.name}
                    placeholder="Terminal, Commit message…"
                    onChange={(e) => patch({ name: e.target.value })}
                  />
                  <input
                    value={mode.app_match ?? ''}
                    placeholder="app title contains…"
                    onChange={(e) =>
                      patch({ app_match: e.target.value || null })
                    }
                  />
                  <button
                    className="ghost"
                    onClick={() =>
                      setDraft({
                        modes: draft.modes.filter((m) => m.id !== mode.id),
                      })
                    }
                  >
                    Remove
                  </button>
                </div>
                <textarea
                  value={mode.prompt}
                  rows={3}
                  placeholder="Instructions, e.g. keep it lowercase, no filler words"
                  onChange={(e) => patch({ prompt: e.target.value })}
                />
                {mode.name.trim() && !isValidMode(mode.name, mode.prompt) && (
                  <p className="error">
                    This mode needs instructions before it can run.
                  </p>
                )}
              </li>
            )
          })}
        </ul>
        <button
          onClick={() =>
            setDraft({
              modes: [
                ...draft.modes,
                {
                  id: uid(),
                  name: '',
                  prompt: '',
                  app_match: null,
                } satisfies Mode,
              ],
            })
          }
        >
          Add mode
        </button>
      </section>

      <section className="card">
        <h2>Snippets</h2>
        <p className="muted">
          Say the trigger, get the replacement — &quot;new line&quot; → ⏎.
        </p>
        <ul className="rows">
          {draft.snippets.map((snippet: Snippet, index: number) => {
            const patch = (next: Partial<Snippet>) => {
              setDraft({
                snippets: draft.snippets.map((s, i) =>
                  i === index ? { ...s, ...next } : s,
                ),
              })
            }
            const invalid = !isValidTrigger(snippet.trigger)
            return (
              <li key={snippet.id}>
                <div className="row">
                  <input
                    value={snippet.trigger}
                    placeholder="say…"
                    onChange={(e) => patch({ trigger: e.target.value })}
                  />
                  <input
                    value={snippet.replacement}
                    placeholder="types…"
                    onChange={(e) => patch({ replacement: e.target.value })}
                  />
                  <button
                    className="ghost"
                    onClick={() =>
                      setDraft({
                        snippets: draft.snippets.filter(
                          (s) => s.id !== snippet.id,
                        ),
                      })
                    }
                  >
                    Remove
                  </button>
                </div>
                {invalid && (
                  <p className="error">A trigger needs at least one word.</p>
                )}
              </li>
            )
          })}
        </ul>
        <button
          onClick={() =>
            setDraft({
              snippets: [
                ...draft.snippets,
                { id: uid(), trigger: '', replacement: '' } satisfies Snippet,
              ],
            })
          }
        >
          Add snippet
        </button>
      </section>

      <section className="card">
        <h2>Vocabulary</h2>
        <p className="muted">
          Fix names the model keeps getting wrong: spoken form → how it should
          be written.
        </p>
        <ul className="rows">
          {draft.vocabulary.map((entry: VocabEntry, index: number) => {
            const patch = (next: Partial<VocabEntry>) => {
              setDraft({
                vocabulary: draft.vocabulary.map((v, i) =>
                  i === index ? { ...v, ...next } : v,
                ),
              })
            }
            return (
              <li key={index}>
                <div className="row">
                  <input
                    value={entry.spoken}
                    placeholder="heard as…"
                    onChange={(e) => patch({ spoken: e.target.value })}
                  />
                  <input
                    value={entry.written}
                    placeholder="write as…"
                    onChange={(e) => patch({ written: e.target.value })}
                  />
                  <button
                    className="ghost"
                    onClick={() =>
                      setDraft({
                        vocabulary: draft.vocabulary.filter(
                          (_, i) => i !== index,
                        ),
                      })
                    }
                  >
                    Remove
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
        <button
          onClick={() =>
            setDraft({
              vocabulary: [...draft.vocabulary, { spoken: '', written: '' }],
            })
          }
        >
          Add word
        </button>
        <div className="row end">
          <button onClick={() => void save()}>Save Pro settings</button>
        </div>
      </section>
    </>
  )
}
