import { create } from 'zustand'

import {
  getSelectedFreebuffModel,
  persistFreebuffModelPick,
} from './freebuff-model-store'
import { useFreebuffSessionStore } from './freebuff-session-store'

import type { FreebuffSessionResponse } from '../types/freebuff-session'

export type ChatAdmission = {
  phase: 'requested' | 'confirm' | 'starting' | 'failed'
  model: string
  message?: string
  previousSession?: FreebuffSessionResponse | null
  metadataChecked?: boolean
  /** A refusal whose way out is another model (too few hours, a spent
   *  session limit): Enter opens the picker instead of retrying it. */
  chooseModel?: boolean
}

/** Choosing a model is a preference. Only submitting a message admits it. */
export const useFreebuffChatStore = create<{
  pickerOpen: boolean
  pickerInitialView: 'model' | 'reasoning'
  nextModel: string | null
  admission: ChatAdmission | null
}>(() => ({
  pickerOpen: false,
  pickerInitialView: 'model',
  nextModel: null,
  admission: null,
}))

/** Only an admission POST in flight holds the model. One waiting on a busy
 *  queue, a confirmation or a refusal can still change it. */
function admissionInFlight() {
  return useFreebuffChatStore.getState().admission?.phase === 'starting'
}

function openFreebuffPicker(initialView: 'model' | 'reasoning') {
  if (admissionInFlight()) return
  useFreebuffChatStore.setState({
    pickerOpen: true,
    pickerInitialView: initialView,
  })
}

export function openFreebuffModelPicker() {
  openFreebuffPicker('model')
}

export function openFreebuffReasoningPicker() {
  openFreebuffPicker('reasoning')
}

export function selectFreebuffChatModel(model: string) {
  if (admissionInFlight()) return
  persistFreebuffModelPick(model)
  const waiting = useFreebuffChatStore.getState().admission !== null
  useFreebuffChatStore.setState({
    nextModel: model,
    pickerOpen: false,
    // The held message goes out on the new pick, asked about afresh.
    ...(waiting ? { admission: { phase: 'requested', model } } : {}),
  })
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
