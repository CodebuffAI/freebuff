/** Thin typed wrappers over the Rust command surface. */

import { invoke } from '@tauri-apps/api/core'
import type { Settings, StateView, UpdateView } from './types'

export const getState = () => invoke<StateView>('get_state')

export const saveSettings = (settings: Settings) =>
  invoke<StateView>('save_settings', { settings })

export const activateLicense = (licenseCode: string) =>
  invoke<StateView>('activate_license', { licenseCode })

export const revalidateLicense = () => invoke<StateView>('revalidate_license')

export const deactivateLicense = () => invoke<StateView>('deactivate_license')

export const downloadModel = (id: string) =>
  invoke<void>('download_model', { id })

export const deleteModel = (id: string) =>
  invoke<StateView>('delete_model', { id })

export const getAudioLevel = () => invoke<number>('get_audio_level')

export const checkForUpdate = () => invoke<UpdateView>('check_for_update')

export const installUpdate = () => invoke<void>('install_update')

/** Normalize the stringified rejections Rust commands return as `Err`. */
export function errorMessage(e: unknown): string {
  if (typeof e === 'string') return e
  if (e instanceof Error) return e.message
  return 'unexpected error'
}
