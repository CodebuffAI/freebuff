/**
 * Stable Freebuff model identifiers that are safe to import from browser code.
 *
 * Keep this module dependency-free: the full Freebuff model catalog pulls in
 * server-side model configuration that is not part of the desktop renderer's
 * type environment.
 */
export const FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID = 'deepseek/deepseek-v4-flash'
export const FREEBUFF_DEEPSEEK_V4_PRO_MODEL_ID = 'deepseek/deepseek-v4-pro'
export const FREEBUFF_MINIMAX_M3_MODEL_ID = 'minimax/minimax-m3'
/** DeepSeek V4.1 Flash in FAST MODE: the same model as
 *  FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID, served ONLY by DeepSeek's own API
 *  (never the rationed Luminal lane) and run on the `base3-fast` harness,
 *  which fans work out to parallel worker subagents. Its own wire id because
 *  it is its own entitlement: one wire id per price is the rule, and this
 *  row is priced at three times Flash. */
export const FREEBUFF_DEEPSEEK_V4_FLASH_FAST_MODEL_ID =
  'deepseek/deepseek-v4-flash-fast'

/**
 * The models that run the base3-fast harness (agents/base3-fast.ts). One
 * owner for "is this fast mode": the DeepSeek router's single direct lane, the
 * Luminal grant at admission, and the Desktop harness all read this, so a
 * second fast-mode model is one line here. A fast-mode model IS
 * its base model to everything that follows the upstream model (price card,
 * output budget, image handling) and is NOT one to the two things that follow
 * the lane.
 */
export const FREEBUFF_FAST_MODE_MODEL_IDS: ReadonlySet<string> = new Set([
  FREEBUFF_DEEPSEEK_V4_FLASH_FAST_MODEL_ID,
])

export function isFreebuffFastModeModel(
  model: string | null | undefined,
): boolean {
  return !!model && FREEBUFF_FAST_MODE_MODEL_IDS.has(model)
}
