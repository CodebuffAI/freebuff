/**
 * The chart spec shared by artifact kinds: the JSON a Docs ```chart block holds,
 * and the `chart` of a slide. Pure (zod only), so the server validates a body
 * with exactly the rules the app draws by.
 *
 *   { "type": "bar" | "line" | "area", "title"?: string, "x": "<row key for the x axis>",
 *     "series": [{ "key": "<row key>", "label": "<legend label>" }],   // 1-8, unique, not x
 *     "data": [{ "<x>": "Week 1", "<series key>": 40 }, ...] }           // 1-500 rows
 *
 * Every row has the x key; every value is a string or a finite number, and
 * series values are numbers. Docs strips legacy metadata on series entries before
 * validating fenced JSON with this schema. Stored slide charts use the strict schema directly.
 *
 * Sheet charts (a range of cells) and data charts (a dataset's columns) are not
 * this spec: sheet.ts shares `CHART_TYPES`, data.ts the series limit.
 */

import { z } from 'zod/v4'

export const CHART_TYPES = ['bar', 'line', 'area'] as const
export type ChartSpecType = (typeof CHART_TYPES)[number]

export const CHART_LIMITS = { series: 8, rows: 500 } as const

export type ChartSpec = {
  type: ChartSpecType
  title?: string
  /** The key in each row that labels the x axis. */
  x: string
  series: Array<{ key: string; label: string }>
  data: Array<Record<string, string | number>>
}

const chartCell = z.union([z.string(), z.number().finite()])

export const chartSpecSchema = z
  .strictObject({
    type: z.enum(CHART_TYPES),
    title: z.string().optional(),
    x: z.string().refine((v) => v.trim() !== '', 'x must name a row key'),
    series: z
      .array(
        z.strictObject({
          key: z.string().refine((v) => v.trim() !== '', 'series key is empty'),
          label: z.string(),
        }),
      )
      .min(1)
      .max(CHART_LIMITS.series),
    data: z.array(z.record(z.string(), chartCell)).min(1).max(CHART_LIMITS.rows),
  })
  .superRefine((spec, ctx) => {
    const keys = new Set<string>()
    spec.series.forEach((s, i) => {
      if (s.key === spec.x || keys.has(s.key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['series', i, 'key'],
          message: 'series keys must be unique and differ from x',
        })
      }
      keys.add(s.key)
    })
    spec.data.forEach((row, i) => {
      if (!(spec.x in row)) {
        ctx.addIssue({ code: 'custom', path: ['data', i], message: `row lacks "${spec.x}"` })
      }
      for (const key of keys) {
        if (key in row && typeof row[key] !== 'number') {
          ctx.addIssue({
            code: 'custom',
            path: ['data', i, key],
            message: 'series values must be numbers',
          })
        }
      }
    })
  })

// The schema's output is exactly the spec type.
type _SpecFits = z.infer<typeof chartSpecSchema> extends ChartSpec ? true : never
const _specFits: _SpecFits = true
void _specFits
