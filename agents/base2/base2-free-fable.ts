import { FREEBUFF_FABLE_5_1_MODEL_ID } from '@codebuff/common/constants/freebuff-models'

import { createBase2 } from './base2'

/** Fable 5.1 trace campaign: base2 delegates exploration and reviews with
 *  Fable 5.1. Capacity and the one-per-user limit are enforced at admission. */
const definition = {
  ...createBase2('free', {
    model: FREEBUFF_FABLE_5_1_MODEL_ID,
    // Live runs ended on follow-up cards without a written answer. Keep
    // questions and delegation, but omit the optional cards and their prompt.
    noFollowups: true,
  }),
  id: 'base2-free-fable',
  displayName: 'Buffy the Claude Fable 5.1 Free Orchestrator',
  stepPrompt: `Continue working on the user's request. If the task is complete, write your answer in ordinary assistant text, summarizing the subagents' findings and citing source URLs for research.`,
}

export default definition
