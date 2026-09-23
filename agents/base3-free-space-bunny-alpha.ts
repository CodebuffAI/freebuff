import { FREEBUFF_SPACE_BUNNY_ALPHA_MODEL_ID } from '@codebuff/common/constants/freebuff-models'

import { createBase3CliRoot } from './base3'

/**
 * Buffy on Space Bunny Alpha (2026-09-23).
 *
 * No `reasoningOptions`, as on base3-free-ox-alpha: the endpoint makes
 * reasoning mandatory with a provider default of `max`, the catalog row names
 * `high`, and the server fills that in unless the user picked another rung.
 * An agent-declared reasoning would override the user's picker choice.
 */
const definition = {
  ...createBase3CliRoot({
    model: FREEBUFF_SPACE_BUNNY_ALPHA_MODEL_ID,
    isFreebuff: true,
  }),
  id: 'base3-free-space-bunny-alpha',
  displayName: 'Buffy on Space Bunny Alpha',
}

export default definition
