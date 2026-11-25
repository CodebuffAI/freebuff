import { describe, expect, test } from 'bun:test'
import { parseDashboard } from './artifact-kinds/data'
import { boardSchema } from './artifact-kinds/whiteboard'
import { InlineVisualArtifactMapper, InlineVisualChart, InlineVisualPlot, type InlineVisualSaveItem } from './inline-visual'

// "Save as artifact" stores what these return: a body the artifact store refuses, or one that
// opens with the wrong numbers, is a saved artifact the user cannot use.

const chart: InlineVisualSaveItem = {
  kind: 'chart',
  spec: {
    type: 'bar',
    title: 'Life span',
    x: 'Country name',
    series: [{ key: 'Life span (years)', label: 'Life span' }],
    data: [
      { 'Country name': 'Japan', 'Life span (years)': 84 },
      { 'Country name': 'India', 'Life span (years)': 70 },
    ],
  },
}
const flow: InlineVisualSaveItem = {
  kind: 'flow',
  flow: {
    nodes: [
      { id: 'a', label: 'Start', kind: 'start' },
      { id: 'b', label: 'Paid?', kind: 'decision' },
      { id: 'c', label: 'Ship', kind: 'end' },
    ],
    edges: [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c', label: 'yes' },
      { from: 'b', to: 'missing' },
    ],
  },
}

describe('InlineVisualArtifactMapper', () => {
  test('a chart, numbers and a table save as a dashboard the Data kind accepts', () => {
    const body = InlineVisualArtifactMapper.toDataBody('Life span by country', [
      chart,
      { kind: 'stats', items: [{ label: 'Highest', value: 84 }, { label: 'Where', value: 'Japan' }] },
      { kind: 'table', table: { columns: ['Country', 'Years'], rows: [['Japan', 84], ['India', 70]] } },
    ])
    expect(body).not.toBeNull()
    expect(parseDashboard(body).ok).toBe(true)
    // Row keys with spaces are not valid column ids: the values must survive the renaming.
    expect(body!.datasets[0]!.rows).toEqual([{ c0: 'Japan', c1: 84 }, { c0: 'India', c1: 70 }])
    expect(body!.blocks.map((block) => block.kind)).toEqual(['chart', 'kpi', 'text', 'table'])
  })

  test('a flow saves as a board the Whiteboard kind accepts, without arrows to unknown nodes', () => {
    const board = InlineVisualArtifactMapper.toWhiteboardBody('Order flow', [flow])
    expect(board).not.toBeNull()
    expect(boardSchema.safeParse(board).success).toBe(true)
    expect(board!.elements.filter((element) => element.type === 'arrow')).toHaveLength(2)
  })

  test('flows alone go to a Whiteboard; anything with numbers goes to Data', () => {
    expect(InlineVisualArtifactMapper.kindFor([flow])).toBe('whiteboard')
    expect(InlineVisualArtifactMapper.kindFor([flow, chart])).toBe('data')
    expect(InlineVisualArtifactMapper.kindFor([])).toBeNull()
  })

  test('nothing saveable gives no body', () => {
    expect(InlineVisualArtifactMapper.toDataBody('x', [flow])).toBeNull()
    expect(InlineVisualArtifactMapper.toWhiteboardBody('x', [chart])).toBeNull()
  })
})

describe('InlineVisualPlot', () => {
  test('a parabola is sampled with its parameters', () => {
    const spec = InlineVisualPlot.chart({ expr: '{a}*[x]^2 + {c}', xMin: -3, xMax: 3, params: { a: 2, c: 1 } })
    expect(spec!.data).toHaveLength(61)
    expect(spec!.data[0]).toEqual({ x: -3, y: 19 })
    expect(spec!.data[30]).toEqual({ x: 0, y: 1 })
  })

  test('x steps are tidy numbers, and the range ends on its last x', () => {
    const xs = (xMin: number, xMax: number) => InlineVisualPlot.chart({ expr: '[x]', xMin, xMax })!.data.map((row) => row.x)
    expect(xs(-10, 10).slice(0, 3)).toEqual([-10, -9.5, -9])
    expect(xs(-10, 10)).toHaveLength(41)
    expect(xs(0, 7).at(-1)).toBe(7)
    expect(xs(0, 0.001).at(-1)).toBe(0.001)
  })

  test('a formula that does not parse, or an empty range, draws nothing', () => {
    expect(InlineVisualPlot.chart({ expr: 'x ** 2 +', xMin: 0, xMax: 1 })).toBeNull()
    expect(InlineVisualPlot.chart({ expr: '[x]', xMin: 2, xMax: 2 })).toBeNull()
  })
})

describe('InlineVisualChart', () => {
  test('a series key no row holds is not drawable, so the visual falls back to text', () => {
    const spec = { type: 'bar' as const, x: 'country', series: [{ key: 'years', label: 'Years' }], data: [{ country: 'Japan', life: 84 }] }
    expect(InlineVisualChart.drawable(spec)).toBe(false)
    expect(InlineVisualChart.drawable({ ...spec, series: [{ key: 'life', label: 'Years' }] })).toBe(true)
  })
})
