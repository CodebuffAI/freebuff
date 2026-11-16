import { describe, expect, test } from 'bun:test'

import {
  ARTIFACT_RENDER_MAX_PIXELS,
  ARTIFACT_RENDER_MAX_WIDTH,
  fitRenderSize,
  parseRenderMeta,
  pngDimensions,
  renderMetaSegment,
  shrinkForBytes,
} from './artifact-render'

describe('render size caps', () => {
  test('the width is capped and the height follows the aspect', () => {
    expect(fitRenderSize(960, 540, 1280)).toMatchObject({ width: 1280, height: 720, cut: false })
    expect(fitRenderSize(3200, 1800, 4000)).toMatchObject({ width: ARTIFACT_RENDER_MAX_WIDTH, height: 900, cut: false })
  })
  test('a tall picture is cut to the pixel budget, never squeezed', () => {
    const size = fitRenderSize(1200, 9000, 1200)
    expect(size.width).toBe(1200)
    expect(size.width * size.height).toBeLessThanOrEqual(ARTIFACT_RENDER_MAX_PIXELS)
    expect(size.cut).toBe(true)
    expect(size.cropHeight).toBeCloseTo(size.height / size.scale)
  })
  test('the byte cap shrinks enough to fit in one step, and gives up below the minimum width', () => {
    expect(shrinkForBytes(1_000_000, 1_500_000, 1280)).toBeNull()
    const factor = shrinkForBytes(4_000_000, 1_500_000, 1280)!
    // Bytes scale with area: the next try is under the limit with margin.
    expect(4_000_000 * factor * factor).toBeLessThan(1_500_000)
    expect(shrinkForBytes(100_000_000, 1_500_000, 200)).toBeNull()
  })
})

test('the server reads a PNG size from its header and refuses anything else', () => {
  const bytes = new Uint8Array(40)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  new DataView(bytes.buffer).setUint32(16, 1280)
  new DataView(bytes.buffer).setUint32(20, 720)
  expect(pngDimensions(bytes)).toEqual({ width: 1280, height: 720 })
  expect(pngDimensions(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'.padEnd(40)))).toBeNull()
})

test('render meta survives the answer path segment', () => {
  const meta = { missingImages: 3, fontsMissing: true, hidden: false, cut: true }
  expect(parseRenderMeta(renderMetaSegment(meta))).toEqual(meta)
  expect(parseRenderMeta('m1f1h1c1/../x')).toBeNull()
})
