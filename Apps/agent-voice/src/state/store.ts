/** Single source of truth for the settings window: the backend `StateView`,
 *  a local draft of unsaved settings, and transient UI state. */

import { create } from 'zustand'
import * as api from '../lib/api'
import type { DictationEvent, Settings, StateView } from '../lib/types'

interface AppStore {
  state: StateView | null
  /** Edited copy of `state.settings`; saved explicitly by the user. */
  draft: Settings | null
  loading: boolean
  error: string | null
  upgrading: boolean
  /** Latest `dictation` event (overlay + settings status line). */
  lastEvent: DictationEvent | null

  refresh: () => Promise<void>
  setDraft: (patch: Partial<Settings>) => void
  save: () => Promise<void>
  activate: (licenseCode: string) => Promise<void>
  deactivate: () => Promise<void>
  revalidate: () => Promise<void>
  download: (id: string) => Promise<void>
  remove: (id: string) => Promise<void>
  setUpgrading: (open: boolean) => void
  note: (message: string | null) => void
  handleDictation: (event: DictationEvent) => void
}

function adopt(state: StateView) {
  return { state, draft: structuredClone(state.settings) }
}

export const useStore = create<AppStore>((set, get) => ({
  state: null,
  draft: null,
  loading: true,
  error: null,
  upgrading: false,
  lastEvent: null,

  refresh: async () => {
    try {
      const state = await api.getState()
      set({ ...adopt(state), loading: false, error: null })
    } catch (e) {
      set({ loading: false, error: api.errorMessage(e) })
    }
  },

  setDraft: (patch) => {
    const draft = get().draft
    if (!draft) return
    set({ draft: { ...draft, ...patch } })
  },

  save: async () => {
    const draft = get().draft
    if (!draft) return
    try {
      const state = await api.saveSettings(draft)
      set({ ...adopt(state), error: null })
    } catch (e) {
      set({ error: api.errorMessage(e) })
    }
  },

  activate: async (licenseCode) => {
    try {
      const state = await api.activateLicense(licenseCode)
      set({ ...adopt(state), error: null })
    } catch (e) {
      set({ error: api.errorMessage(e) })
    }
  },

  deactivate: async () => {
    try {
      const state = await api.deactivateLicense()
      set({ ...adopt(state), error: null })
    } catch (e) {
      set({ error: api.errorMessage(e) })
    }
  },

  revalidate: async () => {
    try {
      const state = await api.revalidateLicense()
      set({ ...adopt(state), error: null })
    } catch (e) {
      // Offline refresh keeps the cached entitlement — not worth a red banner.
      set({ error: null })
    }
  },

  download: async (id) => {
    try {
      await api.downloadModel(id)
    } catch (e) {
      set({ error: api.errorMessage(e) })
    }
  },

  remove: async (id) => {
    try {
      const state = await api.deleteModel(id)
      set({ ...adopt(state), error: null })
    } catch (e) {
      set({ error: api.errorMessage(e) })
    }
  },

  setUpgrading: (open) => set({ upgrading: open }),

  note: (message) => set({ error: message }),

  handleDictation: (event) => {
    set({ lastEvent: event })
    if (event.phase === 'done' || event.phase === 'error') {
      // Usage moved; pull the authoritative counters back from Rust.
      void get().refresh()
    }
  },
}))
