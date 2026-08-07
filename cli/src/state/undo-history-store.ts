import { create } from 'zustand'

interface UndoHistoryStoreState {
  showUndoHistory: boolean
  showRedoHistory: boolean
}

interface UndoHistoryStoreActions {
  openUndoHistory: () => void
  closeUndoHistory: () => void
  openRedoHistory: () => void
  closeRedoHistory: () => void
  reset: () => void
}

type UndoHistoryStore = UndoHistoryStoreState & UndoHistoryStoreActions

const initialState: UndoHistoryStoreState = {
  showUndoHistory: false,
  showRedoHistory: false,
}

export const useUndoHistoryStore = create<UndoHistoryStore>()((set) => ({
  ...initialState,

  openUndoHistory: () => set({ showUndoHistory: true }),
  closeUndoHistory: () => set({ showUndoHistory: false }),
  openRedoHistory: () => set({ showRedoHistory: true }),
  closeRedoHistory: () => set({ showRedoHistory: false }),

  reset: () => set(initialState),
}))
