/**
 * Freebuff Sheets — the workbook content model (version 1).
 *
 * ============================== FOR AN LLM AUTHOR ==============================
 * A workbook is ONE JSON object. Write it whole; every field not marked
 * optional is required. Unknown keys are rejected.
 *
 * {
 *   "version": 1,
 *   "title": "Q4 budget",                       // 1-200 chars
 *   "tabs": [                                   // 1-50 tabs, in display order
 *     {
 *       "id": "budget",                         // unique, [A-Za-z0-9_-], never shown
 *       "name": "Budget",                       // unique (case-insensitive), 1-31 chars,
 *                                               // none of \ / ? * [ ] : and no leading/trailing '
 *       "rows": 200,                            // optional row count (default 1000, max 50000)
 *       "cols": 12,                             // optional column count (default 26, max 200)
 *       "columns": [{ "width": 180 }, {}],      // optional, index 0 = column A; width in px (24-800)
 *       "frozenRows": 1,                        // optional: rows pinned at the top (0-20)
 *       "frozenCols": 1,                        // optional: columns pinned at the left (0-10)
 *       "cells": {                              // SPARSE: only cells that have something
 *         "A1": { "v": "Item", "bold": true, "bg": "gray" },
 *         "B2": { "v": 1200, "fmt": "currency" },
 *         "C2": { "v": 0.125, "fmt": "percent" },     // percent is a fraction: 0.125 shows 12.5%
 *         "D2": { "v": "2026-11-20", "fmt": "date" }, // dates are ISO yyyy-mm-dd strings
 *         "E2": { "v": true },                        // booleans show TRUE / FALSE
 *         "B9": { "f": "=SUM(B2:B8)", "fmt": "currency", "bold": true }
 *       },
 *       "charts": [                             // optional, max 20 per tab
 *         {
 *           "id": "spend",                      // unique within the tab
 *           "anchor": "H2",                     // the chart's top-left cell
 *           "width": 480, "height": 280,        // optional px
 *           "spec": { "type": "bar", "title": "Spend by month", "range": "A1:C7" }
 *         }
 *       ]
 *     }
 *   ]
 * }
 *
 * Cells
 * - Keys are A1 addresses in upper case ("A1", "AB120"), inside the tab's rows/cols.
 * - `v` is a literal (string, finite number or boolean). `f` is a formula starting
 *   with "=". Give one or the other, not both. A cell with only formatting is fine.
 * - `fmt`: text | number (1,234.50) | currency (USD, $1,234.50) | percent | date.
 *   Omit it for general numbers. `text` keeps what you typed, even "0012".
 * - `bold`: true. `align`: left | center | right (default: numbers right, text left).
 * - `bg`: gray | green | yellow | red | blue | brand — a theme-aware tint, not a hex.
 * - Never write computed values: the page recalculates every formula itself.
 *
 * Formulas (Excel-style, case-insensitive function names)
 * - References A1, $A$1 (absolute), ranges A1:B5, whole columns A:A, other tabs
 *   Budget!B2 or 'Q4 plan'!B2:B9 (by tab NAME; quote names with spaces).
 * - Operators, loosest first: comparisons = <> < > <= >=, then & (join text),
 *   + -, * /, ^, unary -, postfix % (so -2^2 = 4, 50% = 0.5).
 * - Functions: the ~100 in SUPPORTED_FUNCTIONS (sheet-formula.ts), listed in SHEET_GUIDE below.
 * - Arrays SPILL: =UNIQUE(A2:A50), =SORT(A2:C50, 3, -1), =FILTER(A2:C50, C2:C50>100),
 *   =SEQUENCE(10), =A2:A50*2 fill the cells below/right of the formula; leave them
 *   empty (a filled one makes the formula #SPILL!). D2# means "the block spilled from D2".
 * - Defined names (workbook "names") work in formulas: =SUM(Revenue).
 *   SUMIF/COUNTIF criteria: ">10", "<>done", "Done" (case-insensitive equality).
 *   VLOOKUP(key, range, column, [FALSE]) — exact match only; TRUE is approximate on sorted data.
 * - Dates in formulas are serial day numbers (as in Excel); a `fmt: "date"` cell
 *   holding "2026-11-20" reads as that day's number, so =D2-TODAY() is days left.
 * - Errors you may see: #DIV/0! #REF! (missing tab or off-sheet) #NAME? (unknown
 *   function or name) #VALUE! (wrong type) #N/A (lookup miss) #NUM! #CYCLE! (a formula
 *   that depends on itself) #ERROR! (unparseable formula) #SPILL! (a spill's cells are
 *   taken) #CALC! (FILTER matched nothing).
 *
 * Charts: `spec.range` is a block whose first row is headers and first column is
 * the x-axis labels; every other column is a numeric series (at most 8 series and
 * 500 data rows). `type` is bar | line | area | pie | scatter | combo (`stacked`
 * stacks bars or areas). The range may name another tab.
 *
 * `revision` is owned by the store (it counts writes); never set it yourself.
 * ==============================================================================
 */

import { z } from 'zod/v4'
import { CHART_TYPES } from './chart'
import { safeLinkHref } from './safe-link'
import { parseAddress, parseSheetRange } from './sheet-address'

export const SHEET_LIMITS = {
  tabs: 50,
  rows: 50_000,
  cols: 200,
  cells: 200_000,
  chartsPerTab: 20,
  frozenRows: 20,
  frozenCols: 10,
  formulaLength: 4_000,
  textLength: 10_000,
  merges: 1_000,
  tables: 20,
  rules: 50,
  validations: 100,
  listOptions: 200,
  noteLength: 2_000,
  names: 200,
  protectedRanges: 50,
  runs: 100,
  groups: 50,
  deletedTabs: 5,
  /** Filled cells the deleted-tab trash may hold in all (it never counts toward `cells`). */
  deletedCells: 50_000,
} as const

export const DEFAULT_ROWS = 1000
export const DEFAULT_COLS = 26
export const DEFAULT_COL_WIDTH = 104
export const MIN_COL_WIDTH = 24
export const MAX_COL_WIDTH = 800

export const MIN_ROW_HEIGHT = 16
export const MAX_ROW_HEIGHT = 400

export const CELL_FORMATS = ['text', 'number', 'currency', 'percent', 'date', 'time', 'datetime', 'duration'] as const
export const CELL_ALIGNS = ['left', 'center', 'right'] as const
export const CELL_VALIGNS = ['top', 'middle', 'bottom'] as const
/** Theme tints; the last four came in round 5 (additive: older workbooks only use the first six). */
export const CELL_FILLS = ['gray', 'green', 'yellow', 'red', 'blue', 'brand', 'orange', 'purple', 'pink', 'teal'] as const
/** Text colours are the fill palette at full strength. */
export const CELL_COLORS = CELL_FILLS
export const FONT_SIZES = [10, 11, 12, 14, 18, 24] as const
/** Font families a cell may use (the allow-list; the default is the app's sans). Names are as Excel writes them. */
export const FONT_FAMILIES = ['Inter', 'Arial', 'Calibri', 'Georgia', 'Times New Roman', 'Courier New', 'Verdana'] as const
/** Text rotation in degrees (counter-clockwise, as Excel). */
export const TEXT_ROTATIONS = [-90, -45, 45, 90] as const
/** An in-cell list: each line of the text is one item. */
export const CELL_LISTS = ['bullet', 'number'] as const
/** Most people one person cell holds. */
export const MAX_CELL_PEOPLE = 10
/** Icon sets a conditional-formatting `icons` rule may draw. */
export const ICON_SETS = ['arrows', 'traffic', 'stars'] as const
/**
 * Chart types a SHEET chart may draw: the shared spec's three plus pie, scatter and combo
 * (first series as bars, the rest as lines). Sheet-only, so chart.ts stays as docs and slides use it.
 */
export const SHEET_CHART_TYPES = [...CHART_TYPES, 'pie', 'scatter', 'combo'] as const
export type SheetChartType = (typeof SHEET_CHART_TYPES)[number]
export const BORDER_STYLES = ['thin', 'thick', 'dashed'] as const
export const DATE_STYLES = ['short', 'medium', 'long', 'iso'] as const
export const RULE_TYPES = ['gt', 'lt', 'between', 'eq', 'contains', 'empty', 'duplicate', 'top', 'bottom', 'scale', 'bars', 'icons'] as const
/** Currencies a `currency` cell may show (ISO 4217); without one, currency is USD. */
export const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF', 'CNY', 'INR', 'BRL', 'MXN', 'SEK', 'NOK', 'DKK', 'PLN', 'KRW', 'SGD', 'HKD', 'NZD', 'ZAR'] as const
/** Locales a workbook may format numbers and dates in; without one, en-US. */
export const SHEET_LOCALES = ['en-US', 'en-GB', 'en-IN', 'en-AU', 'en-CA', 'de-DE', 'fr-FR', 'es-ES', 'it-IT', 'nl-NL', 'pt-BR', 'sv-SE', 'pl-PL', 'ja-JP', 'zh-CN', 'ko-KR'] as const
export type Currency = (typeof CURRENCIES)[number]
export type SheetLocale = (typeof SHEET_LOCALES)[number]

/** Whether `zone` is an IANA time zone this runtime knows ("Europe/London", "UTC"). */
export function isTimeZone(zone: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/.test(zone)) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

/** A link a cell or a run of text may carry: http(s) or mailto only (the one allow-list, safe-link.ts). */
const cellLink = z
  .string()
  .max(2000)
  .refine((url) => safeLinkHref(url) !== null, 'a link is an http(s) or mailto URL')

/** One styled run of a rich-text cell; the runs' texts joined are the cell's `v`. */
export const textRunSchema = z.strictObject({
  text: z.string().min(1).max(10_000),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional(),
  strike: z.boolean().optional(),
  color: z.enum(CELL_FILLS).optional(),
  link: cellLink.optional(),
})
export type TextRun = z.infer<typeof textRunSchema>
/** A sheet chart draws a range, not a chart spec; it shares the spec's types. */
export { CHART_TYPES }

export type CellFormat = (typeof CELL_FORMATS)[number]
export type CellAlign = (typeof CELL_ALIGNS)[number]
export type CellFill = (typeof CELL_FILLS)[number]
export type CellValign = (typeof CELL_VALIGNS)[number]
export type FontSize = (typeof FONT_SIZES)[number]
export type BorderStyle = (typeof BORDER_STYLES)[number]
export type DateStyle = (typeof DATE_STYLES)[number]
export type RuleType = (typeof RULE_TYPES)[number]
export type FontFamily = (typeof FONT_FAMILIES)[number]
export type TextRotation = (typeof TEXT_ROTATIONS)[number]
export type CellList = (typeof CELL_LISTS)[number]
export type IconSet = (typeof ICON_SETS)[number]

/** One person in a person cell: a display name (never an email: bodies are readable by link viewers and the agent). */
export const cellPersonSchema = z.strictObject({
  name: z
    .string()
    .min(1)
    .max(80)
    .refine((n) => n.trim() === n && !n.includes(','), 'a name has no commas and no leading or trailing spaces'),
})
export type CellPerson = z.infer<typeof cellPersonSchema>
/** The text a person cell shows (and formulas read): the names joined. */
export const peopleText = (people: readonly CellPerson[]) => people.map((p) => p.name).join(', ')

/**
 * A custom number format pattern (Excel-style subset, see sheet-format.ts `formatPattern`):
 * digits `0 # , .`, `%`, quoted text, `[Red]`-style colours, up to 3 sections `pos;neg;zero`,
 * and dates `yyyy mm dd hh mm ss AM/PM`.
 */
const numberPattern = z
  .string()
  .min(1)
  .max(100)
  .refine((p) => !/[\u0000-\u001f]/.test(p), 'a pattern has no control characters')

const TAB_NAME_FORBIDDEN = /[\\/?*[\]:]/

/** "C" → 2 (local, so this module needs nothing from sheet-address beyond parsing). */
function colLettersIndex(letters: string): number {
  let col = 0
  for (const ch of letters) col = col * 26 + (ch.charCodeAt(0) - 64)
  return col - 1
}

export const sheetCellSchema = z
  .strictObject({
    v: z
      .union([z.string().max(SHEET_LIMITS.textLength), z.number().refine(Number.isFinite), z.boolean()])
      .optional(),
    f: z
      .string()
      .max(SHEET_LIMITS.formulaLength)
      .refine((f) => f.startsWith('=') && f.trim().length > 1, 'a formula starts with "="')
      .optional(),
    fmt: z.enum(CELL_FORMATS).optional(),
    bold: z.boolean().optional(),
    align: z.enum(CELL_ALIGNS).optional(),
    bg: z.enum(CELL_FILLS).optional(),
    // Optional styling, all additive (a v1 cell without them is unchanged).
    italic: z.boolean().optional(),
    underline: z.boolean().optional(),
    strike: z.boolean().optional(),
    color: z.enum(CELL_COLORS).optional(),
    size: z
      .number()
      .refine((n) => (FONT_SIZES as readonly number[]).includes(n), `size is one of ${FONT_SIZES.join(', ')}`)
      .optional(),
    wrap: z.boolean().optional(),
    valign: z.enum(CELL_VALIGNS).optional(),
    border: z
      .strictObject({
        top: z.enum(BORDER_STYLES).optional(),
        right: z.enum(BORDER_STYLES).optional(),
        bottom: z.enum(BORDER_STYLES).optional(),
        left: z.enum(BORDER_STYLES).optional(),
      })
      .optional(),
    /** Fixed decimals for number, currency, percent and general numbers (general: no grouping). */
    decimals: z.number().int().min(0).max(10).optional(),
    dateStyle: z.enum(DATE_STYLES).optional(),
    note: z.string().max(SHEET_LIMITS.noteLength).optional(),
    /** Currency shown by `fmt: "currency"` (default USD). */
    currency: z.enum(CURRENCIES).optional(),
    /** The whole cell links here (http, https or mailto). */
    link: cellLink.optional(),
    /** Rich text: styled runs whose texts joined are exactly the string `v`. */
    runs: z.array(textRunSchema).min(1).max(SHEET_LIMITS.runs).optional(),
    // Round 5, all optional and additive.
    /** Font family from FONT_FAMILIES (default: the app's sans). */
    font: z.enum(FONT_FAMILIES).optional(),
    /** Indent steps (each ~12 px) from the aligned edge. */
    indent: z.number().int().min(1).max(10).optional(),
    /** Rotated text, degrees counter-clockwise. */
    rotate: z
      .number()
      .refine((n) => (TEXT_ROTATIONS as readonly number[]).includes(n), `rotate is one of ${TEXT_ROTATIONS.join(', ')}`)
      .optional(),
    /** Show each line of the text as a bulleted or numbered list item. */
    list: z.enum(CELL_LISTS).optional(),
    /** A person cell: who (display names); `v` is their names joined by ", ". */
    people: z.array(cellPersonSchema).min(1).max(MAX_CELL_PEOPLE).optional(),
    /** A custom number format; wins over `fmt`'s look (the value is unchanged). */
    pattern: numberPattern.optional(),
  })
  .refine((cell) => cell.v === undefined || cell.f === undefined, 'a cell has a value or a formula, not both')
  .refine((cell) => cell.people === undefined || cell.v === peopleText(cell.people), 'a person cell\'s "v" is its people\'s names joined by ", "')
  .refine(
    (cell) => cell.runs === undefined || (typeof cell.v === 'string' && cell.runs.map((run) => run.text).join('') === cell.v),
    'runs need a text "v" equal to their texts joined',
  )

const rangeString = z.string().refine((r) => parseSheetRange(r) !== null && !r.includes('!'), 'a range like A1:C7 on this tab')

export const sheetTableSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  range: rangeString,
  /** The first row is a header band (default true). */
  header: z.boolean().optional(),
  /** Alternate rows tinted (default true). */
  banded: z.boolean().optional(),
  color: z.enum(CELL_FILLS).optional(),
})

const ruleStyle = z.strictObject({
  bg: z.enum(CELL_FILLS).optional(),
  color: z.enum(CELL_COLORS).optional(),
  bold: z.boolean().optional(),
})

export const sheetRuleSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  range: rangeString,
  type: z.enum(RULE_TYPES),
  /** gt/lt/eq/between: a number (or text for eq); contains: the text; top/bottom: N. */
  value: z.union([z.number().refine(Number.isFinite), z.string().max(500)]).optional(),
  value2: z.number().refine(Number.isFinite).optional(),
  style: ruleStyle.optional(),
  /** scale: low, (optional) mid and high colours, from the fill palette. */
  scale: z.tuple([z.enum(CELL_FILLS), z.enum(CELL_FILLS), z.enum(CELL_FILLS)]).optional(),
  /** icons: which set (default arrows); thirds of the range's spread pick the icon. */
  icons: z.enum(ICON_SETS).optional(),
})

export const DATE_PRESETS = ['today', 'yesterday', 'last7', 'last30', 'thisWeek', 'thisMonth', 'lastMonth', 'thisYear'] as const
export type DatePreset = (typeof DATE_PRESETS)[number]
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date like 2026-11-20')

/** One column's filter: kept values, text, a number condition, and/or a date window. */
export const columnFilterSchema = z.strictObject({
  /** Shown values to keep (formatted text, "" for blanks). */
  values: z.array(z.string().max(500)).max(500).optional(),
  contains: z.string().max(200).optional(),
  op: z.enum(['gt', 'lt', 'eq', 'between']).optional(),
  a: z.string().max(100).optional(),
  b: z.string().max(100).optional(),
  /** Dates: a window relative to today, or fixed days (inclusive). */
  date: z
    .strictObject({ preset: z.enum(DATE_PRESETS).optional(), from: isoDay.optional(), to: isoDay.optional() })
    .optional(),
})
export type ColumnFilter = z.infer<typeof columnFilterSchema>

/** What a rule-breaking entry does: `reject` refuses it, `warn` keeps it and marks the cell. */
export const VALIDATION_MODES = ['reject', 'warn'] as const
const ruleExtras = {
  mode: z.enum(VALIDATION_MODES).optional(),
  /** Shown when an entry breaks the rule. */
  message: z.string().max(200).optional(),
}

export const sheetValidationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('checkbox'), range: rangeString }),
  z.strictObject({
    kind: z.literal('list'),
    range: rangeString,
    options: z
      .array(z.strictObject({ value: z.string().min(1).max(200), color: z.enum(CELL_FILLS).optional() }))
      .min(1)
      .max(SHEET_LIMITS.listOptions),
    /** Without a mode a list only offers its options; with one, other text is refused or marked. */
    ...ruleExtras,
  }),
  z.strictObject({
    kind: z.literal('number'),
    range: rangeString,
    min: z.number().refine(Number.isFinite).optional(),
    max: z.number().refine(Number.isFinite).optional(),
    integer: z.boolean().optional(),
    ...ruleExtras,
  }),
  z.strictObject({ kind: z.literal('date'), range: rangeString, from: isoDay.optional(), to: isoDay.optional(), ...ruleExtras }),
  z.strictObject({
    kind: z.literal('custom'),
    range: rangeString,
    /** TRUE for a good entry; references are written for the range's top-left cell and shift per cell. */
    formula: z.string().max(500).refine((f) => f.startsWith('=') && f.length > 1, 'a formula starting with "="'),
    ...ruleExtras,
  }),
])

export const sheetProtectedSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  range: rangeString,
  /** Why it is protected, shown when an edit is refused. */
  note: z.string().max(200).optional(),
})

export const sheetChartSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  anchor: z.string().refine((a) => parseAddress(a) !== null, 'anchor is an A1 address'),
  width: z.number().int().min(160).max(1600).optional(),
  height: z.number().int().min(120).max(1200).optional(),
  spec: z.strictObject({
    type: z.enum(SHEET_CHART_TYPES),
    /** bar, area: stack the series instead of side by side / overlapping. */
    stacked: z.boolean().optional(),
    title: z.string().max(200).optional(),
    range: z.string().refine((r) => parseSheetRange(r) !== null, 'range is like A1:C7 or Tab!A1:C7'),
    /** The first row (columns mode) or column (rows mode) names the series (default true). */
    header: z.boolean().optional(),
    /** Each column is a series (default), or each row is. */
    seriesIn: z.enum(['columns', 'rows']).optional(),
    xLabel: z.string().max(100).optional(),
    yLabel: z.string().max(100).optional(),
    /** Show the legend (default true). */
    legend: z.boolean().optional(),
  }),
})

const lineGroup = <T extends z.ZodType>(edge: T) =>
  z.strictObject({ from: edge, to: edge, collapsed: z.boolean().optional() })
const rowNumber = z.number().int().min(1).max(SHEET_LIMITS.rows)
const colLetters = z.string().regex(/^[A-Z]{1,3}$/, 'a column like C')
export const rowGroupSchema = lineGroup(rowNumber)
export const colGroupSchema = lineGroup(colLetters)
export type RowGroup = z.infer<typeof rowGroupSchema>
export type ColGroup = z.infer<typeof colGroupSchema>

export const sheetTabSchema = z
  .strictObject({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    name: z
      .string()
      .min(1)
      .max(31)
      .refine((n) => !TAB_NAME_FORBIDDEN.test(n), 'a tab name has none of \\ / ? * [ ] :')
      .refine((n) => !n.startsWith("'") && !n.endsWith("'"), "a tab name does not start or end with '")
      .refine((n) => n.trim() === n, 'a tab name has no leading or trailing spaces'),
    rows: z.number().int().min(1).max(SHEET_LIMITS.rows).optional(),
    cols: z.number().int().min(1).max(SHEET_LIMITS.cols).optional(),
    columns: z
      .array(
        z.strictObject({
          width: z.number().int().min(MIN_COL_WIDTH).max(MAX_COL_WIDTH).optional(),
          hidden: z.boolean().optional(),
        }),
      )
      .max(SHEET_LIMITS.cols)
      .optional(),
    frozenRows: z.number().int().min(0).max(SHEET_LIMITS.frozenRows).optional(),
    frozenCols: z.number().int().min(0).max(SHEET_LIMITS.frozenCols).optional(),
    /** Sparse per-row settings, keyed by the 1-based row number ("12"). */
    rowMeta: z
      .record(
        z.string().regex(/^[1-9][0-9]{0,4}$/),
        z.strictObject({
          height: z.number().int().min(MIN_ROW_HEIGHT).max(MAX_ROW_HEIGHT).optional(),
          hidden: z.boolean().optional(),
        }),
      )
      .optional(),
    cells: z.record(z.string(), sheetCellSchema),
    charts: z.array(sheetChartSchema).max(SHEET_LIMITS.chartsPerTab).optional(),
    /** Merged blocks ("A1:C1"); the top-left cell holds the content. They never overlap. */
    merges: z.array(rangeString).max(SHEET_LIMITS.merges).optional(),
    tables: z.array(sheetTableSchema).max(SHEET_LIMITS.tables).optional(),
    /**
     * The range a filter row sits on. `columns` is the filter SAVED for everyone (by column
     * letter); without it, what is filtered out is each viewer's own. `sort` is how it was last sorted.
     */
    filter: z
      .strictObject({
        range: rangeString,
        columns: z.record(z.string().regex(/^[A-Z]{1,3}$/), columnFilterSchema).optional(),
        sort: z.strictObject({ col: z.string().regex(/^[A-Z]{1,3}$/), desc: z.boolean().optional() }).optional(),
      })
      .optional(),
    rules: z.array(sheetRuleSchema).max(SHEET_LIMITS.rules).optional(),
    validations: z.array(sheetValidationSchema).max(SHEET_LIMITS.validations).optional(),
    /** Owner-protected ranges: read-only in the editor and to the agent. */
    protected: z.array(sheetProtectedSchema).max(SHEET_LIMITS.protectedRanges).optional(),
    /** Row groups (1-based, inclusive) that fold away; a collapsed one hides its rows. They never overlap. */
    rowGroups: z.array(rowGroupSchema).max(SHEET_LIMITS.groups).optional(),
    /** Column groups by letter (inclusive); a collapsed one hides its columns. They never overlap. */
    colGroups: z.array(colGroupSchema).max(SHEET_LIMITS.groups).optional(),
    /** `false` hides the grid lines (borders still show). */
    gridlines: z.boolean().optional(),
  })
  .superRefine((tab, ctx) => {
    const rows = tab.rows ?? DEFAULT_ROWS
    const cols = tab.cols ?? DEFAULT_COLS
    for (const key of Object.keys(tab.cells)) {
      const pos = parseAddress(key)
      if (!pos) {
        ctx.addIssue({ code: 'custom', path: ['cells', key], message: `"${key}" is not an A1 address` })
      } else if (pos.row >= rows || pos.col >= cols) {
        ctx.addIssue({ code: 'custom', path: ['cells', key], message: `"${key}" is outside the tab's ${rows}×${cols}` })
      }
    }
    for (const key of Object.keys(tab.rowMeta ?? {})) {
      if (Number(key) > rows) ctx.addIssue({ code: 'custom', path: ['rowMeta', key], message: `row ${key} is past the tab's ${rows} rows` })
    }
    const inside = (range: string, path: PropertyKey[]) => {
      const rect = parseSheetRange(range)?.rect
      if (rect && (rect.bottom >= rows || rect.right >= cols)) {
        ctx.addIssue({ code: 'custom', path, message: `"${range}" is outside the tab's ${rows}×${cols}` })
      }
      return rect
    }
    const merged: Array<{ top: number; left: number; bottom: number; right: number }> = []
    for (const [index, range] of (tab.merges ?? []).entries()) {
      const rect = inside(range, ['merges', index])
      if (!rect) continue
      if (merged.some((m) => m.top <= rect.bottom && rect.top <= m.bottom && m.left <= rect.right && rect.left <= m.right)) {
        ctx.addIssue({ code: 'custom', path: ['merges', index], message: `"${range}" overlaps another merge` })
      }
      merged.push(rect)
    }
    for (const [index, table] of (tab.tables ?? []).entries()) inside(table.range, ['tables', index, 'range'])
    for (const [index, rule] of (tab.rules ?? []).entries()) inside(rule.range, ['rules', index, 'range'])
    for (const [index, rule] of (tab.validations ?? []).entries()) inside(rule.range, ['validations', index, 'range'])
    for (const [index, item] of (tab.protected ?? []).entries()) inside(item.range, ['protected', index, 'range'])
    if (tab.filter) inside(tab.filter.range, ['filter', 'range'])
    const groupSpans = (list: Array<{ from: number; to: number }>, length: number, key: 'rowGroups' | 'colGroups') => {
      const spans: Array<{ from: number; to: number }> = []
      for (const [index, span] of list.entries()) {
        if (span.to < span.from) ctx.addIssue({ code: 'custom', path: [key, index], message: '"to" comes before "from"' })
        else if (span.to > length) ctx.addIssue({ code: 'custom', path: [key, index], message: `the group passes the tab's ${length} ${key === 'rowGroups' ? 'rows' : 'columns'}` })
        else if (spans.some((s) => s.from <= span.to && span.from <= s.to)) ctx.addIssue({ code: 'custom', path: [key, index], message: 'groups never overlap' })
        spans.push(span)
      }
    }
    if (tab.rowGroups) groupSpans(tab.rowGroups, rows, 'rowGroups')
    if (tab.colGroups) groupSpans(tab.colGroups.map((g) => ({ from: colLettersIndex(g.from) + 1, to: colLettersIndex(g.to) + 1 })), cols, 'colGroups')
    if ((tab.columns?.length ?? 0) > cols) {
      ctx.addIssue({ code: 'custom', path: ['columns'], message: 'more column entries than columns' })
    }
    const chartIds = new Set<string>()
    for (const [index, chart] of (tab.charts ?? []).entries()) {
      if (chartIds.has(chart.id)) {
        ctx.addIssue({ code: 'custom', path: ['charts', index, 'id'], message: 'duplicate chart id' })
      }
      chartIds.add(chart.id)
    }
  })

/** A defined name: letters, digits, _ and ., starting with a letter or _, and not like a cell (A1) or column (AB). */
export const DEFINED_NAME = /^[A-Za-z_][A-Za-z0-9_.]{0,63}$/
const LOOKS_LIKE_REF = /^\$?[A-Za-z]{1,3}\$?[0-9]{1,7}$|^[A-Za-z]{1,3}$|^R[0-9]*C[0-9]*$/i

/** Why `name` cannot be a defined name, or null. */
export function definedNameProblem(name: string): string | null {
  if (!DEFINED_NAME.test(name)) return 'a name starts with a letter or _ and holds only letters, digits, _ and . (at most 64)'
  if (LOOKS_LIKE_REF.test(name)) return `"${name}" looks like a cell or column reference`
  if (/^(true|false)$/i.test(name)) return `"${name}" is a boolean`
  return null
}

export const sheetNameSchema = z.strictObject({
  name: z.string().superRefine((n, ctx) => {
    const problem = definedNameProblem(n)
    if (problem) ctx.addIssue({ code: 'custom', message: problem })
  }),
  /** The id of the tab the range is on. */
  tab: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  range: rangeString,
  comment: z.string().max(200).optional(),
})

export const workbookSchema = z
  .strictObject({
    version: z.literal(1),
    title: z.string().min(1).max(200),
    revision: z.number().int().min(0).optional(),
    tabs: z.array(sheetTabSchema).min(1).max(SHEET_LIMITS.tabs),
    /** Defined names (named ranges) that formulas may use: =SUM(Revenue). */
    names: z.array(sheetNameSchema).max(SHEET_LIMITS.names).optional(),
    /** How numbers and dates show and are typed (default en-US). */
    locale: z.enum(SHEET_LOCALES).optional(),
    /** The IANA zone TODAY() and NOW() read (default: the reader's clock). */
    timeZone: z.string().refine(isTimeZone, 'an IANA time zone like "Europe/London"').optional(),
    /** The last few deleted tabs, newest last, so a delete can be restored. */
    deletedTabs: z
      .array(
        z.strictObject({
          tab: sheetTabSchema,
          index: z.number().int().min(0).max(SHEET_LIMITS.tabs),
          /** Defined names that pointed at the tab; a restore brings them back. */
          names: z.array(sheetNameSchema).max(SHEET_LIMITS.names).optional(),
        }),
      )
      .max(SHEET_LIMITS.deletedTabs)
      .optional(),
  })
  .superRefine((workbook, ctx) => {
    const seenNames = new Set<string>()
    for (const [index, def] of (workbook.names ?? []).entries()) {
      const key = def.name.toLowerCase()
      if (seenNames.has(key)) ctx.addIssue({ code: 'custom', path: ['names', index, 'name'], message: 'duplicate name' })
      seenNames.add(key)
      const tab = workbook.tabs.find((t) => t.id === def.tab)
      if (!tab) {
        ctx.addIssue({ code: 'custom', path: ['names', index, 'tab'], message: `no tab with id "${def.tab}"` })
        continue
      }
      const rect = parseSheetRange(def.range)?.rect
      if (rect && (rect.bottom >= tabRows(tab) || rect.right >= tabCols(tab))) {
        ctx.addIssue({ code: 'custom', path: ['names', index, 'range'], message: `"${def.range}" is outside the tab's ${tabRows(tab)}×${tabCols(tab)}` })
      }
    }
    const ids = new Set<string>()
    const names = new Set<string>()
    let cells = 0
    for (const [index, tab] of workbook.tabs.entries()) {
      if (ids.has(tab.id)) ctx.addIssue({ code: 'custom', path: ['tabs', index, 'id'], message: 'duplicate tab id' })
      const name = tab.name.toLowerCase()
      if (names.has(name)) {
        ctx.addIssue({ code: 'custom', path: ['tabs', index, 'name'], message: 'duplicate tab name' })
      }
      ids.add(tab.id)
      names.add(name)
      cells += Object.keys(tab.cells).length
    }
    let trashed = 0
    for (const entry of workbook.deletedTabs ?? []) trashed += Object.keys(entry.tab.cells).length
    if (trashed > SHEET_LIMITS.deletedCells) {
      ctx.addIssue({ code: 'custom', path: ['deletedTabs'], message: `deleted tabs hold more than ${SHEET_LIMITS.deletedCells} cells` })
    }
    if (cells > SHEET_LIMITS.cells) {
      ctx.addIssue({ code: 'custom', path: ['tabs'], message: `more than ${SHEET_LIMITS.cells} filled cells` })
    }
  })

export type SheetCell = z.infer<typeof sheetCellSchema>
export type SheetChart = z.infer<typeof sheetChartSchema>
export type SheetTable = z.infer<typeof sheetTableSchema>
export type SheetRule = z.infer<typeof sheetRuleSchema>
export type SheetValidation = z.infer<typeof sheetValidationSchema>
export type SheetProtected = z.infer<typeof sheetProtectedSchema>
export type RowMeta = NonNullable<SheetTab['rowMeta']>[string]
export type SheetTab = z.infer<typeof sheetTabSchema>
export type Workbook = z.infer<typeof workbookSchema>
export type SheetName = z.infer<typeof sheetNameSchema>

/** Validate an untrusted workbook (from the agent or the store). Never throws. */
export function parseWorkbook(
  input: unknown,
): { ok: true; workbook: Workbook } | { ok: false; issues: string[] } {
  const result = workbookSchema.safeParse(input)
  if (result.success) return { ok: true, workbook: result.data }
  return {
    ok: false,
    issues: result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
  }
}

export const tabRows = (tab: SheetTab) => tab.rows ?? DEFAULT_ROWS
export const tabCols = (tab: SheetTab) => tab.cols ?? DEFAULT_COLS
export const colWidth = (tab: SheetTab, col: number) => tab.columns?.[col]?.width ?? DEFAULT_COL_WIDTH
export const DEFAULT_ROW_HEIGHT = 26
export const rowHeight = (tab: SheetTab, row: number) => tab.rowMeta?.[String(row + 1)]?.height ?? DEFAULT_ROW_HEIGHT
/** Hidden by hand, or folded inside a collapsed group. */
export const rowHidden = (tab: SheetTab, row: number) =>
  Boolean(tab.rowMeta?.[String(row + 1)]?.hidden) ||
  Boolean(tab.rowGroups?.some((g) => g.collapsed && row + 1 >= g.from && row + 1 <= g.to))
export const colHidden = (tab: SheetTab, col: number) =>
  Boolean(tab.columns?.[col]?.hidden) ||
  Boolean(tab.colGroups?.some((g) => g.collapsed && col >= colLettersIndex(g.from) && col <= colLettersIndex(g.to)))

/**
 * The full authoring reference `artifact_guide {kind: "sheet"}` returns: the
 * doc comment above, for the agent, plus how to edit a stored workbook.
 */
export const SHEET_GUIDE = `Sheets (kind "sheet"): a workbook is ONE JSON object. Unknown keys are rejected.

{ "version": 1, "title": "Q4 budget" (1-200 chars), "tabs": [Tab, ...] (1-${SHEET_LIMITS.tabs}, in display order) }
Tab: { "id": "budget" (unique, [A-Za-z0-9_-], never shown), "name": "Budget" (unique ignoring case, 1-31 chars, none of \\ / ? * [ ] : and no leading/trailing ' or spaces),
  "rows"?: row count (default ${DEFAULT_ROWS}, max ${SHEET_LIMITS.rows}), "cols"?: column count (default ${DEFAULT_COLS}, max ${SHEET_LIMITS.cols}),
  "columns"?: [{ "width": 180 }, {}] (index 0 = column A; px ${MIN_COL_WIDTH}-${MAX_COL_WIDTH}), "frozenRows"?: 0-${SHEET_LIMITS.frozenRows}, "frozenCols"?: 0-${SHEET_LIMITS.frozenCols},
  "cells": { "A1": Cell, ... } (SPARSE: only cells that hold something; at most ${SHEET_LIMITS.cells} filled cells in all),
  "charts"?: [{ "id": "spend", "anchor": "H2", "width"?: 160-1600, "height"?: 120-1200, "spec": { "type": "bar" | "line" | "area" | "pie" | "scatter" | "combo", "stacked"?: true, "title"?: "...", "range": "A1:C7" } }] (max ${SHEET_LIMITS.chartsPerTab} per tab) }

Cell (keys are upper-case A1 addresses inside the tab's rows/cols):
- "v": a literal (string <= ${SHEET_LIMITS.textLength} chars, finite number or boolean) OR "f": a formula starting with "=" (<= ${SHEET_LIMITS.formulaLength} chars). Never both. A cell with only formatting is fine.
- "fmt": text | number (1,234.50) | currency (USD $1,234.50) | percent (a FRACTION: 0.125 shows 12.5%) | date (the value is an ISO "yyyy-mm-dd" string) | time (a day fraction: 0.5 is 12:00 PM) | datetime (day serial + fraction) | duration (days: 1.5 shows 36:00:00). Omit for general numbers.
- "decimals"?: 0-10 fixed decimals (with no fmt: no thousands separator); "dateStyle"?: short (11/20/2026) | medium (Nov 20, 2026) | long | iso.
- Style: "bold" "italic" "underline" "strike" "wrap": true; "align": left | center | right; "valign": top | middle | bottom; "size": ${FONT_SIZES.join(' | ')} (default 12);
  "bg" (fill) and "color" (text): ${CELL_FILLS.join(' | ')} (theme tints, not hex); "border": {"top"|"right"|"bottom"|"left": thin | thick | dashed}; "note": text shown on hover.
- Never write computed values: the app recalculates every formula.

Tab extras (all optional): "rowMeta": {"12": {"height": 40, "hidden": true}} (1-based row keys, px ${MIN_ROW_HEIGHT}-${MAX_ROW_HEIGHT}); "columns": [{"width": 120, "hidden": true}];
"merges": ["A1:D1"] (top-left cell holds the content; no overlaps); "tables": [{"id": "t1", "range": "A1:E40", "header"?: true, "banded"?: true, "color"?: fill}] (header band, banded rows, a filter button per column);
"filter": {"range": "A1:E40", "columns"?: {"C": {"values": ["Open"]}}} (a filter row on that block; "columns" is a filter saved for everyone, see setFilter); "validations": [{"kind": "checkbox", "range": "F2:F40"}, {"kind": "list", "range": "C2:C40", "options": [{"value": "Done", "color": "green"}, {"value": "Todo"}]}] (checkbox cells hold TRUE/FALSE; list cells hold one option's text);
"rules" (conditional formatting, first match wins): [{"id": "r1", "range": "D2:D40", "type": "gt" | "lt" | "between" | "eq" | "contains" | "empty" | "duplicate" | "top" | "bottom" | "scale", "value"?: 100 (or text; N for top/bottom), "value2"?: 200 (between), "style"?: {"bg"?, "color"?, "bold"?}, "scale"?: ["red", "yellow", "green"] (low, mid, high)}].
Ranges inside a tab never carry a "Tab!" prefix.

Formulas (Excel-style): references A1, $A$1, ranges A1:B5, whole columns A:A, other tabs Budget!B2 or 'Q4 plan'!B2:B9 (by tab NAME). Operators: = <> < > <= >=, & (join), + -, * /, ^, unary -, postfix %.
Functions: SUM AVERAGE MIN MAX COUNT COUNTA IF IFERROR AND OR NOT ROUND ROUNDUP ROUNDDOWN ABS SUMIF COUNTIF AVERAGEIF VLOOKUP MATCH INDEX CONCAT CONCATENATE LEN UPPER LOWER TRIM ISBLANK ISNUMBER TODAY DATE SUMIFS COUNTIFS AVERAGEIFS XLOOKUP HLOOKUP IFS SWITCH CHOOSE TEXT LEFT RIGHT MID SUBSTITUTE FIND SEARCH PROPER REPT TEXTJOIN VALUE EXACT YEAR MONTH DAY WEEKDAY EDATE EOMONTH DAYS NETWORKDAYS NOW TIME HOUR MINUTE SECOND MEDIAN PRODUCT MOD INT POWER SQRT CEILING FLOOR SIGN PI COUNTBLANK SUMPRODUCT ISERROR ISERR ISNA ISTEXT ISLOGICAL IFNA UNIQUE SORT SORTBY FILTER SEQUENCE TRANSPOSE CHOOSECOLS CHOOSEROWS ROWS COLUMNS MINIFS MAXIFS LET SPARKLINE.
Arrays SPILL from the formula's cell down and right: =UNIQUE(A2:A50), =SORT(A2:C50, 3, -1), =FILTER(A2:C50, C2:C50>100, "none"), =SEQUENCE(12), =A2:A50*B2:B50. Leave the spill's cells empty (anything there makes it #SPILL!); read_artifact shows spilled cells with "spilledFrom". D2# is the whole block spilled from D2 (=SUM(D2#), =ROWS(D2#)), and criteria may be arrays: =SUMIFS(C2:C50, A2:A50, D2#) spills one total per key. LET(name, value, ..., calc) names values; LAMBDA is not supported.
Defined names: workbook "names": [{"name": "Revenue", "tab": "<tab id>", "range": "B2:B40"}] then =SUM(Revenue). A name starts with a letter or _, holds letters, digits, _ and ., and must not look like a cell (Q1, AB12) or column (AB).
SUMIF/COUNTIF(S) criteria: ">10", "<>done", "Done", "Do*". VLOOKUP(key, range, column, FALSE) or XLOOKUP(key, lookup, return, [if_not_found]) for an exact match. Dates in formulas are serial day numbers; a date cell reads as its day number, so =D2-TODAY() is days left.
Errors: #DIV/0! #REF! #NAME? #VALUE! #N/A #NUM! #CYCLE! #ERROR! #SPILL! #CALC!.
Chart spec.range: a block whose first row is headers and first column the x labels; every other column is a numeric series (<= 8 series, <= 500 rows). It may name another tab. Optional spec fields: "seriesIn": "rows" (each row a series, the first row the x labels), "header": false (no series-name row; series are "Series 1"...), "xLabel"/"yLabel" axis titles, "legend": false. Charts follow their range when rows or columns are inserted or deleted.
Put headers in row 1 (bold, gray), freeze it with "frozenRows": 1, and use formulas for totals so they stay right when values change.

Example: {"version":1,"title":"Budget","tabs":[{"id":"main","name":"Budget","frozenRows":1,"cells":{"A1":{"v":"Item","bold":true},"B1":{"v":"Cost","bold":true},"A2":{"v":"Hosting"},"B2":{"v":420,"fmt":"currency"},"A3":{"v":"Total","bold":true},"B3":{"f":"=SUM(B2:B2)","fmt":"currency"}}}]}

Editing a stored workbook: edit_artifact with patch, ops applied in order then validated as a whole (any failure changes nothing). "tab" is a tab id or name.
- {"op":"setCells","tab":"Budget","cells":{"B2":500,"B3":"=SUM(B2:B2)","A4":{"v":"Note","bold":true},"C9":null,"D2":"50%","E2":"€1.234,50"}}
  A number or boolean sets the value and keeps the cell's formatting; a string starting with "=" sets a formula; any other string is read exactly as typed into the page: "50%" is 0.5 with fmt percent, "$1,234.50" / "€5" / "5 £" currency (with "currency": "EUR"...), "2026-11-20", "11/20/2026" (day first in day-first locales) or "Nov 20, 2026" a date, "13:45" / "1:45 PM" a time, "TRUE" a boolean, "1.234,5" a number in comma-decimal locales, "**Total** due" rich text; a leading ' keeps the rest as text. So "00123" becomes the number 123: send {"v":"00123","text":true} (or "'00123") for an ID or ZIP code. Markup needs word edges ("2*3*4" stays text).
  An object is merged into the cell (giving v drops f and the reverse; a field set to null is removed); its string "v" is read the same way unless "text": true or "fmt": "text" (an explicit "fmt" wins); null clears the cell.
  Cell extras: "currency": ${CURRENCIES.join(' | ')} (for fmt currency; default USD); "link": "https://..." (the whole cell links; http(s)/mailto only);
  "runs": [{"text": "Total", "bold": true}, {"text": " due "}, {"text": "docs", "link": "https://example.com"}] rich text (a run may be bold, italic, underline, strike, color, link; the texts joined are the cell's v, set for you when you give runs alone). "@Maya" text shows as a person chip.
- {"op":"addTab","name":"Q1","rows"?:..,"cols"?:..,"cells"?:{...},"frozenRows"?:..}
- {"op":"renameTab","tab":"Q1","name":"Q1 actuals"} (formulas and chart ranges that name it follow)
- {"op":"deleteTab","tab":"Q1"} (never the last)
- {"op":"insertRows","tab":"Budget","at":5,"count"?:2} inserts blank rows BEFORE row 5; {"op":"deleteRows","tab":"Budget","from":5,"count"?:2}.
  {"op":"insertColumns","tab":"Budget","at":"C","count"?:1} / {"op":"deleteColumns","tab":"Budget","from":"C","count"?:1}. Every formula, chart, merge, rule and table that points there follows (as in Excel: deleted references become #REF!, ranges shrink or grow). Prefer these over rewriting cells by hand.
- {"op":"sortRange","tab":"Budget","range":"A1:E40","by":"C","desc"?:true,"header"?:true} sorts rows by one column (blanks last; with header the first row stays).
- {"op":"formatRange","tab":"Budget","range":"B2:B40","format":{"fmt":"currency","decimals":0,"bold":true,"bg":"gray","color":"red","italic":true,"size":14,"wrap":true,"align":"right","valign":"middle","border":{"preset":"outer"|"all"|"top"|"bottom"|"left"|"right"|"none","style"?:"thin"|"thick"|"dashed"},"clear"?:true}} (null removes a property; keeps values).
- {"op":"mergeCells","tab":"Budget","range":"A1:D1","unmerge"?:true}
- {"op":"addChart","tab":"Budget","anchor":"H2","range":"A1:C7","type"?:"bar"|"line"|"area","title"?:"...","width"?:480,"height"?:300,"seriesIn"?:"rows","header"?:false,"xLabel"?:"Month","yLabel"?:"USD","legend"?:false}
- {"op":"setValidation","tab":"Budget","range":"F2:F40","kind":"checkbox"|"list"|"number"|"date"|"custom"|"none","options"?:["Todo","Done"] or [{"value":"Done","color":"green"}],"min"?:0,"max"?:100,"integer"?:true,"from"?:"2026-01-01","to"?:"2026-12-31","formula"?:"=LEN(F2)<=10" (custom: TRUE for a good entry, written for the first cell),"mode"?:"reject"|"warn","message"?:"..."}. reject (the default for number/date/custom) refuses a bad typed value, in the page and in your setCells; warn keeps it and marks the cell. A list with a mode also refuses text that is not an option.
- Protected ranges ("protected": [{"id","range","note"?}] on a tab) are the owner's: every op that would change a cell inside one, or add, remove or resize a protection, is refused, and so is adding, changing or removing a conditional-format rule or a table where it covers protected cells (their look is the owner's too). Row heights, hidden rows and columns and column widths stay yours to change. Ask the user to unprotect it instead.
- {"op":"addRule","tab":"Budget","rule":{"range":"D2:D40","type":"gt","value":1000,"style":{"bg":"red"}}}
- {"op":"defineName","name":"Revenue","tab":"Budget","range":"C2:C40","comment"?:"..."} defines or moves a name; {"op":"defineName","name":"Revenue","rename":"Sales"} renames it (formulas follow); {"op":"defineName","name":"Revenue","delete":true}. Names follow row/column inserts and deletes.
- {"op":"summarise","tab":"Sales","range":"A1:D200","groupBy":["A"] (or two: ["A","B"]),"values":[{"column":"D","agg":"sum"|"count"|"average"|"min"|"max"}],"name"?:"By region"} adds a NEW tab summarising the block (header row first) by group, as live formulas (SORT(UNIQUE(...)) keys and SUMIFS/COUNTIFS/... spills), so it updates when the data does.
- {"op":"setFilter","tab":"Budget","range"?:"A1:E40","columns"?:{"C":{"values":["Open","Blocked"]},"D":{"op":"gt","a":"100"},"E":{"date":{"preset":"last7"}}},"remove"?:true} puts a filter row on a block and SAVES a filter everyone sees (by column letter). A column filter: "values" (shown text to keep), "contains", "op" gt|lt|eq|between with "a"/"b", "date": {"preset": today|yesterday|last7|last30|thisWeek|thisMonth|lastMonth|thisYear, "from"/"to": "yyyy-mm-dd"}. Viewers may still filter privately on top.
- {"op":"copyCells","tab":"Budget","range":"A1:C9","to":"E1","toTab"?:"Q2"} copies cells with their formatting; relative references shift (as a paste), $absolute ones stay; "to" may be "Q2!E1".
- {"op":"fill","tab":"Budget","range":"A2:A3","to":"A2:A20","series"?:true} fills "to" (which holds "range" and extends it one way) like the fill handle: numbers, dates and "Week 1" continue their step, formulas shift; "series": false copies as is.
- {"op":"moveRows","tab":"Budget","from":5,"count"?:2,"to":9} / {"op":"moveColumns","tab":"Budget","from":"C","count"?:1,"to":"F"} move lines so the first lands at "to"; every reference follows.
- {"op":"moveTab","tab":"Q1","position":1} (1-based); {"op":"duplicateTab","tab":"Q1","name"?:"Q1 copy"}; {"op":"restoreTab","name"?:"Q1"} brings back a deleted tab (the last ${SHEET_LIMITS.deletedTabs} deletes are kept in "deletedTabs"; default the newest).
- {"op":"setFreeze","tab":"Budget","rows"?:1,"cols"?:0}; {"op":"setColumnWidth","tab":"Budget","columns":"B:D","width":140}; {"op":"fitColumns","tab":"Budget","columns":"A:F"} sizes columns to their text.
- {"op":"groupRows","tab":"Budget","from":3,"to":8,"collapsed"?:true} / {"op":"groupColumns","tab":"Budget","from":"B","to":"D","collapsed"?:false} group lines (a collapsed group hides them; calling it on an existing group folds or unfolds it); {"op":"ungroup","tab":"Budget","axis":"rows"|"columns","from":3,"to"?:8}. Stored as tab "rowGroups": [{"from":3,"to":8,"collapsed"?:true}] and "colGroups": [{"from":"B","to":"D"}]; groups never overlap.
- {"op":"setGridlines","tab":"Budget","show":false} (tab "gridlines": false); {"op":"setLocale","locale":"en-GB"|null} (workbook "locale": ${SHEET_LOCALES.join(' | ')}; formats numbers and dates and reads typed input); {"op":"setTimeZone","timeZone":"Europe/London"|null} (workbook "timeZone": the IANA zone TODAY() and NOW() use).
- {"op":"removeRule","tab":"Budget","id":"r1"}; {"op":"setChart","tab":"Budget","id":"chart-1","type"?:"line","range"?:"A1:C9","anchor"?:"H2","title"?:"..."|null,"width"?,"height"?,"seriesIn"?,"header"?,"xLabel"?,"yLabel"?,"legend"?,"stacked"?} (null removes a field); {"op":"removeChart","tab":"Budget","id":"chart-1"}.
- Charts may also be "pie" (one series; the first column labels the slices), "scatter" (x numbers in the first column) or "combo" (the first series as bars, the rest as lines), and "stacked": true stacks bar and area series. addChart makes bar/line/area; switch with setChart's "type": "pie"|"scatter"|"combo" (and "stacked"?: true).
- Round-5 cell fields: "font": ${FONT_FAMILIES.join(' | ')}; "indent": 1-10; "rotate": ${TEXT_ROTATIONS.join(' | ')}; "list": "bullet" | "number" (each line of the text is an item; typing "- a⏎- b" makes one); "pattern": an Excel-style number format ("#,##0.00", "0.0%", "\"$\"#,##0;[Red]-\"$\"#,##0", "#,##0,\"k\"", "yyyy-mm-dd", "h:mm AM/PM"); "people": [{"name": "Maya Lee"}] a person cell (display names only, never emails; "v" is the names joined by ", "). Fills/colours also take orange | purple | pink | teal. "++text++" is underline markup. =SPARKLINE(B2:M2, "line"|"bar"|"column") draws a tiny chart in its cell. Rule types "bars" (data bars, colour from style.bg) and "icons" ("icons": arrows | traffic | stars; thirds of the range's spread).
- setCells value objects besides v/f: {"formula":"=SUM(B2:B9)","value"?:..} (the value is ignored: the page computes it), {"date":"2026-11-20"}, {"time":"13:45"}, {"dateTime":"2026-11-20 13:45"}, {"markdown":"**Total** due"}, {"number":1234.5,"shown":"$1,234.50"} (formats it as shown), {"people":["Maya","Li"]}; give only one of them per cell.
- {"op":"importCsv","text":"name,amount\nMaya,12","tab"?:"Q2","at"?:"B2","name"?:"Raw data","delimiter"?:"comma"|"tab"} writes CSV (or TSV) with typed values: numbers, percents, currency, dates and booleans get their types, "=" fields stay text. With "tab" it fills that tab from "at" (default A1, growing it if needed); without, it adds a tab (header row frozen). To import a file from the workspace, read it with your normal file tools first, then pass its text here (split anything over 50,000 cells into several imports).
- {"op":"formatCells","tab":"Budget","range":"B2:B40","format":{"font"?:"Georgia","indent"?:2,"rotate"?:45,"list"?:"bullet","pattern"?:"#,##0.0"}} (null, or 0 for indent/rotate, removes).
- {"op":"setRowHeight","tab":"Budget","rows":"2:5","height":40|null}; {"op":"hideRows","tab":"Budget","rows":"7:9","hidden"?:false}; {"op":"hideColumns","tab":"Budget","columns":"C:D","hidden"?:false}.
- {"op":"addTable","tab":"Budget","range":"A1:E40","header"?:true,"banded"?:true,"color"?:"teal"}; {"op":"removeTable","tab":"Budget","id":"table-1"}; {"op":"updateRule","tab":"Budget","id":"r1","rule":{"value"?:25,"style"?:{...},"range"?:..}} changes a rule in place.
- Cleanup: {"op":"trimWhitespace","tab":"Budget","range":"A2:A40"}; {"op":"removeDuplicates","tab":"Budget","range":"A1:D40","columns"?:["A"],"header"?:true} (keeps the first of each, rows shift up inside the block); {"op":"splitColumn","tab":"Budget","range":"C2:C40","delimiter"?:"auto"|"comma"|"semicolon"|"tab"|"space"|"pipe"} (into the empty cells to the right); {"op":"convertText","tab":"Budget","range":"D2:D40","to":"number"|"date"}.
- {"op":"pasteSpecial","tab":"Budget","range":"A1:C9","to":"Q2!E1","mode":"values"|"formats"|"transpose"} (values: what the cells compute; formats: formatting only; transpose: rows become columns, formulas shift with each cell).
- generic {"op":"set"|"insert"|"remove","path":"/tabs/0/frozenRows","value":1} on a JSON pointer.
read_artifact with range {"tab":"Budget","range":"A1:D20"} returns each filled cell's computed value (and its formula), so you can check results. A read returns at most 10,000 cells; when it is cut short it says "truncated": true and "next": the rest of the range (same columns, the following rows); read "next" until it is absent to page through.`
