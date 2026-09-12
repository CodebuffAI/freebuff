import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'

interface SkillsPanelState {
  /** The skills panel takes the composer's place while open, the way the
   *  queue panel and review screen do — the skill list is what the user is
   *  "typing about". */
  skillsPanelOpen: boolean
  openSkillsPanel: () => void
  closeSkillsPanel: () => void
}

export const useSkillsPanelStore = create<SkillsPanelState>()(
  immer((set) => ({
    skillsPanelOpen: false,
    openSkillsPanel: () => {
      set((state) => {
        state.skillsPanelOpen = true
      })
    },
    closeSkillsPanel: () => {
      set((state) => {
        state.skillsPanelOpen = false
      })
    },
  })),
)
