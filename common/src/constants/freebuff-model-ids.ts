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
 *  FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID, served by Pareto with DeepSeek's own
 *  API behind it (web/src/llm-api/deepseek-pareto.ts, 2026-10-24), never the
 *  rationed Luminal lane. Its own wire id because it is its own entitlement:
 *  one wire id per price is the rule, and this row is priced on DeepSeek's
 *  own peak and off-peak hours. */
export const FREEBUFF_DEEPSEEK_V4_FLASH_FAST_MODEL_ID =
  'deepseek/deepseek-v4-flash-fast'

/**
 * The fast-mode models. One owner for "is this fast mode": the DeepSeek
 * router's fast-mode lanes and the Luminal grant at admission both read
 * this, so a second fast-mode model is one line here. A fast-mode model IS
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
