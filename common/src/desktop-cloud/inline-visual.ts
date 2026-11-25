/**
 * Inline visuals: the small charts, tables, calculators and flows a reply draws inside the chat
 * message, written by the model as OpenUI Lang in an `openui` fence.
 *
 * An inline visual is for a quick look. It lives in its message, has no revisions and is never
 * shared. Work the user keeps, edits or shares is an artifact; "Save as artifact" turns a visual
 * into one (`InlineVisualArtifactMapper`).
 *
 * This file is the one source of the building blocks: their names, props and limits. The server
 * builds the model's prompt from it and the app builds its renderer from it, each handing in its
 * own OpenUI kit (`InlineVisualCatalog`), so this package depends on no OpenUI package. zod only:
 * no React, no DOM.
 */

import { z } from 'zod/v4'
import { CHART_LIMITS, CHART_TYPES, chartSpecSchema, type ChartSpec } from './artifact-kinds/chart'
import { parseDashboard, type Dashboard } from './artifact-kinds/data'
import { evaluateCalc, parseCalc } from './artifact-kinds/data-calc'
import { boardSchema, type WhiteboardBoard, type WhiteboardElement } from './artifact-kinds/whiteboard'
import { geometryContext } from './artifact-kinds/whiteboard-geometry'
import { tidyElements } from './artifact-kinds/whiteboard-layout'

/** The fence's info string: ```openui */
export const INLINE_VISUAL_FENCE = 'openui'

export const INLINE_VISUAL_LIMITS = {
  chartRows: 100,
  tableRows: 50,
  tableColumns: 8,
  stats: 8,
  flowNodes: 16,
  flowEdges: 24,
  options: 5,
  /** About how many steps a plot takes across its x range (the step is rounded to a tidy number). */
  plotSteps: 60,
  /** Characters of one visual's source; a longer block is shown as text. */
  sourceChars: 12_000,
} as const

export const FLOW_NODE_KINDS = ['step', 'start', 'end', 'decision'] as const

const text = z.string().max(400)
const short = z.string().max(120)
const cell = z.union([z.string().max(400), z.number().finite()])

const statSchema = z.object({ label: short, value: cell, note: short.optional() })
const flowNodeSchema = z.object({ id: z.string().min(1).max(40), label: short, kind: z.enum(FLOW_NODE_KINDS).optional() })
const flowEdgeSchema = z.object({ from: z.string().max(40), to: z.string().max(40), label: z.string().max(40).optional() })

export type InlineStat = z.infer<typeof statSchema>
export type InlineFlow = { nodes: Array<z.infer<typeof flowNodeSchema>>; edges: Array<z.infer<typeof flowEdgeSchema>> }
export type InlineTable = { columns: string[]; rows: Array<Array<string | number>> }
export type InlinePlot = { expr: string; xMin: number; xMax: number; params?: Record<string, number>; title?: string }

/** What a drawn block hands to "Save as artifact": its values as the reader sees them now. */
export type InlineVisualSaveItem =
  | { kind: 'chart'; spec: ChartSpec }
  | { kind: 'stats'; items: InlineStat[] }
  | { kind: 'table'; table: InlineTable }
  | { kind: 'flow'; flow: InlineFlow }

export const INLINE_VISUAL_BLOCKS = [
  'Stack', 'Row', 'Card', 'Tabs', 'Tab',
  'Text', 'Stats', 'Table', 'Chart', 'Plot', 'Flow',
  'NumberField', 'Slider', 'Select', 'Toggle',
] as const
export type InlineVisualBlock = (typeof INLINE_VISUAL_BLOCKS)[number]

/**
 * The OpenUI functions a catalog is built with. `@openuidev/lang-core` (server) and
 * `@openuidev/react-lang` (app) both fit; `C` is whatever that kit draws a block with.
 */
export type InlineVisualKit<C, L> = {
  // The kits type props by their own zod generics; the catalog only passes schemas through.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  defineComponent(config: { name: string; description: string; props: any; component: C }): { ref: z.core.$ZodType }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createLibrary(input: { components: any[]; root: string }): L
  /** Marks a prop as two-way bound to a `$variable`. */
  reactive<T extends z.ZodType>(schema: T): z.core.$ZodType
}

/**
 * Builds the OpenUI library of Freebuff's blocks. Prop order is the model's argument order
 * (OpenUI Lang arguments are positional), so required props come first and never move.
 */
export class InlineVisualCatalog<C, L> {
  constructor(private readonly kit: InlineVisualKit<C, L>) {}

  build(renderers: Record<InlineVisualBlock, C>): L {
    const { defineComponent, createLibrary, reactive } = this.kit
    const define = (name: InlineVisualBlock, description: string, props: z.ZodObject) =>
      defineComponent({ name, description, props, component: renderers[name] })

    const leaves = [
      define('Text', 'A line or short paragraph. tone "heading" for a title, "muted" for a caption.', z.object({
        text,
        tone: z.enum(['body', 'heading', 'muted']).optional(),
      })),
      define('Stats', 'A row of big numbers, each with a label. value may be an expression.', z.object({
        items: z.array(statSchema).min(1).max(INLINE_VISUAL_LIMITS.stats),
      })),
      define('Table', 'A small table. Each row has one cell per column.', z.object({
        columns: z.array(short).min(1).max(INLINE_VISUAL_LIMITS.tableColumns),
        rows: z.array(z.array(cell)).min(1).max(INLINE_VISUAL_LIMITS.tableRows),
      })),
      define('Chart', 'A bar, line or area chart. x names the row key on the x axis; every series key is a numeric row key.', z.object({
        type: z.enum(CHART_TYPES),
        x: short,
        series: z.array(z.object({ key: short, label: short })).min(1).max(CHART_LIMITS.series),
        data: z.array(z.record(z.string(), cell)).min(1).max(INLINE_VISUAL_LIMITS.chartRows),
        title: short.optional(),
      })),
      define('Plot', 'The curve of a formula of x. Write x as [x] and each parameter as {name}: "{a}*[x]^2 + {b}*[x] + {c}". ^ is power. params gives each name a number or a $variable.', z.object({
        expr: z.string().min(1).max(200),
        xMin: z.number(),
        xMax: z.number(),
        params: z.record(z.string(), z.number()).optional(),
        title: short.optional(),
      })),
      define('Flow', 'A flow diagram: steps and the arrows between them. An edge names two node ids.', z.object({
        nodes: z.array(flowNodeSchema).min(2).max(INLINE_VISUAL_LIMITS.flowNodes),
        edges: z.array(flowEdgeSchema).max(INLINE_VISUAL_LIMITS.flowEdges),
      })),
      define('NumberField', 'A number the reader types. Bind value to a $variable.', z.object({
        label: short,
        value: reactive(z.number()),
        min: z.number().optional(),
        max: z.number().optional(),
        step: z.number().optional(),
      })),
      define('Slider', 'A number the reader drags. Bind value to a $variable.', z.object({
        label: short,
        value: reactive(z.number()),
        min: z.number(),
        max: z.number(),
        step: z.number().optional(),
      })),
      define('Select', 'One choice from a short list. Bind value to a $variable holding one option.', z.object({
        label: short,
        value: reactive(z.string()),
        options: z.array(short).min(2).max(INLINE_VISUAL_LIMITS.options),
      })),
      define('Toggle', 'An on/off switch. Bind value to a $variable.', z.object({ label: short, value: reactive(z.boolean()) })),
    ]
    const leaf = leaves.map((block) => block.ref)
    const row = define('Row', 'Blocks side by side (inputs, or two small blocks).', z.object({ children: z.array(z.union(leaf)).min(1).max(4) }))
    const card = define('Card', 'A titled group of blocks.', z.object({
      title: short,
      children: z.array(z.union([...leaf, row.ref])).min(1).max(12),
    }))
    const tab = define('Tab', 'One tab of Tabs.', z.object({
      label: short,
      children: z.array(z.union([...leaf, row.ref, card.ref])).min(1).max(12),
    }))
    const tabs = define('Tabs', 'Two to five tabs; one shows at a time.', z.object({ items: z.array(tab.ref).min(2).max(5) }))
    const stack = define('Stack', 'The root: blocks top to bottom.', z.object({
      children: z.array(z.union([...leaf, row.ref, card.ref, tabs.ref])).min(1).max(12),
    }))
    return createLibrary({ components: [stack, row, card, tabs, tab, ...leaves], root: 'Stack' })
  }
}

/** Whether a chart spec draws something: the shared schema, plus keys that exist in the rows. */
export class InlineVisualChart {
  /** A series key no row holds as a number draws an empty chart, which reads as "no data". */
  static drawable(spec: ChartSpec): boolean {
    if (!chartSpecSchema.safeParse(spec).success) return false
    const has = (key: string, numeric: boolean) =>
      spec.data.some((row) => (numeric ? typeof row[key] === 'number' : row[key] !== undefined))
    return has(spec.x, false) && spec.series.every((series) => has(series.key, true))
  }
}

/** A plot's formula, sampled into chart rows. Pure: the same engine Data's calculated columns use. */
export class InlineVisualPlot {
  /** The chart of `plot`, or null when its formula does not parse or gives no finite point. */
  static chart(plot: InlinePlot): ChartSpec | null {
    const parsed = parseCalc(plot.expr)
    const { xMin, xMax } = plot
    if (!parsed.ok || !Number.isFinite(xMin) || !Number.isFinite(xMax) || xMin >= xMax) return null
    const params = Object.fromEntries(Object.entries(plot.params ?? {}).filter(([, value]) => Number.isFinite(value)))
    const step = InlineVisualPlot.step(xMax - xMin)
    const data: ChartSpec['data'] = []
    const point = (raw: number) => {
      const x = InlineVisualPlot.tidy(raw)
      const y = evaluateCalc(parsed.node, { x }, params)
      if (typeof y === 'number' && Number.isFinite(y)) data.push({ x, y: InlineVisualPlot.tidy(y) })
    }
    const steps = Math.floor((xMax - xMin) / step + 1e-9)
    for (let i = 0; i <= steps; i++) point(xMin + i * step)
    // A range the step does not divide still ends on its last x.
    if (xMin + steps * step < xMax - step * 1e-6) point(xMax)
    if (!data.length) return null
    return { type: 'line', ...(plot.title?.trim() ? { title: plot.title } : {}), x: 'x', series: [{ key: 'y', label: 'y' }], data }
  }

  /**
   * The x step for a range: the smallest of 1, 2, 2.5 or 5 times a power of ten that takes at
   * most `plotSteps` steps, so the axis reads -10, -9.5, -9 and never -9.67, -9.33.
   */
  private static step(range: number): number {
    const raw = range / INLINE_VISUAL_LIMITS.plotSteps
    const magnitude = 10 ** Math.floor(Math.log10(raw))
    const tidy = [1, 2, 2.5, 5, 10].find((factor) => factor * magnitude >= raw * (1 - 1e-9)) ?? 10
    return tidy * magnitude
  }

  /** Drops float noise (0.30000000000000004) from an axis label or a point. */
  private static tidy(value: number): number {
    return Number(value.toPrecision(10))
  }
}

/** Turns a visual's drawn blocks into the body of the artifact "Save as artifact" creates. */
export class InlineVisualArtifactMapper {
  /** Flows alone become a Whiteboard; anything with numbers becomes a Data dashboard. */
  static kindFor(items: readonly InlineVisualSaveItem[]): 'data' | 'whiteboard' | null {
    if (items.some((item) => item.kind !== 'flow')) return 'data'
    return items.length ? 'whiteboard' : null
  }

  /** A Data dashboard of the charts, numbers and tables, or null when it would not validate. */
  static toDataBody(title: string, items: readonly InlineVisualSaveItem[]): Dashboard | null {
    const sourceId = 'chat'
    const datasets: unknown[] = []
    const blocks: unknown[] = []
    items.forEach((item, index) => {
      if (item.kind === 'chart' && InlineVisualChart.drawable(item.spec)) {
        const keys = [item.spec.x, ...item.spec.series.map((series) => series.key)]
        const column = (key: string) => `c${keys.indexOf(key)}`
        const numericX = item.spec.data.every((row) => typeof row[item.spec.x] === 'number')
        datasets.push({
          id: `d${index}`,
          sourceId,
          columns: [
            { key: column(item.spec.x), label: item.spec.x, type: numericX ? 'number' : 'string' },
            ...item.spec.series.map((series) => ({ key: column(series.key), label: series.label || series.key, type: 'number' })),
          ],
          rows: item.spec.data.map((row) =>
            Object.fromEntries(keys.map((key, at) => {
              const value = row[key]
              return [column(key), at === 0 || typeof value === 'number' ? (value ?? null) : null]
            })),
          ),
        })
        blocks.push({
          kind: 'chart',
          id: `b${index}`,
          title: item.spec.title?.trim() || title,
          type: item.spec.type,
          datasetId: `d${index}`,
          x: column(item.spec.x),
          series: item.spec.series.map((series) => ({ key: column(series.key), label: series.label || series.key })),
          sourceId,
          size: 'full',
        })
      } else if (item.kind === 'stats') {
        item.items.forEach((stat, at) => {
          const id = `b${index}-${at}`
          blocks.push(
            typeof stat.value === 'number'
              ? { kind: 'kpi', id, label: stat.label || 'Value', value: { literal: stat.value }, format: 'number', sourceId, ...(stat.note ? { note: stat.note } : {}) }
              : { kind: 'text', id, markdown: `**${stat.label}:** ${stat.value}` },
          )
        })
      } else if (item.kind === 'table') {
        const { columns, rows } = item.table
        const numeric = columns.map((_, at) => rows.every((row) => typeof row[at] === 'number'))
        datasets.push({
          id: `d${index}`,
          sourceId,
          columns: columns.map((label, at) => ({ key: `c${at}`, label: label || `Column ${at + 1}`, type: numeric[at] ? 'number' : 'string' })),
          rows: rows.map((row) => Object.fromEntries(columns.map((_, at) => [`c${at}`, row[at] ?? null]))),
        })
        blocks.push({ kind: 'table', id: `b${index}`, title, datasetId: `d${index}` })
      }
    })
    if (!blocks.length) return null
    const parsed = parseDashboard({
      version: 1,
      title,
      layout: 'grid',
      sources: [{ id: sourceId, label: 'Chat reply' }],
      datasets,
      blocks,
    })
    return parsed.ok ? parsed.dashboard : null
  }

  /** A Whiteboard of the first flow, laid out left to right, or null when it would not validate. */
  static toWhiteboardBody(title: string, items: readonly InlineVisualSaveItem[]): WhiteboardBoard | null {
    const flow = items.find((item) => item.kind === 'flow')?.flow
    return flow ? InlineVisualArtifactMapper.flowBoard(title, flow) : null
  }

  /** The board a flow draws as: shapes and bound arrows, tidied as a flow. Also the inline picture. */
  static flowBoard(title: string, flow: InlineFlow): WhiteboardBoard | null {
    const shapeOf = { step: 'rect', start: 'pill', end: 'pill', decision: 'diamond' } as const
    const colourOf = { step: 'blue', start: 'green', end: 'green', decision: 'yellow' } as const
    const ids = new Map(flow.nodes.map((node, index) => [node.id, `n${index}`]))
    if (ids.size !== flow.nodes.length) return null
    const shapes: WhiteboardElement[] = flow.nodes.map((node, index) => {
      const kind = node.kind ?? 'step'
      // A row to start from; tidyElements places them by their arrows.
      return { type: 'shape', id: `n${index}`, kind: shapeOf[kind], x: index * 240, y: 0, w: 160, h: kind === 'decision' ? 120 : 80, text: node.label, color: colourOf[kind] }
    })
    const arrows: WhiteboardElement[] = flow.edges.flatMap((edge, index) => {
      const from = ids.get(edge.from)
      const to = ids.get(edge.to)
      if (!from || !to || from === to) return []
      return [{ type: 'arrow', id: `a${index}`, from: { elementId: from }, to: { elementId: to }, ...(edge.label ? { label: edge.label } : {}), style: 'solid', routing: 'elbow' }]
    })
    const board = boardSchema.safeParse({ version: 1, title, elements: [...shapes, ...arrows] })
    if (!board.success) return null
    return tidyElements(board.data, shapes.map((shape) => shape.id), 'flow', geometryContext(board.data.elements))
  }
}
