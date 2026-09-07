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
  const safeStep = params.step !== undefined && Number.isFinite(params.step) ? params.step : RESPONSE_AD_NODE_STEP
  const safeFirstAdAfterNodes = params.firstAdAfterNodes !== undefined && Number.isFinite(params.firstAdAfterNodes) ? params.firstAdAfterNodes : RESPONSE_AD_FIRST_NODE_COUNT
  const step = Math.max(1, safeStep)
  const firstAdAfterNodes = Math.max(1, safeFirstAdAfterNodes)
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
