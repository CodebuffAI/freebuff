import { create } from 'zustand'

import {
  getSelectedFreebuffModel,
  persistFreebuffModelPick,
} from './freebuff-model-store'
import { useFreebuffSessionStore } from './freebuff-session-store'

import type { FreebuffSessionResponse } from '../types/freebuff-session'
import type { FreebuffWalletSpendLimit } from '@codebuff/common/types/freebuff-session'

export type ChatAdmission = {
  phase: 'requested' | 'confirm' | 'starting' | 'failed'
  model: string
  message?: string
  previousSession?: FreebuffSessionResponse | null
  metadataChecked?: boolean
  walletSpendLimit?: FreebuffWalletSpendLimit
}

/** Choosing a model is a preference. Only submitting a message admits it. */
export const useFreebuffChatStore = create<{
  pickerOpen: boolean
  nextModel: string | null
  admission: ChatAdmission | null
}>(() => ({ pickerOpen: false, nextModel: null, admission: null }))

export function openFreebuffModelPicker() {
  if (useFreebuffChatStore.getState().admission) return
  useFreebuffChatStore.setState({ pickerOpen: true })
}

export function selectFreebuffChatModel(model: string) {
  if (useFreebuffChatStore.getState().admission) return
  persistFreebuffModelPick(model)
  useFreebuffChatStore.setState({ nextModel: model, pickerOpen: false })
}

export function freebuffChatModel() {
  return useFreebuffChatStore.getState().nextModel ?? getSelectedFreebuffModel()
}

export function freebuffChatNeedsAdmission() {
  const { session } = useFreebuffSessionStore.getState()
  return (
    session?.status !== 'active' ||
    (session?.status === 'active' && session.model !== freebuffChatModel())
  )
}

export function requestFreebuffChatAdmission() {
  const { admission } = useFreebuffChatStore.getState()
  if (admission && admission.phase !== 'failed') return
  useFreebuffChatStore.setState({
    admission: { phase: 'requested', model: freebuffChatModel() },
  })
}
