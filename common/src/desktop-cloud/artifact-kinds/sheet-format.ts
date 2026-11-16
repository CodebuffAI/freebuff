/**
 * Freebuff Sheets — showing values and reading what someone typed. Pure.
 *
 * Display is en-US unless the workbook names a `locale` (then Intl formats in it):
 * number 1,234.50 · currency $1,234.50 · percent 12.5% · date Nov 20, 2026.
 * A cell's `currency` picks the currency symbol (default USD).
 */

import { isError, isoToSerial, numberToText, serialToIso, type CellValue } from './sheet-formula'
import { cellRuns, parseRichText, richTextToMarkup } from './sheet-richtext'
import { peopleText, type CellFormat, type CellList, type Currency, type DateStyle, type SheetCell } from './sheet'

const grouped = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const currency = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})
const percent = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 2 })
const dateFormat = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
const DATE_FORMATS: Record<DateStyle, (date: Date) => string> = {
  short: (d) => `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`,
  medium: (d) => dateFormat.format(d),
  long: (d) =>
    new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(d),
  iso: (d) => d.toISOString().slice(0, 10),
}

const numberFormats = new Map<string, Intl.NumberFormat>()
function numberFormat(style: 'decimal' | 'currency' | 'percent', decimals: number, grouping: boolean): Intl.NumberFormat {
  const key = `${style}:${decimals}:${grouping}`
  let format = numberFormats.get(key)
  if (!format) {
    format = new Intl.NumberFormat('en-US', {
      style,
      ...(style === 'currency' ? { currency: 'USD' } : {}),
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
      useGrouping: grouping,
    })
    numberFormats.set(key, format)
  }
  return format
}

/** The display options a cell carries beside `fmt`, plus the workbook's locale. */
export type DisplayOptions = Pick<SheetCell, 'decimals' | 'dateStyle' | 'currency' | 'pattern'> & { locale?: string }

const localeFormats = new Map<string, Intl.NumberFormat | Intl.DateTimeFormat>()
function cached<T extends Intl.NumberFormat | Intl.DateTimeFormat>(key: string, make: () => T): T {
  let format = localeFormats.get(key) as T | undefined
  if (!format) {
    format = make()
    localeFormats.set(key, format)
  }
  return format
}

/** A number under a non-default locale or currency (the en-US/USD path below stays byte-identical). */
function localeNumber(value: number, fmt: CellFormat | undefined, options: DisplayOptions): string {
  const locale = options.locale ?? 'en-US'
  const decimals = options.decimals
  const style = fmt === 'currency' ? 'currency' : fmt === 'percent' ? 'percent' : 'decimal'
  const digits =
    decimals !== undefined
      ? { minimumFractionDigits: decimals, maximumFractionDigits: decimals }
      : fmt === 'percent'
        ? { maximumFractionDigits: 2 }
        : fmt === 'number'
          ? { minimumFractionDigits: 2, maximumFractionDigits: 2 }
          : fmt === 'currency'
            ? {}
            : { maximumFractionDigits: 10 }
  const grouping = fmt !== undefined || decimals === undefined
  const key = `n:${locale}:${style}:${options.currency ?? 'USD'}:${decimals ?? '-'}:${fmt ?? '-'}`
  return cached(key, () =>
    new Intl.NumberFormat(locale, {
      style,
      ...(style === 'currency' ? { currency: options.currency ?? 'USD' } : {}),
      ...digits,
      useGrouping: fmt === undefined ? false : grouping,
    }),
  ).format(value)
}

const LOCALE_DATE: Record<Exclude<DateStyle, 'iso'>, Intl.DateTimeFormatOptions> = {
  short: { day: 'numeric', month: 'numeric', year: 'numeric' },
  medium: { day: 'numeric', month: 'short', year: 'numeric' },
  long: { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' },
}

function localeDate(date: Date, style: DateStyle, locale: string): string {
  if (style === 'iso') return date.toISOString().slice(0, 10)
  return cached(`d:${locale}:${style}`, () => new Intl.DateTimeFormat(locale, { ...LOCALE_DATE[style], timeZone: 'UTC' })).format(date)
}

function localeTime(fraction: number, locale: string): string {
  const total = Math.round((((fraction % 1) + 1) % 1) * 86_400)
  return cached(`t:${locale}`, () => new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' })).format(
    new Date(total * 1000),
  )
}

const isDefaultLocale = (options: DisplayOptions) => !options.locale || options.locale === 'en-US'

const pad2 = (n: number) => String(n).padStart(2, '0')

/** h:mm AM/PM of a day fraction. */
function timeText(fraction: number, seconds = false): string {
  const total = Math.round((((fraction % 1) + 1) % 1) * 86_400)
  const h = Math.floor(total / 3600) % 24
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const hour = h % 12 === 0 ? 12 : h % 12
  return `${hour}:${pad2(m)}${seconds ? `:${pad2(s)}` : ''} ${h < 12 ? 'AM' : 'PM'}`
}

/** [h]:mm:ss of a number of days. */
function durationText(days: number): string {
  const sign = days < 0 ? '-' : ''
  const total = Math.round(Math.abs(days) * 86_400)
  return `${sign}${Math.floor(total / 3600)}:${pad2(Math.floor((total % 3600) / 60))}:${pad2(total % 60)}`
}

function serialToDate(serial: number): Date {
  return new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86_400_000)
}

/** The text a cell shows for `value` under `fmt` (and the cell's decimals / date style). */
export function formatValue(value: CellValue, fmt: CellFormat | undefined, options: DisplayOptions = {}): string {
  if (value === null) return ''
  if (isError(value)) return value.error
  if (options.pattern && typeof value !== 'boolean') {
    const shown = formatPattern(value, options.pattern, fmt)
    if (shown !== null) return shown.text
  }
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  const plainLocale = isDefaultLocale(options)
  const showDate = (serial: number) =>
    plainLocale
      ? (DATE_FORMATS[options.dateStyle ?? 'medium'] ?? dateFormat.format)(serialToDate(serial))
      : localeDate(serialToDate(serial), options.dateStyle ?? 'medium', options.locale!)
  const showTime = (fraction: number) => (plainLocale ? timeText(fraction) : localeTime(fraction, options.locale!))
  if (typeof value === 'string') {
    if (fmt === 'date' || fmt === 'datetime') {
      const serial = isoToSerial(value)
      if (serial !== null) return showDate(serial)
    }
    return value
  }
  const decimals = options.decimals
  const inDateRange = Number.isFinite(value) && value > -1 && value < 2_958_466
  if (Number.isFinite(value) && (!plainLocale || (fmt === 'currency' && options.currency && options.currency !== 'USD'))) {
    if (fmt === undefined || fmt === 'number' || fmt === 'currency' || fmt === 'percent') {
      // General numbers keep their plain digits (no grouping), as in en-US.
      if (fmt === undefined && decimals === undefined) return localeNumber(value, undefined, options).replace(/\s/g, '')
      return localeNumber(value, fmt, options)
    }
  }
  switch (fmt) {
    case 'number':
      return decimals === undefined ? grouped.format(value) : numberFormat('decimal', decimals, true).format(value)
    case 'currency':
      return decimals === undefined ? currency.format(value) : numberFormat('currency', decimals, true).format(value)
    case 'percent':
      return decimals === undefined ? percent.format(value) : numberFormat('percent', decimals, true).format(value)
    case 'date':
      return inDateRange ? showDate(value) : numberToText(value)
    case 'time':
      return Number.isFinite(value) ? showTime(value) : numberToText(value)
    case 'datetime':
      return inDateRange ? `${showDate(value)} ${showTime(value)}` : numberToText(value)
    case 'duration':
      return Number.isFinite(value) ? durationText(value) : numberToText(value)
    default:
      return decimals === undefined ? numberToText(value) : numberFormat('decimal', decimals, false).format(value)
  }
}

/** The text an editor starts with: the formula, or the literal as typed back (dates as ISO). */
export function editText(cell: SheetCell | undefined, options: InputOptions = {}): string {
  if (!cell) return ''
  if (cell.f !== undefined) return cell.f
  if (cell.v === undefined) return ''
  if (typeof cell.v === 'boolean') return cell.v ? 'TRUE' : 'FALSE'
  if (typeof cell.v === 'number') {
    const comma = decimalComma(options.locale)
    const n = (x: number) => (comma ? numberToText(x).replace('.', ',') : numberToText(x))
    if (cell.fmt === 'percent') return `${n(Number((cell.v * 100).toPrecision(15)))}%`
    if (cell.fmt === 'date') return serialToIso(cell.v)
    if (cell.fmt === 'time') return timeInput(cell.v)
    if (cell.fmt === 'datetime') return `${serialToIso(cell.v)} ${timeInput(cell.v)}`
    if (cell.fmt === 'duration') return durationText(cell.v)
    return n(cell.v)
  }
  const runs = cellRuns(cell)
  if (runs) return richTextToMarkup(runs)
  if (cell.list && typeof cell.v === 'string') return listMarkup(cell.v, cell.list)
  // Text that would read back as a number, formula or markup keeps a leading apostrophe.
  if (cell.fmt !== 'text' && cell.fmt !== 'date' && (parseInput(cell.v, options).v !== cell.v || parseRichText(cell.v))) return `'${cell.v}`
  return cell.v
}

export type ParsedInput = Pick<SheetCell, 'v' | 'f' | 'runs'> & { fmt?: CellFormat; currency?: Currency }

/** How typed input is read: the workbook's locale picks day-first dates and a decimal comma. */
export type InputOptions = {
  locale?: string
  /** Read **bold** / *italic* / [label](url) markup as rich text (default true; off for paste and CSV). */
  rich?: boolean
}

const MONTH_DAY_YEAR = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/
const DAY_FIRST = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/
const YEAR_FIRST = /^(\d{4})[./](\d{1,2})[./](\d{1,2})$/
const TIME = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?$/
const DATE_TIME = /^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}:\d{2}(?::\d{2})?\s*(?:[AaPp][Mm])?)$/
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
/** "Nov 20, 2026", "November 20 2026", "20 Nov 2026". */
const MONTH_NAME_FIRST = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/
const DAY_MONTH_NAME = /^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/
const CURRENCY_SYMBOLS: Record<string, Currency> = { $: 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY', '₹': 'INR', '₩': 'KRW' }
const COMMA_DECIMAL = new Set(['de', 'fr', 'es', 'it', 'nl', 'pt', 'sv', 'pl'])
const DAY_FIRST_LOCALES = new Set(['en-GB', 'en-IN', 'en-AU', 'de-DE', 'fr-FR', 'es-ES', 'it-IT', 'nl-NL', 'pt-BR', 'pl-PL'])

const decimalComma = (locale: string | undefined) => Boolean(locale && COMMA_DECIMAL.has(locale.slice(0, 2)))

/** 14:30 / 2:30 PM / 14:30:15 → a day fraction; `null` otherwise. */
export function parseTime(text: string): number | null {
  const match = TIME.exec(text.trim())
  if (!match) return null
  let h = Number(match[1])
  const m = Number(match[2])
  const s = Number(match[3] ?? 0)
  const meridiem = match[4]?.toUpperCase()
  if (m > 59 || s > 59) return null
  if (meridiem) {
    if (h < 1 || h > 12) return null
    h = (h % 12) + (meridiem === 'PM' ? 12 : 0)
  } else if (h > 23) return null
  return Number(((h * 3600 + m * 60 + s) / 86_400).toPrecision(15))
}

/** 24-hour h:mm[:ss], as an editor shows a time. */
function timeInput(serial: number): string {
  const total = Math.round((((serial % 1) + 1) % 1) * 86_400)
  const s = total % 60
  return `${Math.floor(total / 3600) % 24}:${pad2(Math.floor((total % 3600) / 60))}${s ? `:${pad2(s)}` : ''}`
}

/** A day as ISO when y/m/d is a real date. */
function isoDay(y: string, m: string, d: string): string | null {
  const iso = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
  return isoToSerial(iso) !== null ? iso : null
}

/** "Nov", "Nov." or "November" (a prefix of at least three letters; "Sept" too); -1 otherwise. */
function monthIndex(name: string): number {
  const lower = name.toLowerCase()
  return lower.length < 3 ? -1 : MONTHS.findIndex((month) => month.startsWith(lower))
}

/** A date someone typed, as ISO: ISO itself, the locale's numeric order, or an English month name. */
function parseDate(text: string, locale: string | undefined): string | null {
  if (isoToSerial(text) !== null) return text
  // 2026/11/20 is unambiguous in every locale.
  const year = YEAR_FIRST.exec(text)
  if (year) return isoDay(year[1], year[2], year[3])
  if (locale && DAY_FIRST_LOCALES.has(locale)) {
    const dmy = DAY_FIRST.exec(text)
    if (dmy) return isoDay(dmy[3], dmy[2], dmy[1])
  } else {
    const mdy = MONTH_DAY_YEAR.exec(text)
    if (mdy) return isoDay(mdy[3], mdy[1], mdy[2])
  }
  const named = MONTH_NAME_FIRST.exec(text)
  if (named && monthIndex(named[1]) >= 0) return isoDay(named[3], String(monthIndex(named[1]) + 1), named[2])
  const dayNamed = DAY_MONTH_NAME.exec(text)
  if (dayNamed && monthIndex(dayNamed[2]) >= 0) return isoDay(dayNamed[3], String(monthIndex(dayNamed[2]) + 1), dayNamed[1])
  return null
}

/** "1.234,5" (a comma-decimal locale) → "1234.5"; anything else unchanged. */
function localeDigits(text: string, locale: string | undefined): string {
  if (!decimalComma(locale)) return text.replace(/,(?=\d{3}(\D|$))/g, '')
  if (!/^[+-]?[\d.\s\u00a0\u202f]*,?\d*\s?%?$/.test(text) || !/\d/.test(text)) return text
  return text.replace(/[.\s\u00a0\u202f](?=\d{3}(\D|$))/g, '').replace(',', '.')
}

/** `$1,200`, `-$5`, `$-5`, `€5`, `5 €`, `£1.234,50` (comma-decimal locale) → a currency value. */
function parseMoney(text: string, locale: string | undefined): ParsedInput | null {
  const prefix = /^(-)?([$€£¥₹₩])\s?(-)?([0-9.,\s\u00a0]+)$/.exec(text)
  const suffix = prefix ? null : /^(-)?([0-9.,\s\u00a0]+?)\s?([$€£¥₹₩])$/.exec(text)
  if (!prefix && !suffix) return null
  const negative = prefix ? Boolean(prefix[1] || prefix[3]) : Boolean(suffix![1])
  const symbol = prefix ? prefix[2] : suffix![3]
  const amount = (prefix ? prefix[4] : suffix![2]).trim()
  const digits = localeDigits(amount, locale).replace(/,/g, '').replace(/[\s\u00a0]/g, '')
  if (!/^(\d+\.?\d*|\.\d+)$/.test(digits)) return null
  const n = Number(digits)
  const currency = CURRENCY_SYMBOLS[symbol]
  return { v: negative ? -n : n, fmt: 'currency', ...(currency !== 'USD' ? { currency } : {}) }
}

/**
 * What someone typed, as cell content: `=…` a formula, `TRUE`/`FALSE` a boolean,
 * `1,234.5` a number, `$1,200` / `€5` / `5 £` currency, `12%` a percent, `2026-11-20`,
 * `11/20/2026` (day first in day-first locales) or `Nov 20, 2026` a date, `13:45` / `1:45 PM` a
 * time, **bold** / *italic* / ~~strike~~ / [label](url) rich text, a leading `'` forces text.
 * Empty input clears the value. The agent's `setCells` reads strings through this too.
 */
export function parseInput(raw: string, options: InputOptions = {}): ParsedInput {
  if (raw.startsWith("'")) return { v: raw.slice(1), fmt: 'text' }
  const text = raw.trim()
  if (text === '') return {}
  if (text.startsWith('=') && text.length > 1) return { f: text }
  const upper = text.toUpperCase()
  if (upper === 'TRUE' || upper === 'FALSE') return { v: upper === 'TRUE' }
  const plain = localeDigits(text, options.locale)
  if (/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(plain)) return { v: Number(plain) }
  const money = parseMoney(text, options.locale)
  if (money) return money
  const pct = /^([+-]?(\d+\.?\d*|\.\d+))\s?%$/.exec(plain)
  if (pct) return { v: Number((Number(pct[1]) / 100).toPrecision(15)), fmt: 'percent' }
  const date = parseDate(text, options.locale)
  if (date) return { v: date, fmt: 'date' }
  const time = parseTime(text)
  if (time !== null) return { v: time, fmt: 'time' }
  const dateTime = DATE_TIME.exec(text)
  if (dateTime) {
    const day = isoToSerial(dateTime[1])
    const t = parseTime(dateTime[2])
    if (day !== null && t !== null) return { v: Number((day + t).toPrecision(15)), fmt: 'datetime' }
  }
  const rich = options.rich === false ? null : parseRichText(raw)
  if (rich) return { v: rich.text, runs: rich.runs }
  return { v: raw }
}

/**
 * Apply typed input to a cell, keeping its styling. A typed number in a cell that already
 * has a number format keeps that format; a recognised currency/percent/date sets one.
 * Returns `undefined` when nothing is left (the cell is pruned).
 */
export function applyInput(cell: SheetCell | undefined, raw: string, options: InputOptions = {}): SheetCell | undefined {
  // Typing replaces a person cell's people and a list's items (the list comes back from the markup).
  const { v: _v, f: _f, fmt: oldFmt, runs: _runs, currency: oldCurrency, people: _people, list: _list, ...style } = cell ?? {}
  // A text cell keeps what was typed ("0012" stays text), unless it is a formula.
  const duration = oldFmt === 'duration' ? /^(-)?(\d+):(\d{2})(?::(\d{2}))?$/.exec(raw.trim()) : null
  const parsed: ParsedInput = duration
    ? {
        v: Number(
          ((duration[1] ? -1 : 1) * (Number(duration[2]) * 3600 + Number(duration[3]) * 60 + Number(duration[4] ?? 0)) / 86_400).toPrecision(15),
        ),
        fmt: 'duration',
      }
    : oldFmt === 'text' && !raw.trim().startsWith('=')
      ? { v: raw.startsWith("'") ? raw.slice(1) : raw }
      : parseInput(raw, options)
  const next: SheetCell = { ...style }
  const listed = parsed.f === undefined && typeof parsed.v === 'string' && !parsed.runs && oldFmt !== 'text' ? parseListInput(parsed.v) : null
  if (listed) {
    parsed.v = listed.text
    next.list = listed.list
  }
  if (parsed.f !== undefined) next.f = parsed.f
  if (parsed.v !== undefined) next.v = parsed.v
  if (parsed.runs) next.runs = parsed.runs
  const fmt = parsed.fmt ?? (typeof parsed.v === 'number' || parsed.f !== undefined ? oldFmt : oldFmt === 'text' ? 'text' : undefined)
  if (fmt) next.fmt = fmt
  const currency = parsed.fmt === 'currency' ? parsed.currency : fmt === oldFmt ? oldCurrency : undefined
  if (currency && fmt === 'currency') next.currency = currency
  return pruneCell(next)
}

/** `undefined` for a cell with nothing in it. */
export function pruneCell(cell: SheetCell): SheetCell | undefined {
  const out: SheetCell = {}
  if (cell.v !== undefined && cell.v !== '') out.v = cell.v
  if (cell.f !== undefined) out.f = cell.f
  if (cell.fmt) out.fmt = cell.fmt
  if (cell.bold) out.bold = true
  if (cell.align) out.align = cell.align
  if (cell.bg) out.bg = cell.bg
  if (cell.italic) out.italic = true
  if (cell.underline) out.underline = true
  if (cell.strike) out.strike = true
  if (cell.color) out.color = cell.color
  if (cell.size !== undefined) out.size = cell.size
  if (cell.wrap) out.wrap = true
  if (cell.valign) out.valign = cell.valign
  if (cell.border && Object.values(cell.border).some(Boolean)) {
    const border: NonNullable<SheetCell['border']> = {}
    for (const side of ['top', 'right', 'bottom', 'left'] as const) if (cell.border[side]) border[side] = cell.border[side]
    out.border = border
  }
  if (cell.decimals !== undefined) out.decimals = cell.decimals
  if (cell.dateStyle) out.dateStyle = cell.dateStyle
  if (cell.note) out.note = cell.note
  if (cell.currency) out.currency = cell.currency
  if (cell.link) out.link = cell.link
  // Runs only while they still spell the text exactly.
  const runs = cellRuns(cell)
  if (runs) out.runs = runs
  if (cell.font) out.font = cell.font
  if (cell.indent) out.indent = cell.indent
  if (cell.rotate) out.rotate = cell.rotate
  if (cell.list && typeof out.v === 'string') out.list = cell.list
  // People only while they still spell the text exactly.
  const people = cellPeople(cell)
  if (people) out.people = people
  if (cell.pattern) out.pattern = cell.pattern
  return Object.keys(out).length === 0 ? undefined : out
}

/** Default alignment: numbers right, booleans and errors centred, text left. */
export function defaultAlign(value: CellValue): 'left' | 'center' | 'right' {
  if (typeof value === 'number') return 'right'
  if (typeof value === 'boolean' || isError(value)) return 'center'
  return 'left'
}


// ---- custom number formats (round 5)

/** Split a pattern on `;` outside quotes and brackets. */
function patternSections(pattern: string): string[] {
  const out: string[] = []
  let current = ''
  let quoted = false
  let bracket = false
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]
    if (ch === '\\' && i + 1 < pattern.length && !quoted) {
      current += ch + pattern[i + 1]
      i += 1
      continue
    }
    if (ch === '"') quoted = !quoted
    else if (!quoted && ch === '[') bracket = true
    else if (!quoted && ch === ']') bracket = false
    if (ch === ';' && !quoted && !bracket) {
      out.push(current)
      current = ''
    } else current += ch
  }
  out.push(current)
  return out.slice(0, 4)
}

const PATTERN_COLORS: Record<string, string> = { red: 'red', green: 'green', blue: 'blue', yellow: 'yellow', gray: 'gray', grey: 'gray' }
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** Tokens of one section: literals (quoted, escaped, other symbols) and format characters. */
type PatternToken = { literal: string } | { code: string }
function tokenize(section: string): { tokens: PatternToken[]; color?: string } {
  const tokens: PatternToken[] = []
  let color: string | undefined
  let i = 0
  while (i < section.length) {
    const ch = section[i]
    if (ch === '"') {
      const end = section.indexOf('"', i + 1)
      tokens.push({ literal: section.slice(i + 1, end === -1 ? section.length : end) })
      i = end === -1 ? section.length : end + 1
    } else if (ch === '\\' && i + 1 < section.length) {
      tokens.push({ literal: section[i + 1] })
      i += 2
    } else if (ch === '[') {
      const end = section.indexOf(']', i)
      const inner = section.slice(i + 1, end === -1 ? section.length : end).toLowerCase()
      if (PATTERN_COLORS[inner]) color = PATTERN_COLORS[inner]
      i = end === -1 ? section.length : end + 1
    } else if (ch === '_' || ch === '*') {
      // Excel's padding codes: a space, and skip the character they pad with.
      if (ch === '_') tokens.push({ literal: ' ' })
      i += 2
    } else if (/^(AM\/PM|A\/P)/i.test(section.slice(i))) {
      const m = /^(AM\/PM|A\/P)/i.exec(section.slice(i))![0]
      tokens.push({ code: m.toUpperCase() })
      i += m.length
    } else if (/[0#?.,%Ee@ymdhs]/.test(ch)) {
      let j = i
      if (/[ymdhs]/i.test(ch)) while (j < section.length && section[j].toLowerCase() === ch.toLowerCase()) j += 1
      else if (/[Ee]/.test(ch) && /[+-]/.test(section[i + 1] ?? '')) j = i + 2
      else j = i + 1
      tokens.push({ code: section.slice(i, j) })
      i = j
    } else {
      tokens.push({ literal: ch })
      i += 1
    }
  }
  return { tokens, color }
}

const isDateCode = (code: string) => /^[ymdhs]+$/i.test(code) || code === 'AM/PM' || code === 'A/P'

function formatDatePattern(serial: number, tokens: PatternToken[]): string {
  const day = Math.floor(serial)
  const date = new Date(Date.UTC(1899, 11, 30) + day * 86_400_000)
  const seconds = Math.round((serial - day) * 86_400)
  const hours = Math.floor(seconds / 3600) % 24
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = seconds % 60
  const twelve = tokens.some((t) => 'code' in t && (t.code === 'AM/PM' || t.code === 'A/P'))
  let out = ''
  tokens.forEach((token, index) => {
    if ('literal' in token) {
      out += token.literal
      return
    }
    const code = token.code
    if (!isDateCode(code)) {
      // Digits, commas and points in a date pattern are just text.
      out += code
      return
    }
    const lower = code.toLowerCase()
    // "m" after an hour or before a second is minutes, as in Excel.
    const prev = tokens.slice(0, index).reverse().find((t) => 'code' in t && isDateCode(t.code)) as { code: string } | undefined
    const next = tokens.slice(index + 1).find((t) => 'code' in t && isDateCode(t.code)) as { code: string } | undefined
    const minuteContext = lower[0] === 'm' && lower.length <= 2 && (prev?.code.toLowerCase().startsWith('h') || next?.code.toLowerCase().startsWith('s'))
    if (lower[0] === 'y') out += lower.length <= 2 ? String(date.getUTCFullYear()).slice(-2) : String(date.getUTCFullYear())
    else if (lower[0] === 'm' && minuteContext) out += lower.length === 2 ? pad2(minutes) : String(minutes)
    else if (lower[0] === 'm') {
      const month = date.getUTCMonth()
      out += lower.length === 1 ? String(month + 1) : lower.length === 2 ? pad2(month + 1) : lower.length === 3 ? MONTH_NAMES[month].slice(0, 3) : MONTH_NAMES[month]
    } else if (lower[0] === 'd') {
      const d = date.getUTCDate()
      out += lower.length === 1 ? String(d) : lower.length === 2 ? pad2(d) : lower.length === 3 ? DAY_NAMES[date.getUTCDay()].slice(0, 3) : DAY_NAMES[date.getUTCDay()]
    } else if (lower[0] === 'h') {
      const h = twelve ? (hours % 12 === 0 ? 12 : hours % 12) : hours
      out += lower.length >= 2 ? pad2(h) : String(h)
    } else if (lower[0] === 's') out += lower.length >= 2 ? pad2(secs) : String(secs)
    else if (code === 'AM/PM') out += hours < 12 ? 'AM' : 'PM'
    else if (code === 'A/P') out += hours < 12 ? 'A' : 'P'
  })
  return out
}

function formatNumberPattern(value: number, tokens: PatternToken[]): string {
  const codes = tokens.filter((t): t is { code: string } => 'code' in t).map((t) => t.code)
  const percent = codes.filter((c) => c === '%').length
  const sci = codes.findIndex((c) => /^E[+-]$/i.test(c))
  let n = value * 100 ** percent
  const digitCodes = (list: string[]) => list.filter((c) => c === '0' || c === '#' || c === '?')
  const pointAt = codes.indexOf('.')
  const mantissaCodes = sci === -1 ? codes : codes.slice(0, sci)
  const intCodes = pointAt === -1 || (sci !== -1 && pointAt > sci) ? mantissaCodes : codes.slice(0, pointAt)
  const fracCodes = pointAt === -1 || (sci !== -1 && pointAt > sci) ? [] : digitCodes(codes.slice(pointAt + 1, sci === -1 ? undefined : sci))
  // A trailing comma after the last digit scales by 1,000 each.
  const lastDigit = Math.max(codes.lastIndexOf('0'), codes.lastIndexOf('#'))
  let scale = 0
  for (let i = lastDigit + 1; i < codes.length && codes[i] === ','; i += 1) scale += 1
  n /= 1000 ** scale
  const grouping = intCodes.some((c, i) => c === ',' && i < intCodes.length - 1 && i > 0)
  let exponent = 0
  if (sci !== -1 && n !== 0) {
    const intDigits = Math.max(1, digitCodes(intCodes).length)
    exponent = Math.floor(Math.log10(Math.abs(n))) - (intDigits - 1)
    n /= 10 ** exponent
  }
  const fixed = Math.abs(n).toFixed(fracCodes.length)
  let [intPart, fracPart = ''] = fixed.split('.')
  const minInt = digitCodes(intCodes).filter((c) => c === '0').length
  if (intPart === '0' && minInt === 0) intPart = ''
  intPart = intPart.padStart(minInt, '0')
  if (grouping) intPart = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  // Optional decimals (#) drop trailing zeros.
  const required = fracCodes.filter((c) => c === '0').length
  while (fracPart.length > required && fracPart.endsWith('0')) fracPart = fracPart.slice(0, -1)
  const numberText = `${intPart}${fracCodes.length && fracPart ? `.${fracPart}` : ''}`
  const exponentText =
    sci === -1 ? '' : `E${exponent < 0 ? '-' : codes[sci][1] === '+' ? '+' : ''}${String(Math.abs(exponent)).padStart(digitCodes(codes.slice(sci + 1)).length || 1, '0')}`
  // Literals keep their place around the number: before the first digit, after the last.
  let out = ''
  let wroteNumber = false
  for (const token of tokens) {
    if ('literal' in token) out += token.literal
    else if (token.code === '%') out += '%'
    else if (/^E[+-]$/i.test(token.code)) {
      out += exponentText
    } else if (!wroteNumber && /[0#?.,]/.test(token.code)) {
      out += numberText
      wroteNumber = true
    }
  }
  if (!wroteNumber) out += numberText
  return out
}

/**
 * `value` shown through an Excel-style pattern (a practical subset): `0`, `#`, `,` grouping,
 * `.` decimals, `%`, `0.00E+00`, quoted or `\\`-escaped text, `[Red]` colours, sections
 * `positive;negative;zero;text`, `@` for the text itself, and dates/times (`yyyy-mm-dd`,
 * `mmm d`, `dddd`, `h:mm AM/PM`). Null when the pattern does not apply (a text value with no
 * text section, or an empty section list).
 */
export function formatPattern(value: number | string, pattern: string, fmt?: CellFormat): { text: string; color?: string } | null {
  const sections = patternSections(pattern)
  if (typeof value === 'string') {
    // A date cell's ISO text formats as its day.
    const serial = fmt === 'date' || fmt === 'datetime' ? isoToSerial(value) : null
    if (serial !== null) return formatPattern(serial, pattern)
    const textSection = sections.length >= 4 ? sections[3] : sections.find((s) => s.includes('@'))
    if (!textSection) return null
    const { tokens, color } = tokenize(textSection)
    return { text: tokens.map((t) => ('literal' in t ? t.literal : t.code === '@' ? value : '')).join(''), color }
  }
  if (!Number.isFinite(value)) return null
  const pick = value < 0 && sections.length >= 2 ? 1 : value === 0 && sections.length >= 3 ? 2 : 0
  const { tokens, color } = tokenize(sections[pick] ?? sections[0])
  const isDate = tokens.some((t) => 'code' in t && isDateCode(t.code))
  if (isDate) return { text: formatDatePattern(value, tokens), color }
  // A negative in its own section shows without the minus (the section spells the sign).
  const magnitude = pick === 1 ? Math.abs(value) : value
  const body = formatNumberPattern(magnitude, tokens)
  return { text: magnitude < 0 && !body.startsWith('-') ? `-${body}` : body, color }
}

/** Example patterns the number-format editor offers. */
export const PATTERN_PRESETS: ReadonlyArray<{ pattern: string; label: string }> = [
  { pattern: '#,##0', label: 'Whole number' },
  { pattern: '#,##0.00', label: 'Two decimals' },
  { pattern: '0.0%', label: 'Percent, one decimal' },
  { pattern: '"$"#,##0;[Red]-"$"#,##0', label: 'Dollars, negatives red' },
  { pattern: '#,##0,"k"', label: 'Thousands (12k)' },
  { pattern: '0.00E+00', label: 'Scientific' },
  { pattern: 'yyyy-mm-dd', label: 'ISO date' },
  { pattern: 'dddd, mmmm d', label: 'Weekday and date' },
  { pattern: 'h:mm AM/PM', label: '12-hour time' },
]

// ---- in-cell lists and people (round 5)

const BULLET = /^\s*[-•*]\s+/
const NUMBERED = /^\s*\d{1,3}[.)]\s+/

/** Lines typed as a list ("- a⏎- b" or "1. a⏎2. b", two or more): the list kind and its items. */
export function parseListInput(raw: string): { list: CellList; text: string } | null {
  const lines = raw.split('\n')
  if (lines.length < 2 || lines.some((line) => !line.trim())) return null
  if (lines.every((line) => BULLET.test(line))) return { list: 'bullet', text: lines.map((l) => l.replace(BULLET, '')).join('\n') }
  if (lines.every((line) => NUMBERED.test(line))) return { list: 'number', text: lines.map((l) => l.replace(NUMBERED, '')).join('\n') }
  return null
}

/** A list cell's text as the editor shows it: the markers back in front of each item. */
export function listMarkup(text: string, list: CellList): string {
  return text
    .split('\n')
    .map((line, i) => `${list === 'bullet' ? '-' : `${i + 1}.`} ${line}`)
    .join('\n')
}

/** The people a cell shows, or null when its text no longer matches them (a stale edit). */
export function cellPeople(cell: SheetCell | undefined): NonNullable<SheetCell['people']> | null {
  if (!cell?.people?.length || typeof cell.v !== 'string') return null
  return peopleText(cell.people) === cell.v ? cell.people : null
}
