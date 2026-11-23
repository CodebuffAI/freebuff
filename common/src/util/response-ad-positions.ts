/**
 * Where to intersperse ads inside a streamed assistant response.
 *
 * Nodes are append-only while streaming, so an after-node index is a stable
 * anchor. Ads only occupy positions with a following node and never trail the
 * response.
 */

/** Rendered nodes before the first interspersed ad. */
export const RESPONSE_AD_FIRST_NODE_COUNT = 2

/** Rendered nodes between subsequent interspersed ads. */
export const RESPONSE_AD_NODE_STEP = 3

/** Number of non-trailing ad slots currently eligible in a response. */
export function responseAdSlotCount(params: {
  nodeCount: number
  step?: number
  firstAdAfterNodes?: number
}): number {
  const step = Math.max(1, params.step ?? RESPONSE_AD_NODE_STEP)
  const firstAdAfterNodes = Math.max(
    1,
    params.firstAdAfterNodes ?? RESPONSE_AD_FIRST_NODE_COUNT,
  )
  return Math.max(
    0,
    Math.floor((params.nodeCount - firstAdAfterNodes - 1) / step) + 1,
  )
}

/** After-node indices for up to `adCount` ads given the current node count. */
export function responseAdNodePositions(params: {
  nodeCount: number
  adCount: number
  step?: number
  firstAdAfterNodes?: number
}): number[] {
  const { nodeCount, adCount } = params
  const step = Math.max(1, params.step ?? RESPONSE_AD_NODE_STEP)
  const firstAdAfterNodes = Math.max(
    1,
    params.firstAdAfterNodes ?? RESPONSE_AD_FIRST_NODE_COUNT,
  )
  const positions: number[] = []
  const eligibleCount = Math.min(
    Math.max(0, adCount),
    responseAdSlotCount({ nodeCount, step, firstAdAfterNodes }),
  )
  for (let k = 0; k < eligibleCount; k++) {
    positions.push(firstAdAfterNodes - 1 + k * step)
  }
  return positions
}

/**
 * Inline cards a terminal client draws per answer when it places one card
 * after the answer's last content instead of interspersing cards between
 * nodes. A card in the middle of a long answer can be requested and never
 * scrolled to; the end of a finished answer is where the reader stops.
 */
export const RESPONSE_AD_END_SLOT_COUNT = 1

/**
 * Rendered nodes a completed answer needs before it gets an end-of-answer
 * card: the same floor as the first interspersed slot
 * ({@link responseAdSlotCount} is first non-zero at this node count), so a
 * short answer carries no card.
 */
export const RESPONSE_AD_END_MIN_NODE_COUNT = RESPONSE_AD_FIRST_NODE_COUNT + 1

/**
 * End-of-answer slots eligible right now: one once the answer has completed
 * with at least {@link RESPONSE_AD_END_MIN_NODE_COUNT} nodes, none while it is
 * still streaming or when it is shorter than that.
 */
export function responseAdEndSlotCount(params: {
  nodeCount: number
  isComplete: boolean
}): number {
  return params.isComplete && params.nodeCount >= RESPONSE_AD_END_MIN_NODE_COUNT
    ? RESPONSE_AD_END_SLOT_COUNT
    : 0
}
