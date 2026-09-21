import {
  createBunByokConnectionStore,
} from '@codebuff/sdk'
import { create } from 'zustand'

import { loadSettings, saveSettings } from './settings'

import type {
  ByokConnection,
  ByokConnectionStore,
  ResolvedByokConnection,
} from '@codebuff/sdk'

type SelectedByokConnection =
  Pick<ByokConnection, 'id' | 'revision'> &
  Partial<Pick<ByokConnection, 'provider' | 'model'>>

let store: ByokConnectionStore | undefined

type ByokSelectionStore = {
  selected: SelectedByokConnection | undefined
  /**
   * The user asked, from a Freebuff wall, to set up BYOK. `/byok` is a chat
   * command, and a user whose Freebucks are spent never reaches the chat: the
   * landing screen's refusal has no input. This opens the chat WITHOUT a
   * Freebuff session so the command can run; nothing but slash commands can
   * be sent until a connection is selected.
   */
  setupOpen: boolean
  setSelected: (connection: SelectedByokConnection | undefined) => void
  setSetupOpen: (open: boolean) => void
}

/** React-visible selection, initialized once from the non-secret settings file. */
export const useByokSelectionStore = create<ByokSelectionStore>((set) => ({
  selected: loadSettings().byokConnection,
  setupOpen: false,
  setSelected: (selected) => set({ selected }),
  setSetupOpen: (setupOpen) => set({ setupOpen }),
}))

export function openByokSetup(): void {
  useByokSelectionStore.getState().setSetupOpen(true)
}

export function closeByokSetup(): void {
  useByokSelectionStore.getState().setSetupOpen(false)
}

export function isByokSetupOpen(): boolean {
  return useByokSelectionStore.getState().setupOpen
}

/**
 * True when the chat may be shown without a Freebuff session: a connection is
 * selected, or the user is setting one up.
 */
export function useBypassesFreebuffSession(): boolean {
  return useByokSelectionStore(
    (state) => state.selected !== undefined || state.setupOpen,
  )
}

/**
 * CLI keys are deliberately environment references. A command may name an
 * environment variable, but it can never receive, echo, or persist its value.
 * The shared store keeps Desktop and CLI connection metadata together, while
 * the CLI's explicit `env:NAME` reference remains portable in SSH and
 * headless shells.
 */
export function getCliByokStore(): ByokConnectionStore {
  if (!store) {
    store = createBunByokConnectionStore()
  }
  return store
}

export function selectedByokConnection(): SelectedByokConnection | undefined {
  return useByokSelectionStore.getState().selected
}

export function hasSelectedByokConnection(): boolean {
  return selectedByokConnection() !== undefined
}

export function saveSelectedByokConnection(
  connection: ByokConnection | undefined,
): void {
  saveSettings(
    connection
      ? {
          byokConnection: {
            id: connection.id,
            revision: connection.revision,
            provider: connection.provider,
            model: connection.model,
          },
        }
      : { byokConnection: undefined },
  )
  // Selecting ends setup; turning BYOK off (or removing the selected
  // connection) returns the user to the Freebuff landing screen.
  closeByokSetup()
  useByokSelectionStore.getState().setSelected(
    connection
      ? {
          id: connection.id,
          revision: connection.revision,
          provider: connection.provider,
          model: connection.model,
        }
      : undefined,
  )
}

/** Resolve only at run start so the secret never reaches chat state or logs. */
export async function resolveByokConnection(
  selected: SelectedByokConnection,
): Promise<ResolvedByokConnection> {
  return getCliByokStore().resolve(selected)
}

export function describeByokConnection(connection: Pick<ByokConnection, 'name' | 'provider' | 'model'>): string {
  const provider = connection.provider === 'openrouter'
    ? 'OpenRouter'
    : 'OpenAI-compatible'
  return `${connection.name} (${provider} · ${connection.model})`
}

export function isByokEnvironmentVariableName(value: string): boolean {
  return /^[A-Z_][A-Z0-9_]*$/.test(value)
}

export function resetCliByokStoreForTests(): void {
  store = undefined
}

export function setCliByokStoreForTests(value: ByokConnectionStore | undefined): void {
  store = value
}
