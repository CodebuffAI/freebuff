/** The single upload format used by Desktop and the browser workspace. */
export const DICTATION_CONTENT_TYPE = 'audio/wav'
export const DICTATION_SAMPLE_RATE = 16_000
export const DICTATION_MAX_SECONDS = 120
export const DICTATION_WAV_HEADER_BYTES = 44
export const DICTATION_MAX_AUDIO_BYTES =
  DICTATION_WAV_HEADER_BYTES + DICTATION_SAMPLE_RATE * 2 * DICTATION_MAX_SECONDS

export type DictationResponse = { text: string }
