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
  setSelected: (connection: SelectedByokConnection | undefined) => void
}

/** React-visible selection, initialized once from the non-secret settings file. */
export const useByokSelectionStore = create<ByokSelectionStore>((set) => ({
  selected: loadSettings().byokConnection,
  setSelected: (selected) => set({ selected }),
}))

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
