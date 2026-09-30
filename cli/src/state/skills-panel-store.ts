import { create } from 'zustand'

interface SkillsPanelState {
  /** The skills panel takes the composer's place while open, the way the
   *  queue panel and review screen do — the skill list is what the user is
   *  "typing about". */
  skillsPanelOpen: boolean
  openSkillsPanel: () => void
  closeSkillsPanel: () => void
}

export const useSkillsPanelStore = create<SkillsPanelState>()((set) => ({
  skillsPanelOpen: false,
  openSkillsPanel: () => set({ skillsPanelOpen: true }),
  closeSkillsPanel: () => set({ skillsPanelOpen: false }),
}))
