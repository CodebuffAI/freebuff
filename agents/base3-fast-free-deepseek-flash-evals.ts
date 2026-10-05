import { FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID } from '@codebuff/common/constants/freebuff-models'

import { createBase3FastCliRoot } from './base3-fast'

/**
 * base3-fast on DeepSeek V4.1 Flash — the fast-mode arm of the buffbench
 * comparison against `base3-free-deepseek-flash-evals`.
 *
 * Same model id, same `noAskUser`, same Freebuff branding as that arm; the
 * harness is the only difference. It runs the ordinary Flash id rather than
 * the fast-mode wire id for the reason the evals worker does (see
 * base3-fast-worker-deepseek-flash-evals.ts), and fans out to that worker.
 */
const definition = {
  ...createBase3FastCliRoot(FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID, {
    noAskUser: true,
    noWeb: true,
    workerAgentId: 'base3-fast-worker-deepseek-flash-evals',
  }),
  id: 'base3-fast-free-deepseek-flash-evals',
  displayName: 'Buffy on DeepSeek Flash (fast mode, evals)',
}

export default definition
