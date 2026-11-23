/**
 * Freebuff Sheets — the formula engine. Pure TypeScript, no React, no DOM.
 *
 * - `tokenize` / `parseFormula`: Excel-style formulas into an AST.
 * - `SheetEngine`: computes every formula of a workbook in dependency order
 *   (Kahn's algorithm, iterative, so a 10k-row running total cannot overflow
 *   the stack), marks cycles `#CYCLE!`, and on `update(next)` recomputes only
 *   the cells downstream of what changed.
 * - `rewriteFormula` and its users (`shiftFormula`, `renameTabInFormula`,
 *   `normalizeFormula`): token-level edits that keep the author's spacing.
 *
 * Semantics follow Excel where it matters to an everyday sheet: precedence
 * (unary minus binds tighter than `^`, `^` is left-associative, postfix `%`),
 * blanks are 0 in arithmetic and "" in text, ranges skip text in SUM, text
 * compares case-insensitively, and numbers < text < booleans when compared.
 * Dates are serial day numbers (1899-12-30 is day 0), computed in UTC.
 *
 * Arrays: `A1:A5*2`, a bare `=A1:B5` and the array functions (UNIQUE, SORT,
 * FILTER, SEQUENCE, TRANSPOSE, ...) give a block that SPILLS from the formula's
 * cell down and right. A spill that would cover a filled cell (or run off the
 * tab) is `#SPILL!`; `A1#` reads the whole block spilled from A1. Spilled
 * values are computed only, never stored in the workbook. Because a spill's
 * size is known only after evaluating it, readers of spilled cells are
 * re-run after it in extra rounds (see `settleSpills`), incrementally.
 * `FUNCTION_SIGNATURES` describes every name in `SUPPORTED_FUNCTIONS`.
 */

import { parseAddress, parseSheetRange, type CellRect } from './sheet-address'
import { tabCols, tabRows, type SheetCell, type Workbook } from './sheet'

// ============================================================ values

export const ERROR_CODES = [
  '#DIV/0!',
  '#REF!',
  '#NAME?',
  '#VALUE!',
  '#N/A',
  '#NUM!',
  '#CYCLE!',
  '#ERROR!',
  // A spilled array whose cells are taken (or that runs off the tab).
  '#SPILL!',
  // An array function with nothing to return (FILTER with no match and no fallback).
  '#CALC!',
] as const
export type ErrorCode = (typeof ERROR_CODES)[number]
export type SheetError = { readonly error: ErrorCode }

/** A computed cell value. `null` is a blank cell. */
export type CellValue = number | string | boolean | null | SheetError

const errors = Object.fromEntries(ERROR_CODES.map((code) => [code, Object.freeze({ error: code })])) as Record<
  ErrorCode,
  SheetError
>
export const sheetError = (code: ErrorCode): SheetError => errors[code]

export function isError(value: unknown): value is SheetError {
  return typeof value === 'object' && value !== null && 'error' in value
}

// ---- dates

const DAY_MS = 86_400_000
const EPOCH = Date.UTC(1899, 11, 30)
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

export function dateToSerial(year: number, month: number, day: number): number {
  return Math.round((Date.UTC(year, month - 1, day) - EPOCH) / DAY_MS)
}

/** `2026-11-20` → its serial day number; `null` for anything else (including 2026-02-30). */
export function isoToSerial(iso: string): number | null {
  const match = ISO_DATE.exec(iso)
  if (!match) return null
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const date = new Date(Date.UTC(y, m - 1, d))
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null
  return dateToSerial(y, m, d)
}

export function serialToIso(serial: number): string {
  const date = new Date(EPOCH + Math.floor(serial) * DAY_MS)
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
}

/** The value a literal cell contributes to formulas. A `date` cell's ISO text reads as its serial. */
export function literalValue(cell: SheetCell | undefined): CellValue {
  if (!cell || cell.v === undefined || cell.v === '') return null
  if (cell.fmt === 'date' && typeof cell.v === 'string') {
    const serial = isoToSerial(cell.v)
    if (serial !== null) return serial
  }
  return cell.v
}

// ---- coercion

/** Excel's General display for a number inside text: no grouping, at most 15 significant digits. */
export function numberToText(n: number): string {
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n)
  const text = Number(n.toPrecision(15)).toString()
  return text
}

function toText(value: CellValue): string | SheetError {
  if (isError(value)) return value
  if (value === null) return ''
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  if (typeof value === 'number') return numberToText(value)
  return value
}

const NUMERIC_TEXT = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i

function textToNumber(text: string): number | null {
  const t = text.trim()
  if (t === '') return null
  if (NUMERIC_TEXT.test(t)) return Number(t)
  if (t.endsWith('%') && NUMERIC_TEXT.test(t.slice(0, -1).trim())) return Number(t.slice(0, -1)) / 100
  return isoToSerial(t)
}

function toNumber(value: CellValue): number | SheetError {
  if (isError(value)) return value
  if (value === null) return 0
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'number') return value
  return textToNumber(value) ?? errors['#VALUE!']
}

function toBoolean(value: CellValue): boolean | SheetError {
  if (isError(value)) return value
  if (value === null) return false
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  const upper = value.trim().toUpperCase()
  if (upper === 'TRUE') return true
  if (upper === 'FALSE') return false
  return errors['#VALUE!']
}

const finite = (n: number): number | SheetError => (Number.isFinite(n) ? n : errors['#NUM!'])

const typeRank = (v: number | string | boolean) => (typeof v === 'number' ? 0 : typeof v === 'string' ? 1 : 2)

/** -1, 0 or 1, Excel's ordering. Blank takes the other side's empty value. */
export function compareValues(a: number | string | boolean | null, b: number | string | boolean | null): number {
  const empty = (other: number | string | boolean | null) =>
    typeof other === 'string' ? '' : typeof other === 'boolean' ? false : 0
  const x = a === null ? empty(b) : a
  const y = b === null ? empty(a) : b
  const rx = typeRank(x)
  const ry = typeRank(y)
  if (rx !== ry) return rx < ry ? -1 : 1
  if (typeof x === 'string' && typeof y === 'string') {
    const lx = x.toLowerCase()
    const ly = y.toLowerCase()
    return lx === ly ? 0 : lx < ly ? -1 : 1
  }
  const nx = Number(x)
  const ny = Number(y)
  return nx === ny ? 0 : nx < ny ? -1 : 1
}

// ============================================================ tokens

export type Token =
  | { t: 'num'; v: number; start: number; end: number }
  | { t: 'str'; v: string; start: number; end: number }
  | { t: 'bool'; v: boolean; start: number; end: number }
  | { t: 'err'; v: ErrorCode; start: number; end: number }
  | {
      t: 'ref'
      sheet?: string
      /** Source span of the `Sheet!` prefix, when there is one. */
      sheetSpan?: [number, number]
      col: number
      row: number
      absCol: boolean
      absRow: boolean
      /** `A1#`: the whole array spilled from A1 (the span includes the `#`). */
      spill?: boolean
      /** Span of the cell part (after any prefix). */
      start: number
      end: number
    }
  | {
      t: 'colref'
      sheet?: string
      sheetSpan?: [number, number]
      col: number
      absCol: boolean
      start: number
      end: number
    }
  | { t: 'func'; name: string; start: number; end: number }
  | { t: 'name'; name: string; start: number; end: number }
  | { t: 'op'; v: string; start: number; end: number }
  | { t: '(' | ')' | ',' | ':'; start: number; end: number }

const CELL_REF = /^(\$?)([A-Za-z]{1,3})(\$?)([0-9]{1,7})$/
const COL_REF = /^(\$?)([A-Za-z]{1,3})$/
const WORD_CHAR = /[A-Za-z0-9_.$]/

function colOf(letters: string): number {
  let n = 0
  const upper = letters.toUpperCase()
  for (let i = 0; i < upper.length; i += 1) n = n * 26 + (upper.charCodeAt(i) - 64)
  return n - 1
}

class FormulaSyntaxError extends Error {}

/** Tokens of a formula's body (the text after `=`). Throws `FormulaSyntaxError`. */
export function tokenize(body: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  const n = body.length
  while (i < n) {
    const ch = body[i]
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i += 1
      continue
    }
    const start = i
    if (/[0-9.]/.test(ch) && !(ch === '.' && !/[0-9]/.test(body[i + 1] ?? ''))) {
      // Row-only ranges (`1:1`) are not supported; digits are always a number.
      const match = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(body.slice(i))
      if (!match) throw new FormulaSyntaxError('bad number')
      i += match[0].length
      tokens.push({ t: 'num', v: Number(match[0]), start, end: i })
      continue
    }
    if (ch === '"') {
      let text = ''
      i += 1
      for (;;) {
        if (i >= n) throw new FormulaSyntaxError('unterminated string')
        if (body[i] === '"') {
          if (body[i + 1] === '"') {
            text += '"'
            i += 2
            continue
          }
          i += 1
          break
        }
        text += body[i]
        i += 1
      }
      tokens.push({ t: 'str', v: text, start, end: i })
      continue
    }
    if (ch === '#') {
      // `A1#` right after a cell reference: the spill operator.
      const last = tokens[tokens.length - 1]
      if (last && last.t === 'ref' && last.end === i && !last.spill && !ERROR_CODES.some((c) => body.toUpperCase().startsWith(c, i))) {
        last.spill = true
        last.end = i + 1
        i += 1
        continue
      }
      const code = ERROR_CODES.find((c) => body.startsWith(c, i) || body.toUpperCase().startsWith(c, i))
      if (!code) throw new FormulaSyntaxError('bad error literal')
      i += code.length
      tokens.push({ t: 'err', v: code, start, end: i })
      continue
    }
    let sheet: string | undefined
    let sheetSpan: [number, number] | undefined
    if (ch === "'") {
      // A quoted sheet name: 'Q4 plan'!A1
      let name = ''
      i += 1
      for (;;) {
        if (i >= n) throw new FormulaSyntaxError('unterminated sheet name')
        if (body[i] === "'") {
          if (body[i + 1] === "'") {
            name += "'"
            i += 2
            continue
          }
          i += 1
          break
        }
        name += body[i]
        i += 1
      }
      if (body[i] !== '!') throw new FormulaSyntaxError('expected ! after sheet name')
      i += 1
      sheet = name
      sheetSpan = [start, i]
    }
    if (sheet !== undefined || /[A-Za-z_$]/.test(ch)) {
      const wordStart = i
      while (i < n && WORD_CHAR.test(body[i])) i += 1
      let word = body.slice(wordStart, i)
      if (sheet === undefined && body[i] === '!') {
        // An unquoted sheet name: Budget!A1
        sheet = word
        sheetSpan = [wordStart, i + 1]
        i += 1
        const refStart = i
        while (i < n && WORD_CHAR.test(body[i])) i += 1
        word = body.slice(refStart, i)
        if (!pushRef(tokens, word, refStart, i, sheet, sheetSpan, body)) {
          throw new FormulaSyntaxError('bad reference after sheet name')
        }
        continue
      }
      if (sheet !== undefined) {
        if (!pushRef(tokens, word, wordStart, i, sheet, sheetSpan, body)) {
          throw new FormulaSyntaxError('bad reference after sheet name')
        }
        continue
      }
      // Skip spaces to see whether a `(` follows (a function call).
      let j = i
      while (j < n && body[j] === ' ') j += 1
      if (body[j] === '(' && /^[A-Za-z_][A-Za-z0-9_.]*$/.test(word)) {
        tokens.push({ t: 'func', name: word.toUpperCase(), start: wordStart, end: i })
        continue
      }
      if (pushRef(tokens, word, wordStart, i, undefined, undefined, body)) continue
      const upper = word.toUpperCase()
      if (upper === 'TRUE' || upper === 'FALSE') {
        tokens.push({ t: 'bool', v: upper === 'TRUE', start: wordStart, end: i })
        continue
      }
      tokens.push({ t: 'name', name: word, start: wordStart, end: i })
      continue
    }
    const two = body.slice(i, i + 2)
    if (two === '<=' || two === '>=' || two === '<>') {
      i += 2
      tokens.push({ t: 'op', v: two, start, end: i })
      continue
    }
    if ('+-*/^&=<>%'.includes(ch)) {
      i += 1
      tokens.push({ t: 'op', v: ch, start, end: i })
      continue
    }
    if (ch === '(' || ch === ')' || ch === ',' || ch === ':') {
      i += 1
      tokens.push({ t: ch as '(' | ')' | ',' | ':', start, end: i })
      continue
    }
    if (ch === ';') {
      // Some locales separate arguments with `;`.
      i += 1
      tokens.push({ t: ',', start, end: i })
      continue
    }
    throw new FormulaSyntaxError(`unexpected "${ch}"`)
  }
  return tokens
}

/** Push a cell or column reference token for `word`; false when `word` is neither. */
function pushRef(
  tokens: Token[],
  word: string,
  start: number,
  end: number,
  sheet: string | undefined,
  sheetSpan: [number, number] | undefined,
  body: string,
): true | false {
  const cell = CELL_REF.exec(word)
  if (cell) {
    tokens.push({
      t: 'ref',
      ...(sheet !== undefined ? { sheet, sheetSpan } : {}),
      absCol: cell[1] === '$',
      col: colOf(cell[2]),
      absRow: cell[3] === '$',
      row: Number(cell[4]) - 1,
      start,
      end,
    })
    return true
  }
  const col = COL_REF.exec(word)
  // A bare column (`A` in `A:C`) only counts when a `:` touches it on either side.
  if (col && (body[end] === ':' || body[start - 1] === ':')) {
    tokens.push({
      t: 'colref',
      ...(sheet !== undefined ? { sheet, sheetSpan } : {}),
      absCol: col[1] === '$',
      col: colOf(col[2]),
      start,
      end,
    })
    return true
  }
  return false
}

// ============================================================ AST

export type FormulaNode =
  | { k: 'num'; v: number }
  | { k: 'str'; v: string }
  | { k: 'bool'; v: boolean }
  | { k: 'err'; code: ErrorCode }
  | { k: 'ref'; sheet?: string; row: number; col: number }
  /** `A1#`: the array spilled from the formula in A1. */
  | { k: 'spill'; sheet?: string; row: number; col: number }
  | { k: 'range'; sheet?: string; top: number; left: number; bottom: number; right: number; wholeCols: boolean }
  | { k: 'name'; name: string }
  | { k: 'call'; name: string; args: FormulaNode[] }
  | { k: 'neg'; a: FormulaNode }
  | { k: 'pct'; a: FormulaNode }
  | { k: 'bin'; op: string; a: FormulaNode; b: FormulaNode }

const INFIX_BP: Record<string, number> = {
  '=': 1,
  '<>': 1,
  '<': 1,
  '>': 1,
  '<=': 1,
  '>=': 1,
  '&': 2,
  '+': 3,
  '-': 3,
  '*': 4,
  '/': 4,
  '^': 5,
}
const PREFIX_BP = 6
const POSTFIX_BP = 7
const MAX_DEPTH = 64

/** Parse a formula (with or without its leading `=`). Throws on a syntax error. */
export function parseFormula(source: string): FormulaNode {
  const body = source.startsWith('=') ? source.slice(1) : source
  const tokens = tokenize(body)
  let pos = 0
  let depth = 0
  const peek = () => tokens[pos]
  const next = () => tokens[pos++]

  function expect(type: Token['t']) {
    const token = next()
    if (!token || token.t !== type) throw new FormulaSyntaxError(`expected ${type}`)
    return token
  }

  function expr(minBp: number): FormulaNode {
    depth += 1
    if (depth > MAX_DEPTH) throw new FormulaSyntaxError('formula nested too deeply')
    let left = prefix()
    for (;;) {
      const token = peek()
      if (!token || token.t !== 'op') break
      if (token.v === '%') {
        if (POSTFIX_BP < minBp) break
        next()
        left = { k: 'pct', a: left }
        continue
      }
      const bp = INFIX_BP[token.v]
      if (bp === undefined || bp < minBp) break
      next()
      // Every binary operator is left-associative in Excel, `^` included.
      const right = expr(bp + 1)
      left = { k: 'bin', op: token.v, a: left, b: right }
    }
    depth -= 1
    return left
  }

  function prefix(): FormulaNode {
    const token = next()
    if (!token) throw new FormulaSyntaxError('unexpected end of formula')
    switch (token.t) {
      case 'num':
        return { k: 'num', v: token.v }
      case 'str':
        return { k: 'str', v: token.v }
      case 'bool':
        return { k: 'bool', v: token.v }
      case 'err':
        return { k: 'err', code: token.v }
      case 'name':
        return { k: 'name', name: token.name }
      case 'op':
        if (token.v === '-' || token.v === '+') {
          const operand = expr(PREFIX_BP)
          return token.v === '-' ? { k: 'neg', a: operand } : operand
        }
        throw new FormulaSyntaxError(`unexpected ${token.v}`)
      case '(': {
        const inner = expr(0)
        expect(')')
        return inner
      }
      case 'func': {
        expect('(')
        const args: FormulaNode[] = []
        if (peek()?.t === ')') {
          next()
          return { k: 'call', name: token.name, args }
        }
        for (;;) {
          // An empty argument (`IF(A1,,2)`) is a blank.
          if (peek()?.t === ',' || peek()?.t === ')') args.push({ k: 'name', name: '' })
          else args.push(expr(0))
          const sep = next()
          if (!sep) throw new FormulaSyntaxError('missing )')
          if (sep.t === ')') break
          if (sep.t !== ',') throw new FormulaSyntaxError('expected , or )')
        }
        return { k: 'call', name: token.name, args }
      }
      case 'ref': {
        if (token.spill) {
          if (peek()?.t === ':') throw new FormulaSyntaxError('a spill reference is not a range corner')
          return { k: 'spill', ...(token.sheet !== undefined ? { sheet: token.sheet } : {}), row: token.row, col: token.col }
        }
        if (peek()?.t === ':') {
          next()
          const end = next()
          if (!end || end.t !== 'ref' || end.spill) throw new FormulaSyntaxError('bad range')
          if (end.sheet !== undefined && end.sheet.toLowerCase() !== (token.sheet ?? '').toLowerCase()) {
            throw new FormulaSyntaxError('a range stays on one tab')
          }
          return {
            k: 'range',
            ...(token.sheet !== undefined ? { sheet: token.sheet } : {}),
            top: Math.min(token.row, end.row),
            bottom: Math.max(token.row, end.row),
            left: Math.min(token.col, end.col),
            right: Math.max(token.col, end.col),
            wholeCols: false,
          }
        }
        return { k: 'ref', ...(token.sheet !== undefined ? { sheet: token.sheet } : {}), row: token.row, col: token.col }
      }
      case 'colref': {
        expect(':')
        const end = next()
        if (!end || end.t !== 'colref') throw new FormulaSyntaxError('bad column range')
        return {
          k: 'range',
          ...(token.sheet !== undefined ? { sheet: token.sheet } : {}),
          top: 0,
          bottom: Number.MAX_SAFE_INTEGER,
          left: Math.min(token.col, end.col),
          right: Math.max(token.col, end.col),
          wholeCols: true,
        }
      }
      default:
        throw new FormulaSyntaxError(`unexpected ${token.t}`)
    }
  }

  const root = expr(0)
  if (pos !== tokens.length) throw new FormulaSyntaxError('unexpected text after formula')
  return root
}

/** The parsed formula, or `null` when it does not parse. */
export function tryParseFormula(source: string): FormulaNode | null {
  try {
    return parseFormula(source)
  } catch {
    return null
  }
}

// ============================================================ token rewriting

type RefToken = Extract<Token, { t: 'ref' } | { t: 'colref' }>

/**
 * Rewrite a formula token by token. `edit` returns the replacement text for a
 * token's span (or `undefined` to keep it). For a ref with a sheet prefix the
 * span covers the prefix too. Untokenisable formulas come back unchanged.
 */
export function rewriteFormula(formula: string, edit: (token: Token) => string | undefined): string {
  if (!formula.startsWith('=')) return formula
  let tokens: Token[]
  try {
    tokens = tokenize(formula.slice(1))
  } catch {
    return formula
  }
  const body = formula.slice(1)
  let out = ''
  let cursor = 0
  for (const token of tokens) {
    const start = 'sheetSpan' in token && token.sheetSpan ? token.sheetSpan[0] : token.start
    const replacement = edit(token)
    if (replacement === undefined) continue
    out += body.slice(cursor, start) + replacement
    cursor = token.end
  }
  return `=${out}${body.slice(cursor)}`
}

function refText(token: RefToken, sheetPrefix: string, col: number, row?: number): string {
  let colText = ''
  let n = col + 1
  while (n > 0) {
    const rem = (n - 1) % 26
    colText = String.fromCharCode(65 + rem) + colText
    n = Math.floor((n - 1) / 26)
  }
  const c = `${token.absCol ? '$' : ''}${colText}`
  if (token.t === 'colref') return `${sheetPrefix}${c}`
  return `${sheetPrefix}${c}${token.absRow ? '$' : ''}${(row ?? 0) + 1}${token.spill ? '#' : ''}`
}

const prefixOf = (formula: string, token: RefToken) =>
  token.sheetSpan ? formula.slice(1).slice(token.sheetSpan[0], token.sheetSpan[1]) : ''

/** Move every relative reference by (dRow, dCol), as a copy-paste does. Off-sheet refs become `#REF!`. */
export function shiftFormula(formula: string, dRow: number, dCol: number): string {
  if (dRow === 0 && dCol === 0) return formula
  return rewriteFormula(formula, (token) => {
    if (token.t !== 'ref' && token.t !== 'colref') return undefined
    const col = token.absCol ? token.col : token.col + dCol
    const row = token.t === 'ref' ? (token.absRow ? token.row : token.row + dRow) : 0
    if (col < 0 || row < 0) return '#REF!'
    return refText(token, prefixOf(formula, token), col, row)
  })
}

/** Point references at a renamed tab. Matching is case-insensitive, as Excel's is. */
export function renameTabInFormula(formula: string, from: string, to: string): string {
  const quoted = quoteName(to)
  return rewriteFormula(formula, (token) => {
    if ((token.t !== 'ref' && token.t !== 'colref') || token.sheet === undefined) return undefined
    if (token.sheet.toLowerCase() !== from.toLowerCase()) return undefined
    return refText(token, `${quoted}!`, token.col, token.t === 'ref' ? token.row : undefined)
  })
}

function quoteName(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) && !CELL_REF.test(name) ? name : `'${name.replace(/'/g, "''")}'`
}

/** Upper-case function names and references, keeping strings, sheet names and spacing. */
export function normalizeFormula(formula: string): string {
  return rewriteFormula(formula, (token) => {
    if (token.t === 'func') return token.name
    if (token.t === 'bool') return token.v ? 'TRUE' : 'FALSE'
    if (token.t === 'ref' || token.t === 'colref') {
      return refText(token, prefixOf(formula, token), token.col, token.t === 'ref' ? token.row : undefined)
    }
    return undefined
  })
}

// ============================================================ evaluation

type RangeArg = { kind: 'range'; slot: number; rect: CellRect; wholeCols?: boolean }
/** A computed block of values (row-major), e.g. `A1:A5*2` or UNIQUE's result. */
export type ArrayValue = { kind: 'array'; rows: number; cols: number; data: CellValue[] }
type Arg = CellValue | RangeArg | ArrayValue
/** What an expression evaluates to: one value or a block. */
type Value = CellValue | ArrayValue

const isRange = (value: Arg): value is RangeArg =>
  typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'range'
export const isArrayValue = (value: unknown): value is ArrayValue =>
  typeof value === 'object' && value !== null && 'kind' in value && (value as ArrayValue).kind === 'array'
/** A range or an array: something with cells. */
const isArea = (value: Arg): value is RangeArg | ArrayValue => isRange(value) || isArrayValue(value)

/** Most cells one array may hold (SEQUENCE(1e6) is refused with #NUM!). */
const MAX_ARRAY_CELLS = 250_000

interface EvalHost {
  slot: number
  resolveSlot(sheet: string | undefined): number | null
  bounds(slot: number): { rows: number; cols: number }
  value(slot: number, row: number, col: number): CellValue
  today(): number
  /** Today's serial plus the local time of day as a fraction (NOW). Falls back to `today()`. */
  now?(): number
  /** `A1#`: the block spilled from the formula at (row, col). */
  spill?(slot: number, row: number, col: number): RangeArg | SheetError
  /** A defined name (named range), or null. */
  name?(name: string): RangeArg | null
  /** LET's local names, lower case. */
  scope?: Map<string, Value>
}

function rangeCells(host: EvalHost, range: RangeArg | ArrayValue): CellValue[] {
  if (isArrayValue(range)) return range.data
  const out: CellValue[] = []
  for (let r = range.rect.top; r <= range.rect.bottom; r += 1) {
    for (let c = range.rect.left; c <= range.rect.right; c += 1) out.push(host.value(range.slot, r, c))
  }
  return out
}

const areaRows = (a: RangeArg | ArrayValue) => (isArrayValue(a) ? a.rows : a.rect.bottom - a.rect.top + 1)
const areaCols = (a: RangeArg | ArrayValue) => (isArrayValue(a) ? a.cols : a.rect.right - a.rect.left + 1)

/** A range as an array of its values. Whole columns stop at their last filled row. */
function rangeToArray(host: EvalHost, range: RangeArg): ArrayValue {
  let { rect } = range
  if (range.wholeCols) {
    let bottom = rect.top
    for (let r = rect.bottom; r > rect.top; r -= 1) {
      let filled = false
      for (let c = rect.left; c <= rect.right && !filled; c += 1) filled = host.value(range.slot, r, c) !== null
      if (filled) {
        bottom = r
        break
      }
    }
    rect = { ...rect, bottom }
  }
  const sized = { ...range, rect }
  return { kind: 'array', rows: areaRows(sized), cols: areaCols(sized), data: rangeCells(host, sized) }
}

/** Any argument as an array (a scalar is 1×1). */
function toArray(arg: Arg, host: EvalHost): ArrayValue {
  if (isArrayValue(arg)) return arg
  if (isRange(arg)) return rangeToArray(host, arg)
  return { kind: 'array', rows: 1, cols: 1, data: [arg] }
}

/** A value from an array laid over a bigger shape: 1-wide/1-tall arrays repeat, past the edge is #N/A. */
function arrayAt(a: ArrayValue, r: number, c: number): CellValue {
  const row = a.rows === 1 ? 0 : r
  const col = a.cols === 1 ? 0 : c
  if (row >= a.rows || col >= a.cols) return errors['#N/A']
  return a.data[row * a.cols + col]
}

function mapValue(value: Value, fn: (v: CellValue) => CellValue): Value {
  if (!isArrayValue(value)) return fn(value)
  return { kind: 'array', rows: value.rows, cols: value.cols, data: value.data.map(fn) }
}

/** Element-wise over two values, broadcasting as Excel does. */
function zipValues(a: Value, b: Value, fn: (x: CellValue, y: CellValue) => CellValue): Value {
  if (!isArrayValue(a) && !isArrayValue(b)) return fn(a, b)
  const x = isArrayValue(a) ? a : { kind: 'array' as const, rows: 1, cols: 1, data: [a] }
  const y = isArrayValue(b) ? b : { kind: 'array' as const, rows: 1, cols: 1, data: [b] }
  const rows = Math.max(x.rows, y.rows)
  const cols = Math.max(x.cols, y.cols)
  if (rows * cols > MAX_ARRAY_CELLS) return errors['#NUM!']
  const data: CellValue[] = new Array(rows * cols)
  for (let r = 0; r < rows; r += 1) for (let c = 0; c < cols; c += 1) data[r * cols + c] = fn(arrayAt(x, r, c), arrayAt(y, r, c))
  return { kind: 'array', rows, cols, data }
}

/** An array with one cell is that cell's value. */
function simplify(value: Value): Value {
  return isArrayValue(value) && value.rows === 1 && value.cols === 1 ? value.data[0] : value
}

/**
 * Array-aware evaluation: ranges in arithmetic become arrays (`A1:A5*2`), and the
 * array functions (UNIQUE, SORT, FILTER, SEQUENCE, TRANSPOSE, ...) return blocks.
 */
function evalValue(node: FormulaNode, host: EvalHost): Value {
  switch (node.k) {
    case 'num':
    case 'str':
    case 'bool':
    case 'err':
      return evalScalar(node, host)
    case 'ref':
    case 'range':
    case 'spill':
    case 'name': {
      const arg = evalArg(node, host)
      if (isRange(arg)) {
        const { rect } = arg
        return rect.top === rect.bottom && rect.left === rect.right ? host.value(arg.slot, rect.top, rect.left) : rangeToArray(host, arg)
      }
      return arg
    }
    case 'neg':
      return mapValue(evalValue(node.a, host), (v) => {
        const n = toNumber(v)
        return isError(n) ? n : -n
      })
    case 'pct':
      return mapValue(evalValue(node.a, host), (v) => {
        const n = toNumber(v)
        return isError(n) ? n : n / 100
      })
    case 'bin':
      return zipValues(evalValue(node.a, host), evalValue(node.b, host), (x, y) => evalBinary(node.op, x, y))
    case 'call':
      return callValue(node.name, node.args, host)
  }
}

function evalArg(node: FormulaNode, host: EvalHost): Arg {
  if (node.k === 'name') {
    if (node.name === '') return null
    const local = host.scope?.get(node.name.toLowerCase())
    if (local !== undefined) return local
    return host.name?.(node.name) ?? errors['#NAME?']
  }
  if (node.k === 'spill') {
    const slot = host.resolveSlot(node.sheet)
    if (slot === null) return errors['#REF!']
    return host.spill?.(slot, node.row, node.col) ?? errors['#REF!']
  }
  if (node.k === 'ref') {
    const slot = host.resolveSlot(node.sheet)
    if (slot === null) return errors['#REF!']
    const { rows, cols } = host.bounds(slot)
    if (node.row >= rows || node.col >= cols) return errors['#REF!']
    return { kind: 'range', slot, rect: { top: node.row, bottom: node.row, left: node.col, right: node.col } }
  }
  if (node.k === 'range') {
    const slot = host.resolveSlot(node.sheet)
    if (slot === null) return errors['#REF!']
    const { rows, cols } = host.bounds(slot)
    if (node.top >= rows || node.left >= cols) return errors['#REF!']
    return {
      kind: 'range',
      slot,
      rect: {
        top: node.top,
        left: node.left,
        bottom: Math.min(node.bottom, rows - 1),
        right: Math.min(node.right, cols - 1),
      },
      ...(node.wholeCols ? { wholeCols: true } : {}),
    }
  }
  const value = evalValue(node, host)
  return value
}

/** A range or array used where one value is expected: a single cell reads as that cell, a block is #VALUE!. */
function scalarOf(arg: Arg, host: EvalHost): CellValue {
  if (isArrayValue(arg)) return arg.rows === 1 && arg.cols === 1 ? arg.data[0] : errors['#VALUE!']
  if (!isRange(arg)) return arg
  const { rect } = arg
  if (rect.top === rect.bottom && rect.left === rect.right) return host.value(arg.slot, rect.top, rect.left)
  return errors['#VALUE!']
}

function evalScalar(node: FormulaNode, host: EvalHost): CellValue {
  switch (node.k) {
    case 'num':
      return node.v
    case 'str':
      return node.v
    case 'bool':
      return node.v
    case 'err':
      return errors[node.code]
    case 'name':
    case 'ref':
    case 'range':
    case 'spill':
      return scalarOf(evalArg(node, host), host)
    case 'neg':
    case 'pct':
    case 'bin':
    case 'call':
      return scalarOf(evalValue(node, host), host)
  }
}

function evalBinary(op: string, a: CellValue, b: CellValue): CellValue {
  if (isError(a)) return a
  if (isError(b)) return b
  if (op === '&') {
    const x = toText(a)
    const y = toText(b)
    if (isError(x)) return x
    if (isError(y)) return y
    return x + y
  }
  if (op === '=' || op === '<>' || op === '<' || op === '>' || op === '<=' || op === '>=') {
    const c = compareValues(a, b)
    switch (op) {
      case '=':
        return c === 0
      case '<>':
        return c !== 0
      case '<':
        return c < 0
      case '>':
        return c > 0
      case '<=':
        return c <= 0
      default:
        return c >= 0
    }
  }
  const x = toNumber(a)
  if (isError(x)) return x
  const y = toNumber(b)
  if (isError(y)) return y
  switch (op) {
    case '+':
      return finite(x + y)
    case '-':
      return finite(x - y)
    case '*':
      return finite(x * y)
    case '/':
      return y === 0 ? errors['#DIV/0!'] : finite(x / y)
    case '^':
      if (x === 0 && y < 0) return errors['#DIV/0!']
      return finite(x ** y)
    default:
      return errors['#ERROR!']
  }
}

// ---- function helpers

/** Numbers for SUM/AVERAGE/MIN/MAX: ranges give their numbers (text, booleans, blanks skipped); direct args coerce. */
function collectNumbers(args: FormulaNode[], host: EvalHost): number[] | SheetError {
  const out: number[] = []
  for (const node of args) {
    const arg = evalArg(node, host)
    if (isArea(arg)) {
      for (const value of rangeCells(host, arg)) {
        if (isError(value)) return value
        if (typeof value === 'number') out.push(value)
      }
      continue
    }
    if (arg === null) continue
    const n = toNumber(arg)
    if (isError(n)) return n
    out.push(n)
  }
  return out
}

function flatValues(args: FormulaNode[], host: EvalHost): CellValue[] {
  const out: CellValue[] = []
  for (const node of args) {
    const arg = evalArg(node, host)
    if (isArea(arg)) out.push(...rangeCells(host, arg))
    else out.push(arg)
  }
  return out
}

function roundTo(x: number, digits: number, mode: 'half' | 'up' | 'down'): number {
  const sign = x < 0 ? -1 : 1
  const abs = Math.abs(x)
  // Trim binary noise before rounding, so 1.005 rounds to 1.01 (as in Excel) rather than 1.
  const shifted = digits >= 0 ? abs * 10 ** digits : abs / 10 ** -digits
  const fixed = Number(shifted.toPrecision(15))
  const rounded = mode === 'half' ? Math.round(fixed) : mode === 'up' ? Math.ceil(fixed) : Math.floor(fixed)
  const back = digits >= 0 ? rounded / 10 ** digits : rounded * 10 ** -digits
  return sign * Number(back.toPrecision(15))
}

type Criterion = (value: CellValue) => boolean

function wildcard(pattern: string): RegExp {
  let source = ''
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]
    if (ch === '~' && (pattern[i + 1] === '*' || pattern[i + 1] === '?')) {
      source += `\\${pattern[i + 1]}`
      i += 1
    } else if (ch === '*') source += '.*'
    else if (ch === '?') source += '.'
    else source += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${source}$`, 'i')
}

/** SUMIF/COUNTIF criteria: `5`, `">10"`, `"<>done"`, `"Do*"`, `""` (blank). */
function makeCriterion(raw: CellValue): Criterion | SheetError {
  if (isError(raw)) return raw
  if (typeof raw === 'number' || typeof raw === 'boolean') return (v) => !isError(v) && v !== null && compareValues(v, raw) === 0
  const text = raw ?? ''
  const match = /^(<=|>=|<>|<|>|=)?(.*)$/s.exec(text)
  const op = match?.[1] ?? '='
  const operand = match?.[2] ?? ''
  const asNumber = textToNumber(operand)
  const upper = operand.toUpperCase()
  const asBool = upper === 'TRUE' ? true : upper === 'FALSE' ? false : null
  if (operand === '') {
    if (op === '=') return (v) => v === null || v === ''
    if (op === '<>') return (v) => v !== null && v !== ''
  }
  const target: number | string | boolean = asNumber ?? asBool ?? operand
  const pattern = typeof target === 'string' && /[*?]/.test(target) ? wildcard(target) : null
  return (v) => {
    if (isError(v) || v === null) return op === '<>' && target !== ''
    if (pattern && (op === '=' || op === '<>')) {
      const hit = typeof v === 'string' && pattern.test(v)
      return op === '=' ? hit : !hit
    }
    // Comparisons only match values of the criterion's type (">5" never matches text).
    if (typeRank(v) !== typeRank(target)) return op === '<>'
    const c = compareValues(v, target)
    switch (op) {
      case '=':
        return c === 0
      case '<>':
        return c !== 0
      case '<':
        return c < 0
      case '>':
        return c > 0
      case '<=':
        return c <= 0
      default:
        return c >= 0
    }
  }
}

/** The `index`th cell of `range` (row-major), with `other` laid over the same shape from its top-left. */
function parallelCell(host: EvalHost, range: RangeArg, other: RangeArg, index: number): CellValue {
  const width = range.rect.right - range.rect.left + 1
  const r = Math.floor(index / width)
  const c = index % width
  const row = other.rect.top + r
  const col = other.rect.left + c
  const { rows, cols } = host.bounds(other.slot)
  if (row >= rows || col >= cols) return null
  return host.value(other.slot, row, col)
}

function lookupEquals(a: CellValue, key: CellValue): boolean {
  if (isError(a) || isError(key)) return false
  if (a === null) return key === null || key === ''
  if (key === null) return false
  if (typeRank(a) !== typeRank(key)) return false
  return compareValues(a, key) === 0
}

function argCount(args: FormulaNode[], min: number, max: number): SheetError | null {
  return args.length < min || args.length > max ? errors['#VALUE!'] : null
}

/** Trim binary noise (0.1 + 0.2) from an arithmetic result. */
const clean = (n: number): number | SheetError => finite(Number(n.toPrecision(15)))

const rectHeight = (r: RangeArg) => r.rect.bottom - r.rect.top + 1
const rectWidth = (r: RangeArg) => r.rect.right - r.rect.left + 1

/** SUMIFS / COUNTIFS / AVERAGEIFS / MINIFS / MAXIFS: every (range, criterion) pair laid over `base` by position. */
function multiCriteria(
  mode: 'sum' | 'count' | 'average' | 'min' | 'max',
  args: FormulaNode[],
  host: EvalHost,
): Value {
  const offset = mode === 'count' ? 0 : 1
  const pairs = args.length - offset
  if (pairs < 2 || pairs % 2 !== 0) return errors['#VALUE!']
  const ranges: RangeArg[] = []
  const raws: Value[] = []
  for (let i = offset; i < args.length; i += 2) {
    const arg = evalArg(args[i], host)
    if (!isRange(arg)) return isError(arg) ? arg : errors['#VALUE!']
    // A criterion may be an array (a spilled key column): the result is then an array too.
    const raw = evalValue(args[i + 1], host)
    if (isError(raw)) return raw
    ranges.push(arg)
    raws.push(raw)
  }
  let base = ranges[0]
  if (offset) {
    const arg = evalArg(args[0], host)
    if (!isRange(arg)) return isError(arg) ? arg : errors['#VALUE!']
    base = arg
  }
  if (ranges.some((r) => rectHeight(r) !== rectHeight(base) || rectWidth(r) !== rectWidth(base))) {
    return errors['#VALUE!']
  }
  const cells = rangeCells(host, base)
  const columns = ranges.map((range) => (range === base ? cells : rangeCells(host, range)))
  const one = (criterionValues: CellValue[]): CellValue => {
    const criteria: Criterion[] = []
    for (const raw of criterionValues) {
      const criterion = makeCriterion(raw)
      if (isError(criterion)) return criterion
      criteria.push(criterion)
    }
    let count = 0
    let sum = 0
    let best: number | null = null
    for (let i = 0; i < cells.length; i += 1) {
      let hit = true
      for (let j = 0; j < criteria.length && hit; j += 1) hit = criteria[j](columns[j][i])
      if (!hit) continue
      if (mode === 'count') {
        count += 1
        continue
      }
      const value = cells[i]
      if (isError(value)) return value
      if (typeof value === 'number') {
        sum += value
        count += 1
        if (best === null || (mode === 'min' ? value < best : value > best)) best = value
      }
    }
    if (mode === 'count') return count
    if (mode === 'sum') return finite(sum)
    if (mode === 'min' || mode === 'max') return best ?? 0
    return count === 0 ? errors['#DIV/0!'] : finite(sum / count)
  }
  if (!raws.some(isArrayValue)) return one(raws as CellValue[])
  const shaped = raws.map((raw) => toArray(raw, host))
  const rows = Math.max(...shaped.map((a) => a.rows))
  const cols = Math.max(...shaped.map((a) => a.cols))
  if (rows * cols > MAX_ARRAY_CELLS) return errors['#NUM!']
  const data: CellValue[] = []
  for (let r = 0; r < rows; r += 1) for (let c = 0; c < cols; c += 1) data.push(one(shaped.map((a) => arrayAt(a, r, c))))
  return { kind: 'array', rows, cols, data }
}

/** The UTC calendar date of a serial day number. */
const serialDate = (serial: number) => new Date(EPOCH + Math.floor(serial) * DAY_MS)

/** Seconds into the day of a serial's time fraction. */
const secondsOf = (serial: number) => Math.round((serial - Math.floor(serial)) * 86_400) % 86_400

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** Strip format quoting: `"text"` and `\x` become literal text. */
const formatLiteral = (s: string) => s.replace(/"([^"]*)"/g, '$1').replace(/\\(.)/g, '$1')

function formatNumberPattern(x: number, format: string): string | null {
  const match = /[#0,]*[#0](?:\.[#0]+)?|\.[#0]+/.exec(format)
  if (!match) return null
  const section = match[0]
  const percent = format.includes('%')
  const [intPart, fracPart = ''] = section.split('.')
  const decimals = fracPart.length
  const minInt = (intPart.match(/0/g) ?? []).length
  const value = Math.abs(percent ? x * 100 : x)
  let [whole, frac = ''] = roundTo(value, decimals, 'half').toFixed(decimals).split('.')
  if (whole === '0' && minInt === 0) whole = ''
  whole = whole.padStart(minInt, '0')
  if (intPart.includes(',')) whole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const body = decimals ? `${whole}.${frac}` : whole
  const negative = x < 0 && /[1-9]/.test(body)
  const prefix = formatLiteral(format.slice(0, match.index))
  const suffix = formatLiteral(format.slice(match.index + section.length))
  return `${negative ? '-' : ''}${prefix}${body}${suffix}`
}

function formatDatePattern(serial: number, format: string): string {
  const tokens = format.match(/yyyy|yy|mmmm|mmm|mm|m|dddd|ddd|dd|d|hh|h|ss|s|am\/pm|a\/p|"[^"]*"|\\.|./gi) ?? []
  const date = serialDate(serial)
  const seconds = secondsOf(serial)
  const twelve = tokens.some((t) => /^(am\/pm|a\/p)$/i.test(t))
  const hours24 = Math.floor(seconds / 3600)
  const pad = (n: number) => String(n).padStart(2, '0')
  const isCode = (t: string | undefined) => t !== undefined && /^[ymdhs]/i.test(t) && !/^(am|a\/)/i.test(t)
  let out = ''
  tokens.forEach((raw, i) => {
    const t = raw.toLowerCase()
    // `m`/`mm` means minutes right after an hour or right before a second.
    const prev = tokens.slice(0, i).reverse().find(isCode)?.toLowerCase()
    const next = tokens.slice(i + 1).find(isCode)?.toLowerCase()
    const minutes = (t === 'm' || t === 'mm') && (prev?.startsWith('h') || next?.startsWith('s'))
    const hour = twelve ? hours24 % 12 || 12 : hours24
    switch (minutes ? `min-${t}` : t) {
      case 'yyyy': out += String(date.getUTCFullYear()).padStart(4, '0'); break
      case 'yy': out += pad(date.getUTCFullYear() % 100); break
      case 'mmmm': out += MONTHS[date.getUTCMonth()]; break
      case 'mmm': out += MONTHS[date.getUTCMonth()].slice(0, 3); break
      case 'mm': out += pad(date.getUTCMonth() + 1); break
      case 'm': out += String(date.getUTCMonth() + 1); break
      case 'dddd': out += WEEKDAYS[date.getUTCDay()]; break
      case 'ddd': out += WEEKDAYS[date.getUTCDay()].slice(0, 3); break
      case 'dd': out += pad(date.getUTCDate()); break
      case 'd': out += String(date.getUTCDate()); break
      case 'hh': out += pad(hour); break
      case 'h': out += String(hour); break
      case 'min-mm': out += pad(Math.floor(seconds / 60) % 60); break
      case 'min-m': out += String(Math.floor(seconds / 60) % 60); break
      case 'ss': out += pad(seconds % 60); break
      case 's': out += String(seconds % 60); break
      case 'am/pm': out += hours24 < 12 ? (raw === 'am/pm' ? 'am' : 'AM') : raw === 'am/pm' ? 'pm' : 'PM'; break
      case 'a/p': out += hours24 < 12 ? (raw === 'a/p' ? 'a' : 'A') : raw === 'a/p' ? 'p' : 'P'; break
      default: out += formatLiteral(raw)
    }
  })
  return out
}

/** TEXT(value, format): number patterns (`0.00`, `#,##0`, `0%`, `$#,##0.00`) and date/time codes; anything else is General. */
function formatText(value: CellValue, format: string): CellValue {
  if (isError(value)) return value
  const n = typeof value === 'string' ? textToNumber(value) : toNumber(value)
  if (n === null || isError(n)) return toText(value)
  const unquoted = format.replace(/"[^"]*"|\\./g, '')
  if (/[0#]/.test(unquoted)) return formatNumberPattern(n, format) ?? toText(value)
  if (/[ymdhs]/i.test(unquoted) && !/general/i.test(unquoted)) {
    return n < 0 ? errors['#VALUE!'] : formatDatePattern(n, format)
  }
  return toText(value)
}

const ARRAY_SORT_LAST = 3

/** Sort order for SORT/SORTBY: numbers < text < booleans, then errors, then blanks. */
const sortRank = (v: CellValue) => (v === null || v === '' ? ARRAY_SORT_LAST + 1 : isError(v) ? ARRAY_SORT_LAST : 0)

function sortCompare(a: CellValue, b: CellValue): number {
  const rank = sortRank
  const ra = rank(a)
  const rb = rank(b)
  if (ra || rb) return ra - rb
  return compareValues(a as number | string | boolean, b as number | string | boolean)
}

/** UNIQUE's identity of a value: text ignores case, as Excel's does. */
const uniqueKey = (v: CellValue) =>
  v === null ? 'b' : isError(v) ? `e${v.error}` : typeof v === 'number' ? `n${v}` : typeof v === 'boolean' ? `l${v}` : `s${v.toLowerCase()}`

const arrayOf = (rows: number, cols: number, data: CellValue[]): ArrayValue => ({ kind: 'array', rows, cols, data })

function transpose(a: ArrayValue): ArrayValue {
  const data: CellValue[] = new Array(a.rows * a.cols)
  for (let r = 0; r < a.rows; r += 1) for (let c = 0; c < a.cols; c += 1) data[c * a.rows + r] = a.data[r * a.cols + c]
  return arrayOf(a.cols, a.rows, data)
}

/** Rows of an array (columns when `byCol`, as row arrays of the transpose). */
function linesOf(a: ArrayValue, byCol: boolean): CellValue[][] {
  const src = byCol ? transpose(a) : a
  const out: CellValue[][] = []
  for (let r = 0; r < src.rows; r += 1) out.push(src.data.slice(r * src.cols, (r + 1) * src.cols))
  return out
}

function fromLines(lines: CellValue[][], width: number, byCol: boolean): ArrayValue {
  const a = arrayOf(lines.length, width, lines.flat())
  return byCol ? transpose(a) : a
}

const truthy = (v: CellValue) => (isError(v) ? v : toBoolean(v))

/** Functions that may return an array, and the rest through `callFunction`. */
function callValue(name: string, args: FormulaNode[], host: EvalHost): Value {
  const number = (i: number, fallback: number): number | SheetError => {
    if (i >= args.length || (args[i].k === 'name' && (args[i] as { name: string }).name === '')) return fallback
    return toNumber(evalScalar(args[i], host))
  }
  const area = (i: number): ArrayValue | SheetError => {
    const arg = evalArg(args[i], host)
    if (isError(arg)) return arg
    return toArray(arg, host)
  }
  switch (name) {
    case 'SUMIFS':
      return simplify(multiCriteria('sum', args, host))
    case 'COUNTIFS':
      return simplify(multiCriteria('count', args, host))
    case 'AVERAGEIFS':
      return simplify(multiCriteria('average', args, host))
    case 'MINIFS':
      return simplify(multiCriteria('min', args, host))
    case 'MAXIFS':
      return simplify(multiCriteria('max', args, host))
    case 'IF': {
      const bad = argCount(args, 2, 3)
      if (bad) return bad
      const cond = evalValue(args[0], host)
      if (!isArrayValue(cond)) {
        const b = truthy(cond)
        if (isError(b)) return b
        if (b) return evalValue(args[1], host)
        return args.length > 2 ? evalValue(args[2], host) : false
      }
      // An array condition picks element by element.
      const yes = toArray(evalValue(args[1], host), host)
      const no = toArray(args.length > 2 ? evalValue(args[2], host) : false, host)
      const rows = Math.max(cond.rows, yes.rows, no.rows)
      const cols = Math.max(cond.cols, yes.cols, no.cols)
      const data: CellValue[] = []
      for (let r = 0; r < rows; r += 1) {
        for (let c = 0; c < cols; c += 1) {
          const b = truthy(arrayAt(cond, r, c))
          data.push(isError(b) ? b : b ? arrayAt(yes, r, c) : arrayAt(no, r, c))
        }
      }
      return arrayOf(rows, cols, data)
    }
    case 'IFERROR':
    case 'IFNA': {
      const bad = argCount(args, 2, 2)
      if (bad) return bad
      const caught = (v: CellValue) => isError(v) && (name === 'IFERROR' || v.error === '#N/A')
      const value = evalValue(args[0], host)
      if (!isArrayValue(value)) return caught(value) ? evalValue(args[1], host) : value
      if (!value.data.some(caught)) return value
      return zipValues(value, evalValue(args[1], host), (x, f) => (caught(x) ? f : x))
    }
    case 'LET': {
      if (args.length < 3 || args.length % 2 === 0) return errors['#VALUE!']
      const scope = new Map(host.scope ?? [])
      const inner: EvalHost = { ...host, scope }
      for (let i = 0; i < args.length - 1; i += 2) {
        const node = args[i]
        if (node.k !== 'name' || !/^[A-Za-z_][A-Za-z0-9_.]*$/.test(node.name)) return errors['#VALUE!']
        scope.set(node.name.toLowerCase(), evalValue(args[i + 1], inner))
      }
      return evalValue(args[args.length - 1], inner)
    }
    case 'SEQUENCE': {
      const bad = argCount(args, 1, 4)
      if (bad) return bad
      const rows = number(0, 1)
      const cols = number(1, 1)
      const start = number(2, 1)
      const step = number(3, 1)
      for (const n of [rows, cols, start, step]) if (isError(n)) return n
      const r = Math.trunc(rows as number)
      const c = Math.trunc(cols as number)
      if (r < 1 || c < 1) return errors['#CALC!']
      if (r * c > MAX_ARRAY_CELLS) return errors['#NUM!']
      const data: CellValue[] = new Array(r * c)
      for (let i = 0; i < r * c; i += 1) data[i] = clean((start as number) + i * (step as number))
      return simplify(arrayOf(r, c, data))
    }
    case 'SPARKLINE': {
      // The page draws a tiny chart of the range in the cell; the value itself is empty text.
      const bad = argCount(args, 1, 2)
      if (bad) return bad
      const a = area(0)
      return isError(a) ? a : ''
    }
    case 'TRANSPOSE': {
      const bad = argCount(args, 1, 1)
      if (bad) return bad
      const a = area(0)
      return isError(a) ? a : simplify(transpose(a))
    }
    case 'UNIQUE': {
      const bad = argCount(args, 1, 3)
      if (bad) return bad
      const a = area(0)
      if (isError(a)) return a
      const byCol = args.length > 1 ? truthy(evalScalar(args[1], host)) : false
      const once = args.length > 2 ? truthy(evalScalar(args[2], host)) : false
      if (isError(byCol)) return byCol
      if (isError(once)) return once
      const lines = linesOf(a, byCol)
      const counts = new Map<string, number>()
      const keys = lines.map((line) => line.map(uniqueKey).join('\u0000'))
      for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1)
      const seen = new Set<string>()
      const kept = lines.filter((_, i) => {
        const key = keys[i]
        if (once) return counts.get(key) === 1
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      if (!kept.length) return errors['#CALC!']
      return simplify(fromLines(kept, byCol ? a.rows : a.cols, byCol))
    }
    case 'SORT': {
      const bad = argCount(args, 1, 4)
      if (bad) return bad
      const a = area(0)
      if (isError(a)) return a
      const index = number(1, 1)
      const order = number(2, 1)
      if (isError(index)) return index
      if (isError(order)) return order
      const byCol = args.length > 3 ? truthy(evalScalar(args[3], host)) : false
      if (isError(byCol)) return byCol
      const lines = linesOf(a, byCol)
      const width = byCol ? a.rows : a.cols
      const k = Math.trunc(index) - 1
      if (k < 0 || k >= width || (order !== 1 && order !== -1)) return errors['#VALUE!']
      const sorted = lines
        .map((line, i) => ({ line, i }))
        .sort((x, y) => {
          // Blanks and errors stay last whichever way the sort runs.
          const c = sortCompare(x.line[k], y.line[k])
          const special = sortRank(x.line[k]) || sortRank(y.line[k])
          return (special ? c : c * order) || x.i - y.i
        })
        .map((x) => x.line)
      return simplify(fromLines(sorted, width, byCol))
    }
    case 'SORTBY': {
      if (args.length < 2) return errors['#VALUE!']
      const a = area(0)
      if (isError(a)) return a
      const keys: Array<{ values: CellValue[]; order: number }> = []
      for (let i = 1; i < args.length; i += 2) {
        const by = area(i)
        if (isError(by)) return by
        if (by.cols !== 1 || by.rows !== a.rows) return errors['#VALUE!']
        const order = number(i + 1, 1)
        if (isError(order)) return order
        if (order !== 1 && order !== -1) return errors['#VALUE!']
        keys.push({ values: by.data, order })
      }
      const lines = linesOf(a, false)
      const index = lines.map((_, i) => i)
      index.sort((x, y) => {
        for (const { values, order } of keys) {
          const c = sortCompare(values[x], values[y])
          if (c) return sortRank(values[x]) || sortRank(values[y]) ? c : c * order
        }
        return x - y
      })
      return simplify(fromLines(index.map((i) => lines[i]), a.cols, false))
    }
    case 'FILTER': {
      const bad = argCount(args, 2, 3)
      if (bad) return bad
      const a = area(0)
      if (isError(a)) return a
      const include = area(1)
      if (isError(include)) return include
      const byCol = include.rows === 1 && include.cols === a.cols && a.rows !== include.rows
      if (!byCol && !(include.cols === 1 && include.rows === a.rows)) return errors['#VALUE!']
      const lines = linesOf(a, byCol)
      const kept: CellValue[][] = []
      for (let i = 0; i < lines.length; i += 1) {
        const b = truthy(include.data[i])
        if (isError(b)) return b
        if (b) kept.push(lines[i])
      }
      if (!kept.length) return args.length > 2 ? evalValue(args[2], host) : errors['#CALC!']
      return simplify(fromLines(kept, byCol ? a.rows : a.cols, byCol))
    }
    case 'CHOOSECOLS':
    case 'CHOOSEROWS': {
      if (args.length < 2) return errors['#VALUE!']
      const a = area(0)
      if (isError(a)) return a
      const byCol = name === 'CHOOSECOLS'
      const lines = linesOf(a, byCol)
      const picked: CellValue[][] = []
      for (let i = 1; i < args.length; i += 1) {
        const n = number(i, 0)
        if (isError(n)) return n
        const k = Math.trunc(n)
        const at = k > 0 ? k - 1 : lines.length + k
        if (k === 0 || at < 0 || at >= lines.length) return errors['#VALUE!']
        picked.push(lines[at])
      }
      return simplify(fromLines(picked, byCol ? a.rows : a.cols, byCol))
    }
    case 'ROWS':
    case 'COLUMNS': {
      const bad = argCount(args, 1, 1)
      if (bad) return bad
      const arg = evalArg(args[0], host)
      if (isError(arg)) return arg
      if (!isArea(arg)) return 1
      return name === 'ROWS' ? areaRows(arg) : areaCols(arg)
    }
    case 'INDEX': {
      const bad = argCount(args, 2, 3)
      if (bad) return bad
      const first = evalArg(args[0], host)
      if (isError(first)) return first
      const row = number(1, 0)
      const col = number(2, args.length > 2 ? 0 : 1)
      if (isError(row)) return row
      if (isError(col)) return col
      // A cell of a range: the scalar INDEX (it keeps the one-row rule).
      if (isRange(first) && Math.trunc(row) !== 0 && Math.trunc(col) !== 0) return callFunction(name, args, host)
      const a = toArray(first, host)
      let r = Math.trunc(row)
      let c = Math.trunc(col)
      if (a.rows === 1 && args.length === 2) {
        c = r
        r = 1
      }
      if (r < 0 || c < 0 || r > a.rows || c > a.cols) return errors['#REF!']
      const rows = r === 0 ? [...Array(a.rows).keys()] : [r - 1]
      const cols = c === 0 ? [...Array(a.cols).keys()] : [c - 1]
      const data: CellValue[] = []
      for (const y of rows) for (const x of cols) data.push(a.data[y * a.cols + x])
      return simplify(arrayOf(rows.length, cols.length, data))
    }
    default:
      return callFunction(name, args, host)
  }
}

function callFunction(name: string, args: FormulaNode[], host: EvalHost): CellValue {
  const scalar = (i: number): CellValue => (i < args.length ? evalScalar(args[i], host) : null)
  const number = (i: number): number | SheetError => toNumber(scalar(i))
  const text = (i: number): string | SheetError => toText(scalar(i))
  const rangeArg = (i: number): RangeArg | SheetError => {
    const arg = evalArg(args[i], host)
    if (isRange(arg)) return arg
    return isError(arg) ? arg : errors['#VALUE!']
  }

  switch (name) {
    case 'SUM': {
      const nums = collectNumbers(args, host)
      return isError(nums) ? nums : finite(nums.reduce((s, n) => s + n, 0))
    }
    case 'AVERAGE': {
      const nums = collectNumbers(args, host)
      if (isError(nums)) return nums
      if (nums.length === 0) return errors['#DIV/0!']
      return finite(nums.reduce((s, n) => s + n, 0) / nums.length)
    }
    case 'MIN':
    case 'MAX': {
      const nums = collectNumbers(args, host)
      if (isError(nums)) return nums
      if (nums.length === 0) return 0
      return name === 'MIN' ? Math.min(...nums) : Math.max(...nums)
    }
    case 'COUNT': {
      let count = 0
      for (const node of args) {
        const arg = evalArg(node, host)
        if (isArea(arg)) {
          for (const value of rangeCells(host, arg)) if (typeof value === 'number') count += 1
        } else if (typeof arg === 'number' || typeof arg === 'boolean') count += 1
        else if (typeof arg === 'string' && textToNumber(arg) !== null) count += 1
      }
      return count
    }
    case 'COUNTA':
      return flatValues(args, host).filter((value) => value !== null).length
    case 'AND':
    case 'OR': {
      if (args.length === 0) return errors['#VALUE!']
      const bools: boolean[] = []
      for (const node of args) {
        const arg = evalArg(node, host)
        if (isArea(arg)) {
          for (const value of rangeCells(host, arg)) {
            if (isError(value)) return value
            if (typeof value === 'boolean') bools.push(value)
            else if (typeof value === 'number') bools.push(value !== 0)
          }
        } else {
          const b = toBoolean(arg)
          if (isError(b)) return b
          bools.push(b)
        }
      }
      if (bools.length === 0) return errors['#VALUE!']
      return name === 'AND' ? bools.every(Boolean) : bools.some(Boolean)
    }
    case 'NOT': {
      const bad = argCount(args, 1, 1)
      if (bad) return bad
      const b = toBoolean(scalar(0))
      return isError(b) ? b : !b
    }
    case 'ROUND':
    case 'ROUNDUP':
    case 'ROUNDDOWN': {
      const bad = argCount(args, 1, 2)
      if (bad) return bad
      const x = number(0)
      if (isError(x)) return x
      const d = args.length > 1 ? number(1) : 0
      if (isError(d)) return d
      const mode = name === 'ROUND' ? 'half' : name === 'ROUNDUP' ? 'up' : 'down'
      return finite(roundTo(x, Math.trunc(d), mode))
    }
    case 'ABS': {
      const bad = argCount(args, 1, 1)
      if (bad) return bad
      const x = number(0)
      return isError(x) ? x : Math.abs(x)
    }
    case 'SUMIF':
    case 'COUNTIF':
    case 'AVERAGEIF': {
      const bad = name === 'COUNTIF' ? argCount(args, 2, 2) : argCount(args, 2, 3)
      if (bad) return bad
      const range = rangeArg(0)
      if (isError(range)) return range
      const criterion = makeCriterion(scalar(1))
      if (isError(criterion)) return criterion
      let sumRange = range
      if (args.length > 2) {
        const other = rangeArg(2)
        if (isError(other)) return other
        sumRange = other
      }
      const cells = rangeCells(host, range)
      let count = 0
      let sum = 0
      for (let i = 0; i < cells.length; i += 1) {
        if (!criterion(cells[i])) continue
        count += 1
        if (name === 'COUNTIF') continue
        const value = sumRange === range ? cells[i] : parallelCell(host, range, sumRange, i)
        if (isError(value)) return value
        if (typeof value === 'number') sum += value
        else if (name === 'AVERAGEIF') count -= 1
      }
      if (name === 'COUNTIF') return count
      if (name === 'SUMIF') return finite(sum)
      return count === 0 ? errors['#DIV/0!'] : finite(sum / count)
    }
    case 'VLOOKUP': {
      const bad = argCount(args, 3, 4)
      if (bad) return bad
      const key = scalar(0)
      if (isError(key)) return key
      const table = rangeArg(1)
      if (isError(table)) return table
      const index = number(2)
      if (isError(index)) return index
      const approx = args.length > 3 ? toBoolean(scalar(3)) : true
      if (isError(approx)) return approx
      const colOffset = Math.trunc(index) - 1
      if (colOffset < 0) return errors['#VALUE!']
      if (table.rect.left + colOffset > table.rect.right) return errors['#REF!']
      let hit = -1
      for (let r = table.rect.top; r <= table.rect.bottom; r += 1) {
        const value = host.value(table.slot, r, table.rect.left)
        if (approx) {
          if (value === null || isError(value) || typeRank(value) !== typeRank(key ?? 0)) continue
          if (compareValues(value, key) <= 0) hit = r
          else break
        } else if (lookupEquals(value, key)) {
          hit = r
          break
        }
      }
      if (hit === -1) return errors['#N/A']
      return host.value(table.slot, hit, table.rect.left + colOffset)
    }
    case 'MATCH': {
      const bad = argCount(args, 2, 3)
      if (bad) return bad
      const key = scalar(0)
      if (isError(key)) return key
      const range = rangeArg(1)
      if (isError(range)) return range
      const type = args.length > 2 ? number(2) : 1
      if (isError(type)) return type
      const cells = rangeCells(host, range)
      let hit = -1
      for (let i = 0; i < cells.length; i += 1) {
        const value = cells[i]
        if (type === 0) {
          if (lookupEquals(value, key)) {
            hit = i
            break
          }
          continue
        }
        if (value === null || isError(value) || typeRank(value) !== typeRank(key ?? 0)) continue
        const c = compareValues(value, key)
        if (type > 0 ? c <= 0 : c >= 0) hit = i
        else break
      }
      return hit === -1 ? errors['#N/A'] : hit + 1
    }
    case 'INDEX': {
      const bad = argCount(args, 2, 3)
      if (bad) return bad
      const range = rangeArg(0)
      if (isError(range)) return range
      const row = number(1)
      if (isError(row)) return row
      const col = args.length > 2 ? number(2) : 1
      if (isError(col)) return col
      const height = range.rect.bottom - range.rect.top + 1
      const width = range.rect.right - range.rect.left + 1
      // One-row ranges index along the row, as Excel does with INDEX(A1:E1, 3).
      let r = Math.trunc(row)
      let c = Math.trunc(col)
      if (height === 1 && args.length === 2) {
        c = r
        r = 1
      }
      if (r < 1 || c < 1 || r > height || c > width) return errors['#REF!']
      return host.value(range.slot, range.rect.top + r - 1, range.rect.left + c - 1)
    }
    case 'CONCAT':
    case 'CONCATENATE': {
      let out = ''
      for (const value of flatValues(args, host)) {
        const t = toText(value)
        if (isError(t)) return t
        out += t
      }
      return out
    }
    case 'LEN':
    case 'UPPER':
    case 'LOWER':
    case 'TRIM': {
      const bad = argCount(args, 1, 1)
      if (bad) return bad
      const t = text(0)
      if (isError(t)) return t
      if (name === 'LEN') return t.length
      if (name === 'UPPER') return t.toUpperCase()
      if (name === 'LOWER') return t.toLowerCase()
      return t.trim().replace(/ {2,}/g, ' ')
    }
    case 'ISBLANK': {
      const bad = argCount(args, 1, 1)
      if (bad) return bad
      return scalar(0) === null
    }
    case 'ISNUMBER': {
      const bad = argCount(args, 1, 1)
      if (bad) return bad
      return typeof scalar(0) === 'number'
    }
    case 'TODAY':
      return args.length === 0 ? host.today() : errors['#VALUE!']
    case 'DATE': {
      const bad = argCount(args, 3, 3)
      if (bad) return bad
      const y = number(0)
      if (isError(y)) return y
      const m = number(1)
      if (isError(m)) return m
      const d = number(2)
      if (isError(d)) return d
      const serial = dateToSerial(Math.trunc(y), Math.trunc(m), Math.trunc(d))
      return serial < 0 ? errors['#NUM!'] : serial
    }

    // ---- lookups
    case 'XLOOKUP': {
      const bad = argCount(args, 3, 6)
      if (bad) return bad
      const key = scalar(0)
      if (isError(key)) return key
      const lookup = rangeArg(1)
      if (isError(lookup)) return lookup
      const result = rangeArg(2)
      if (isError(result)) return result
      const mode = args.length > 4 ? number(4) : 0
      if (isError(mode)) return mode
      const search = args.length > 5 ? number(5) : 1
      if (isError(search)) return search
      if (![0, -1, 1, 2].includes(mode) || ![1, -1, 2, -2].includes(search)) return errors['#VALUE!']
      const vertical = rectWidth(lookup) === 1
      if (!vertical && rectHeight(lookup) !== 1) return errors['#VALUE!']
      const cells = rangeCells(host, lookup)
      // A 2-D return range answers with the first cell of the matching row (or column).
      if ((vertical ? rectHeight(result) : rectWidth(result)) !== cells.length) return errors['#VALUE!']
      const pattern = mode === 2 && typeof key === 'string' ? wildcard(key) : null
      const order = cells.map((_, i) => i)
      if (search < 0) order.reverse()
      let hit =
        order.find((i) => {
          const value = cells[i]
          return pattern ? typeof value === 'string' && pattern.test(value) : lookupEquals(value, key)
        }) ?? -1
      if (hit === -1 && (mode === -1 || mode === 1) && key !== null) {
        // The closest neighbour below (-1) or above (1); on a tie the first in search order wins.
        let best: number | string | boolean | null = null
        for (const i of order) {
          const value = cells[i]
          if (value === null || isError(value) || typeRank(value) !== typeRank(key)) continue
          if (compareValues(value, key) * mode <= 0) continue
          if (best === null || compareValues(value, best) * mode < 0) {
            best = value
            hit = i
          }
        }
      }
      // An empty if_not_found slot (`XLOOKUP(k, a, b, , 1)`) counts as omitted.
      const fallback = args[3]
      if (hit === -1) return fallback && !(fallback.k === 'name' && fallback.name === '') ? scalar(3) : errors['#N/A']
      return vertical
        ? host.value(result.slot, result.rect.top + hit, result.rect.left)
        : host.value(result.slot, result.rect.top, result.rect.left + hit)
    }
    case 'HLOOKUP': {
      const bad = argCount(args, 3, 4)
      if (bad) return bad
      const key = scalar(0)
      if (isError(key)) return key
      const table = rangeArg(1)
      if (isError(table)) return table
      const index = number(2)
      if (isError(index)) return index
      const approx = args.length > 3 ? toBoolean(scalar(3)) : true
      if (isError(approx)) return approx
      const rowOffset = Math.trunc(index) - 1
      if (rowOffset < 0) return errors['#VALUE!']
      if (table.rect.top + rowOffset > table.rect.bottom) return errors['#REF!']
      let hit = -1
      for (let c = table.rect.left; c <= table.rect.right; c += 1) {
        const value = host.value(table.slot, table.rect.top, c)
        if (approx) {
          if (value === null || isError(value) || typeRank(value) !== typeRank(key ?? 0)) continue
          if (compareValues(value, key) <= 0) hit = c
          else break
        } else if (lookupEquals(value, key)) {
          hit = c
          break
        }
      }
      if (hit === -1) return errors['#N/A']
      return host.value(table.slot, table.rect.top + rowOffset, hit)
    }

    // ---- logic
    case 'IFS': {
      if (args.length < 2 || args.length % 2 !== 0) return errors['#VALUE!']
      for (let i = 0; i < args.length; i += 2) {
        const cond = toBoolean(scalar(i))
        if (isError(cond)) return cond
        if (cond) return scalar(i + 1)
      }
      return errors['#N/A']
    }
    case 'SWITCH': {
      if (args.length < 3) return errors['#VALUE!']
      const value = scalar(0)
      if (isError(value)) return value
      let i = 1
      for (; i + 1 < args.length; i += 2) {
        const candidate = scalar(i)
        if (isError(candidate)) return candidate
        if (lookupEquals(value, candidate) || (value === null && candidate === null)) return scalar(i + 1)
      }
      return i < args.length ? scalar(i) : errors['#N/A']
    }
    case 'CHOOSE': {
      if (args.length < 2) return errors['#VALUE!']
      const index = number(0)
      if (isError(index)) return index
      const i = Math.trunc(index)
      return i < 1 || i >= args.length ? errors['#VALUE!'] : scalar(i)
    }

    // ---- text
    case 'TEXT': {
      const bad = argCount(args, 2, 2)
      if (bad) return bad
      const format = text(1)
      return isError(format) ? format : formatText(scalar(0), format)
    }
    case 'LEFT':
    case 'RIGHT': {
      const bad = argCount(args, 1, 2)
      if (bad) return bad
      const t = text(0)
      if (isError(t)) return t
      const n = args.length > 1 ? number(1) : 1
      if (isError(n)) return n
      if (n < 0) return errors['#VALUE!']
      const count = Math.trunc(n)
      return name === 'LEFT' ? t.slice(0, count) : count === 0 ? '' : t.slice(-count)
    }
    case 'MID': {
      const bad = argCount(args, 3, 3)
      if (bad) return bad
      const t = text(0)
      if (isError(t)) return t
      const start = number(1)
      if (isError(start)) return start
      const n = number(2)
      if (isError(n)) return n
      if (start < 1 || n < 0) return errors['#VALUE!']
      return t.substr(Math.trunc(start) - 1, Math.trunc(n))
    }
    case 'SUBSTITUTE': {
      const bad = argCount(args, 3, 4)
      if (bad) return bad
      const t = text(0)
      if (isError(t)) return t
      const from = text(1)
      if (isError(from)) return from
      const to = text(2)
      if (isError(to)) return to
      if (from === '') return t
      if (args.length < 4) return t.split(from).join(to)
      const instance = number(3)
      if (isError(instance)) return instance
      if (instance < 1) return errors['#VALUE!']
      let at = -1
      for (let k = 0; k < Math.trunc(instance); k += 1) {
        at = t.indexOf(from, at + 1)
        if (at === -1) return t
      }
      return t.slice(0, at) + to + t.slice(at + from.length)
    }
    case 'FIND':
    case 'SEARCH': {
      const bad = argCount(args, 2, 3)
      if (bad) return bad
      const needle = text(0)
      if (isError(needle)) return needle
      const haystack = text(1)
      if (isError(haystack)) return haystack
      const start = args.length > 2 ? number(2) : 1
      if (isError(start)) return start
      const from = Math.trunc(start) - 1
      if (from < 0 || from > haystack.length) return errors['#VALUE!']
      let at: number
      if (name === 'FIND') at = haystack.indexOf(needle, from)
      else {
        const anchored = wildcard(needle).source
        const found = new RegExp(anchored.slice(1, -1), 'i').exec(haystack.slice(from))
        at = found ? found.index + from : -1
      }
      return at === -1 ? errors['#VALUE!'] : at + 1
    }
    case 'PROPER': {
      const bad = argCount(args, 1, 1)
      if (bad) return bad
      const t = text(0)
      if (isError(t)) return t
      return t.toLowerCase().replace(/(^|[^\p{L}])(\p{L})/gu, (_, before: string, letter: string) => before + letter.toUpperCase())
    }
    case 'REPT': {
      const bad = argCount(args, 2, 2)
      if (bad) return bad
      const t = text(0)
      if (isError(t)) return t
      const n = number(1)
      if (isError(n)) return n
      const times = Math.trunc(n)
      if (times < 0 || t.length * times > 32_767) return errors['#VALUE!']
      return t.repeat(times)
    }
    case 'TEXTJOIN': {
      if (args.length < 3) return errors['#VALUE!']
      const delimiter = text(0)
      if (isError(delimiter)) return delimiter
      const ignoreEmpty = toBoolean(scalar(1))
      if (isError(ignoreEmpty)) return ignoreEmpty
      const parts: string[] = []
      for (const value of flatValues(args.slice(2), host)) {
        const t = toText(value)
        if (isError(t)) return t
        if (ignoreEmpty && t === '') continue
        parts.push(t)
      }
      const joined = parts.join(delimiter)
      return joined.length > 32_767 ? errors['#VALUE!'] : joined
    }
    case 'VALUE': {
      const bad = argCount(args, 1, 1)
      if (bad) return bad
      const value = scalar(0)
      if (isError(value)) return value
      if (typeof value !== 'string') return toNumber(value)
      return textToNumber(value.replace(/^(\s*[+-]?)\$/, '$1').replace(/,(?=\d{3})/g, '')) ?? errors['#VALUE!']
    }
    case 'EXACT': {
      const bad = argCount(args, 2, 2)
      if (bad) return bad
      const a = text(0)
      if (isError(a)) return a
      const b = text(1)
      return isError(b) ? b : a === b
    }

    // ---- dates and times
    case 'YEAR':
    case 'MONTH':
    case 'DAY': {
      const bad = argCount(args, 1, 1)
      if (bad) return bad
      const serial = number(0)
      if (isError(serial)) return serial
      if (serial < 0) return errors['#NUM!']
      const date = serialDate(serial)
      return name === 'YEAR' ? date.getUTCFullYear() : name === 'MONTH' ? date.getUTCMonth() + 1 : date.getUTCDate()
    }
    case 'WEEKDAY': {
      const bad = argCount(args, 1, 2)
      if (bad) return bad
      const serial = number(0)
      if (isError(serial)) return serial
      const type = args.length > 1 ? number(1) : 1
      if (isError(type)) return type
      if (serial < 0) return errors['#NUM!']
      const day = serialDate(serial).getUTCDay() // 0 = Sunday
      if (type === 1) return day + 1
      if (type === 2) return ((day + 6) % 7) + 1
      if (type === 3) return (day + 6) % 7
      return errors['#NUM!']
    }
    case 'EDATE':
    case 'EOMONTH': {
      const bad = argCount(args, 2, 2)
      if (bad) return bad
      const start = number(0)
      if (isError(start)) return start
      const months = number(1)
      if (isError(months)) return months
      if (start < 0) return errors['#NUM!']
      const date = serialDate(start)
      const y = date.getUTCFullYear()
      const m = date.getUTCMonth() + 1 + Math.trunc(months)
      const monthEnd = dateToSerial(y, m + 1, 0)
      const serial =
        name === 'EOMONTH' ? monthEnd : Math.min(dateToSerial(y, m, date.getUTCDate()), monthEnd)
      return serial < 0 ? errors['#NUM!'] : serial
    }
    case 'DAYS': {
      const bad = argCount(args, 2, 2)
      if (bad) return bad
      const end = number(0)
      if (isError(end)) return end
      const start = number(1)
      return isError(start) ? start : Math.floor(end) - Math.floor(start)
    }
    case 'NETWORKDAYS': {
      const bad = argCount(args, 2, 3)
      if (bad) return bad
      const a = number(0)
      if (isError(a)) return a
      const b = number(1)
      if (isError(b)) return b
      const holidays = new Set<number>()
      if (args.length > 2) {
        for (const value of flatValues(args.slice(2), host)) {
          if (isError(value)) return value
          if (value === null) continue
          const n = toNumber(value)
          if (isError(n)) return n
          holidays.add(Math.floor(n))
        }
      }
      const lo = Math.floor(Math.min(a, b))
      const hi = Math.floor(Math.max(a, b))
      if (hi - lo > 400_000) return errors['#NUM!']
      let count = 0
      for (let d = lo; d <= hi; d += 1) {
        const weekday = serialDate(d).getUTCDay()
        if (weekday !== 0 && weekday !== 6 && !holidays.has(d)) count += 1
      }
      return b < a ? -count : count
    }
    case 'NOW':
      return args.length === 0 ? (host.now?.() ?? host.today()) : errors['#VALUE!']
    case 'TIME': {
      const bad = argCount(args, 3, 3)
      if (bad) return bad
      const h = number(0)
      if (isError(h)) return h
      const m = number(1)
      if (isError(m)) return m
      const s = number(2)
      if (isError(s)) return s
      const total = Math.trunc(h) * 3600 + Math.trunc(m) * 60 + Math.trunc(s)
      return total < 0 ? errors['#NUM!'] : (total % 86_400) / 86_400
    }
    case 'HOUR':
    case 'MINUTE':
    case 'SECOND': {
      const bad = argCount(args, 1, 1)
      if (bad) return bad
      const serial = number(0)
      if (isError(serial)) return serial
      if (serial < 0) return errors['#NUM!']
      const seconds = secondsOf(serial)
      if (name === 'HOUR') return Math.floor(seconds / 3600)
      return name === 'MINUTE' ? Math.floor(seconds / 60) % 60 : seconds % 60
    }

    // ---- math and statistics
    case 'MEDIAN': {
      const nums = collectNumbers(args, host)
      if (isError(nums)) return nums
      if (nums.length === 0) return errors['#NUM!']
      nums.sort((x, y) => x - y)
      const mid = nums.length >> 1
      return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2
    }
    case 'PRODUCT': {
      const nums = collectNumbers(args, host)
      if (isError(nums)) return nums
      return nums.length === 0 ? 0 : finite(nums.reduce((p, n) => p * n, 1))
    }
    case 'MOD': {
      const bad = argCount(args, 2, 2)
      if (bad) return bad
      const n = number(0)
      if (isError(n)) return n
      const d = number(1)
      if (isError(d)) return d
      // The result takes the divisor's sign: MOD(-3, 2) is 1.
      return d === 0 ? errors['#DIV/0!'] : clean(n - d * Math.floor(n / d))
    }
    case 'INT':
    case 'SQRT':
    case 'SIGN': {
      const bad = argCount(args, 1, 1)
      if (bad) return bad
      const x = number(0)
      if (isError(x)) return x
      if (name === 'INT') return Math.floor(x)
      if (name === 'SIGN') return Math.sign(x)
      return x < 0 ? errors['#NUM!'] : Math.sqrt(x)
    }
    case 'POWER': {
      const bad = argCount(args, 2, 2)
      return bad ?? evalBinary('^', scalar(0), scalar(1))
    }
    case 'CEILING':
    case 'FLOOR': {
      const bad = argCount(args, 1, 2)
      if (bad) return bad
      const x = number(0)
      if (isError(x)) return x
      const step = args.length > 1 ? number(1) : 1
      if (isError(step)) return step
      if (step === 0) return name === 'CEILING' ? 0 : x === 0 ? 0 : errors['#DIV/0!']
      if (x > 0 && step < 0) return errors['#NUM!']
      const steps = Number((x / step).toPrecision(15))
      return clean((name === 'CEILING' ? Math.ceil(steps) : Math.floor(steps)) * step)
    }
    case 'PI':
      return args.length === 0 ? Math.PI : errors['#VALUE!']
    case 'COUNTBLANK': {
      const bad = argCount(args, 1, 1)
      if (bad) return bad
      const range = rangeArg(0)
      if (isError(range)) return range
      return rangeCells(host, range).filter((value) => value === null || value === '').length
    }
    case 'SUMPRODUCT': {
      if (args.length === 0) return errors['#VALUE!']
      const arrays: CellValue[][] = []
      let shape: [number, number] | null = null
      for (const node of args) {
        const arg = evalArg(node, host)
        const dims: [number, number] = isArea(arg) ? [areaRows(arg), areaCols(arg)] : [1, 1]
        if (shape && (shape[0] !== dims[0] || shape[1] !== dims[1])) return errors['#VALUE!']
        shape = dims
        arrays.push(isArea(arg) ? rangeCells(host, arg) : [arg])
      }
      let total = 0
      for (let i = 0; i < arrays[0].length; i += 1) {
        let product = 1
        for (const array of arrays) {
          const value = array[i]
          if (isError(value)) return value
          product *= typeof value === 'number' ? value : 0
        }
        total += product
      }
      return finite(total)
    }

    // ---- information
    case 'ISERROR':
    case 'ISERR':
    case 'ISNA':
    case 'ISTEXT':
    case 'ISLOGICAL': {
      const bad = argCount(args, 1, 1)
      if (bad) return bad
      const value = scalar(0)
      if (name === 'ISERROR') return isError(value)
      if (name === 'ISERR') return isError(value) && value.error !== '#N/A'
      if (name === 'ISNA') return isError(value) && value.error === '#N/A'
      return name === 'ISTEXT' ? typeof value === 'string' : typeof value === 'boolean'
    }
    default:
      return errors['#NAME?']
  }
}

export const SUPPORTED_FUNCTIONS = [
  'SUM', 'AVERAGE', 'MIN', 'MAX', 'COUNT', 'COUNTA', 'IF', 'IFERROR', 'AND', 'OR', 'NOT', 'ROUND',
  'ROUNDUP', 'ROUNDDOWN', 'ABS', 'SUMIF', 'COUNTIF', 'AVERAGEIF', 'VLOOKUP', 'MATCH', 'INDEX',
  'CONCAT', 'CONCATENATE', 'LEN', 'UPPER', 'LOWER', 'TRIM', 'ISBLANK', 'ISNUMBER', 'TODAY', 'DATE',
  'SUMIFS', 'COUNTIFS', 'AVERAGEIFS', 'XLOOKUP', 'HLOOKUP', 'IFS', 'SWITCH', 'CHOOSE', 'TEXT', 'LEFT',
  'RIGHT', 'MID', 'SUBSTITUTE', 'FIND', 'SEARCH', 'PROPER', 'REPT', 'TEXTJOIN', 'VALUE', 'EXACT',
  'YEAR', 'MONTH', 'DAY', 'WEEKDAY', 'EDATE', 'EOMONTH', 'DAYS', 'NETWORKDAYS', 'NOW', 'TIME', 'HOUR',
  'MINUTE', 'SECOND', 'MEDIAN', 'PRODUCT', 'MOD', 'INT', 'POWER', 'SQRT', 'CEILING', 'FLOOR', 'SIGN',
  'PI', 'COUNTBLANK', 'SUMPRODUCT', 'ISERROR', 'ISERR', 'ISNA', 'ISTEXT', 'ISLOGICAL', 'IFNA',
  // Arrays: these return a block that spills into the cells below and to the right.
  'UNIQUE', 'SORT', 'SORTBY', 'FILTER', 'SEQUENCE', 'TRANSPOSE', 'CHOOSECOLS', 'CHOOSEROWS', 'ROWS', 'COLUMNS',
  'MINIFS', 'MAXIFS', 'LET',
  // Round 5: drawn by the page as an in-cell chart.
  'SPARKLINE',
] as const

const sig = (signature: string, description: string) => ({ signature, description })

/** Signature and a one-line description of every supported function, for the autocomplete popup. */
export const FUNCTION_SIGNATURES: Record<string, { signature: string; description: string }> = {
  SUM: sig('SUM(value1, [value2, …])', 'Adds numbers and ranges.'),
  AVERAGE: sig('AVERAGE(value1, [value2, …])', 'The mean of numbers and ranges.'),
  MIN: sig('MIN(value1, [value2, …])', 'The smallest number.'),
  MAX: sig('MAX(value1, [value2, …])', 'The largest number.'),
  COUNT: sig('COUNT(value1, [value2, …])', 'Counts the numbers.'),
  COUNTA: sig('COUNTA(value1, [value2, …])', 'Counts the cells that are not blank.'),
  IF: sig('IF(condition, if_true, [if_false])', 'One value when the condition is true, another when not.'),
  IFERROR: sig('IFERROR(value, if_error)', 'The value, or a fallback when it is an error.'),
  AND: sig('AND(logical1, [logical2, …])', 'TRUE when every condition is true.'),
  OR: sig('OR(logical1, [logical2, …])', 'TRUE when any condition is true.'),
  NOT: sig('NOT(logical)', 'Flips TRUE and FALSE.'),
  ROUND: sig('ROUND(number, [digits])', 'Rounds to a number of digits.'),
  ROUNDUP: sig('ROUNDUP(number, [digits])', 'Rounds away from zero.'),
  ROUNDDOWN: sig('ROUNDDOWN(number, [digits])', 'Rounds toward zero.'),
  ABS: sig('ABS(number)', 'The number without its sign.'),
  SUMIF: sig('SUMIF(range, criterion, [sum_range])', 'Adds the cells that meet a condition.'),
  COUNTIF: sig('COUNTIF(range, criterion)', 'Counts the cells that meet a condition.'),
  AVERAGEIF: sig('AVERAGEIF(range, criterion, [average_range])', 'The mean of the cells that meet a condition.'),
  VLOOKUP: sig('VLOOKUP(key, range, column, [approximate])', 'Finds a key in the first column and returns a cell from its row.'),
  MATCH: sig('MATCH(key, range, [match_type])', 'The position of a value in a range.'),
  INDEX: sig('INDEX(range, row, [column])', 'The cell at a row and column of a range.'),
  CONCAT: sig('CONCAT(text1, [text2, …])', 'Joins text together.'),
  CONCATENATE: sig('CONCATENATE(text1, [text2, …])', 'Joins text together.'),
  LEN: sig('LEN(text)', 'The number of characters.'),
  UPPER: sig('UPPER(text)', 'Converts text to upper case.'),
  LOWER: sig('LOWER(text)', 'Converts text to lower case.'),
  TRIM: sig('TRIM(text)', 'Removes extra spaces.'),
  ISBLANK: sig('ISBLANK(value)', 'TRUE when the cell is empty.'),
  ISNUMBER: sig('ISNUMBER(value)', 'TRUE when the value is a number.'),
  TODAY: sig('TODAY()', "Today's date."),
  DATE: sig('DATE(year, month, day)', 'A date from its parts.'),
  SUMIFS: sig('SUMIFS(sum_range, criteria_range1, criterion1, …)', 'Adds the cells that meet every condition.'),
  COUNTIFS: sig('COUNTIFS(criteria_range1, criterion1, …)', 'Counts the rows that meet every condition.'),
  AVERAGEIFS: sig('AVERAGEIFS(average_range, criteria_range1, criterion1, …)', 'The mean of the cells that meet every condition.'),
  XLOOKUP: sig(
    'XLOOKUP(key, lookup_range, return_range, [if_not_found], [match_mode], [search_mode])',
    'Finds a key in a row or column and returns the matching cell of another.',
  ),
  HLOOKUP: sig('HLOOKUP(key, range, row, [approximate])', 'Finds a key in the first row and returns a cell from its column.'),
  IFS: sig('IFS(condition1, value1, [condition2, value2, …])', 'The value of the first true condition.'),
  SWITCH: sig('SWITCH(expression, case1, value1, …, [default])', 'The value of the first case that matches.'),
  CHOOSE: sig('CHOOSE(index, value1, [value2, …])', 'Picks a value by its position.'),
  TEXT: sig('TEXT(value, format)', 'Formats a number or date as text, e.g. "0.00" or "yyyy-mm-dd".'),
  LEFT: sig('LEFT(text, [count])', 'The first characters of text.'),
  RIGHT: sig('RIGHT(text, [count])', 'The last characters of text.'),
  MID: sig('MID(text, start, count)', 'Characters from the middle of text.'),
  SUBSTITUTE: sig('SUBSTITUTE(text, old, new, [instance])', 'Replaces text with other text.'),
  FIND: sig('FIND(needle, text, [start])', 'The position of text inside text (case-sensitive).'),
  SEARCH: sig('SEARCH(needle, text, [start])', 'The position of text inside text (ignores case; * and ? wildcards).'),
  PROPER: sig('PROPER(text)', 'Capitalises the first letter of each word.'),
  REPT: sig('REPT(text, times)', 'Repeats text.'),
  TEXTJOIN: sig('TEXTJOIN(delimiter, ignore_empty, text1, [text2, …])', 'Joins text and ranges with a delimiter.'),
  VALUE: sig('VALUE(text)', 'Converts text to a number.'),
  EXACT: sig('EXACT(text1, text2)', 'TRUE when two texts match exactly, case included.'),
  YEAR: sig('YEAR(date)', 'The year of a date.'),
  MONTH: sig('MONTH(date)', 'The month of a date, 1 to 12.'),
  DAY: sig('DAY(date)', 'The day of the month of a date.'),
  WEEKDAY: sig('WEEKDAY(date, [type])', 'The day of the week as a number.'),
  EDATE: sig('EDATE(start, months)', 'The same day a number of months away.'),
  EOMONTH: sig('EOMONTH(start, months)', 'The last day of the month a number of months away.'),
  DAYS: sig('DAYS(end, start)', 'The number of days between two dates.'),
  NETWORKDAYS: sig('NETWORKDAYS(start, end, [holidays])', 'The number of weekdays between two dates.'),
  NOW: sig('NOW()', 'The current date and time.'),
  TIME: sig('TIME(hour, minute, second)', 'A time of day from its parts.'),
  HOUR: sig('HOUR(time)', 'The hour of a time, 0 to 23.'),
  MINUTE: sig('MINUTE(time)', 'The minute of a time.'),
  SECOND: sig('SECOND(time)', 'The second of a time.'),
  MEDIAN: sig('MEDIAN(value1, [value2, …])', 'The middle number.'),
  PRODUCT: sig('PRODUCT(value1, [value2, …])', 'Multiplies numbers and ranges.'),
  MOD: sig('MOD(number, divisor)', 'The remainder after division.'),
  INT: sig('INT(number)', 'Rounds down to a whole number.'),
  POWER: sig('POWER(number, power)', 'A number raised to a power.'),
  SQRT: sig('SQRT(number)', 'The square root.'),
  CEILING: sig('CEILING(number, [significance])', 'Rounds up to a multiple.'),
  FLOOR: sig('FLOOR(number, [significance])', 'Rounds down to a multiple.'),
  SIGN: sig('SIGN(number)', '1, 0 or -1 by the sign of a number.'),
  PI: sig('PI()', 'The number π.'),
  COUNTBLANK: sig('COUNTBLANK(range)', 'Counts the empty cells.'),
  SUMPRODUCT: sig('SUMPRODUCT(range1, [range2, …])', 'Multiplies ranges cell by cell and adds the results.'),
  ISERROR: sig('ISERROR(value)', 'TRUE when the value is any error.'),
  ISERR: sig('ISERR(value)', 'TRUE when the value is an error other than #N/A.'),
  ISNA: sig('ISNA(value)', 'TRUE when the value is #N/A.'),
  ISTEXT: sig('ISTEXT(value)', 'TRUE when the value is text.'),
  ISLOGICAL: sig('ISLOGICAL(value)', 'TRUE when the value is TRUE or FALSE.'),
  IFNA: sig('IFNA(value, if_na)', 'The value, or a fallback when it is #N/A.'),
  UNIQUE: sig('UNIQUE(range, [by_column], [exactly_once])', 'The distinct rows of a range; spills.'),
  SORT: sig('SORT(range, [sort_index], [sort_order], [by_column])', 'A range sorted by one of its columns (1 up, -1 down); spills.'),
  SORTBY: sig('SORTBY(range, by_range1, [order1], …)', 'A range sorted by other columns; spills.'),
  FILTER: sig('FILTER(range, include, [if_empty])', 'The rows of a range where include is TRUE; spills.'),
  SEQUENCE: sig('SEQUENCE(rows, [columns], [start], [step])', 'A block of counting numbers; spills.'),
  TRANSPOSE: sig('TRANSPOSE(range)', 'Swaps rows and columns; spills.'),
  CHOOSECOLS: sig('CHOOSECOLS(range, column1, [column2, …])', 'Some columns of a range (negative counts from the end); spills.'),
  CHOOSEROWS: sig('CHOOSEROWS(range, row1, [row2, …])', 'Some rows of a range (negative counts from the end); spills.'),
  ROWS: sig('ROWS(range)', 'The number of rows of a range or spill.'),
  COLUMNS: sig('COLUMNS(range)', 'The number of columns of a range or spill.'),
  MINIFS: sig('MINIFS(min_range, criteria_range1, criterion1, …)', 'The smallest cell that meets every condition.'),
  MAXIFS: sig('MAXIFS(max_range, criteria_range1, criterion1, …)', 'The largest cell that meets every condition.'),
  LET: sig('LET(name1, value1, [name2, value2, …], calculation)', 'Names values for use in a calculation.'),
  SPARKLINE: sig('SPARKLINE(range, [type])', 'A tiny in-cell chart of the range: "line" (default), "bar" or "column".'),
}

// ============================================================ the engine

const COL_STRIDE = 256 // > SHEET_LIMITS.cols
const ROW_STRIDE = 50_001 // > SHEET_LIMITS.rows
/** Recompute everything instead of incrementally past this many changed or affected cells. */
const INCREMENTAL_LIMIT = 5_000

const cellIndex = (row: number, col: number) => row * COL_STRIDE + col
const keyOf = (slot: number, row: number, col: number) => (slot * ROW_STRIDE + row) * COL_STRIDE + col
const decodeKey = (key: number) => {
  const col = key % COL_STRIDE
  const rest = (key - col) / COL_STRIDE
  const row = rest % ROW_STRIDE
  return { slot: (rest - row) / ROW_STRIDE, row, col }
}

type FormulaEntry = {
  key: number
  ast: FormulaNode | null
  refs: number[]
  ranges: Array<{ slot: number; rect: CellRect }>
}

/**
 * A formula's spilled block. `rect` is where it wants to spill, kept while it is
 * blocked too, so that clearing the blocker re-runs it. `values` is row-major.
 */
type Spill = { key: number; slot: number; rect: CellRect; width: number; values: CellValue[]; active: boolean }

type TabState = {
  id: string
  name: string
  slot: number
  rows: number
  cols: number
  literals: Map<number, CellValue>
  results: Map<number, CellValue>
  formulas: Map<number, FormulaEntry>
  /** Cells covered by an active spill (never its anchor) → that spill. */
  spillOwner: Map<number, Spill>
}

type EngineState = {
  workbook: Workbook
  tabs: TabState[]
  byId: Map<string, TabState>
  byName: Map<string, TabState>
  /** Formula keys that reference each cell key directly. */
  refIndex: Map<number, Set<number>>
  /** Formula keys that hold at least one range. */
  rangeOwners: Set<number>
  formulaAt: Map<number, FormulaEntry>
  /** Every formula that returned a block, by its key (blocked ones included). */
  spills: Map<number, Spill>
  /** Defined names, lower case → the range they stand for. */
  names: Map<string, { slot: number; rect: CellRect }>
  /** Spill footprints that changed during this run; their readers re-run (`settleSpills`). */
  dirty: Array<{ key: number; slot: number; rect: CellRect; seq: number }>
  /** When each formula was last evaluated in this run (`seq`), so settle skips readers already up to date. */
  stamps: Map<number, number>
  seq: number
  /** Formulas found in a cycle during this run: they stay #CYCLE! until it ends, so a spill cannot flap. */
  cyclic: Set<number>
  now: () => Date
}

export type EngineOptions = { now?: () => Date }

/** What a cell's spill looks like to the grid: the anchor, the block it wants, and whether it is blocked. */
export type SpillInfo = { row: number; col: number; rect: CellRect; blocked: boolean }

/** The wall clock at `now`: in `timeZone` when the workbook names one, else the reader's own. */
export function clockParts(now: Date, timeZone?: string): { y: number; m: number; d: number; h: number; mi: number; s: number } {
  if (timeZone) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
        hourCycle: 'h23',
      }).formatToParts(now)
      const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0)
      return { y: get('year'), m: get('month'), d: get('day'), h: get('hour') % 24, mi: get('minute'), s: get('second') }
    } catch {
      // An unknown zone reads the local clock.
    }
  }
  return { y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate(), h: now.getHours(), mi: now.getMinutes(), s: now.getSeconds() }
}

function todaySerial(now: Date, timeZone?: string): number {
  const c = clockParts(now, timeZone)
  return dateToSerial(c.y, c.m, c.d)
}

/** NOW() as a serial: today plus the time of day, both on the workbook's clock. */
function nowSerial(now: Date, timeZone?: string): number {
  const c = clockParts(now, timeZone)
  return dateToSerial(c.y, c.m, c.d) + (c.h * 3600 + c.mi * 60 + c.s) / 86_400
}

function collectPrecedents(
  ast: FormulaNode,
  resolve: (sheet: string | undefined) => TabState | null,
  names: EngineState['names'],
): Pick<FormulaEntry, 'refs' | 'ranges'> {
  const refs: number[] = []
  const ranges: FormulaEntry['ranges'] = []
  const stack: FormulaNode[] = [ast]
  while (stack.length) {
    const node = stack.pop()!
    switch (node.k) {
      case 'ref':
      case 'spill': {
        // `A1#` depends on the anchor's formula: the anchor runs first and its readers follow it.
        const tab = resolve(node.sheet)
        if (tab && node.row < tab.rows && node.col < tab.cols) refs.push(keyOf(tab.slot, node.row, node.col))
        break
      }
      case 'range': {
        const tab = resolve(node.sheet)
        if (tab && node.top < tab.rows && node.left < tab.cols) {
          ranges.push({
            slot: tab.slot,
            rect: {
              top: node.top,
              left: node.left,
              bottom: Math.min(node.bottom, tab.rows - 1),
              right: Math.min(node.right, tab.cols - 1),
            },
          })
        }
        break
      }
      case 'name': {
        const named = names.get(node.name.toLowerCase())
        if (named) ranges.push({ slot: named.slot, rect: named.rect })
        break
      }
      case 'call':
        stack.push(...node.args)
        break
      case 'neg':
      case 'pct':
        stack.push(node.a)
        break
      case 'bin':
        stack.push(node.a, node.b)
        break
      default:
        break
    }
  }
  return { refs, ranges }
}

const astCache = new Map<string, FormulaNode | null>()
function cachedParse(source: string): FormulaNode | null {
  let ast = astCache.get(source)
  if (ast === undefined) {
    ast = tryParseFormula(source)
    if (astCache.size > 20_000) astCache.clear()
    astCache.set(source, ast)
  }
  return ast
}

function namesOf(workbook: Workbook, byId: Map<string, TabState>): EngineState['names'] {
  const names: EngineState['names'] = new Map()
  for (const def of workbook.names ?? []) {
    const tab = byId.get(def.tab)
    const rect = parseSheetRange(def.range)?.rect
    if (!tab || !rect || rect.top >= tab.rows || rect.left >= tab.cols) continue
    names.set(def.name.toLowerCase(), {
      slot: tab.slot,
      rect: { ...rect, bottom: Math.min(rect.bottom, tab.rows - 1), right: Math.min(rect.right, tab.cols - 1) },
    })
  }
  return names
}

const sameNames = (a: Workbook['names'], b: Workbook['names']) =>
  a === b || JSON.stringify(a ?? []) === JSON.stringify(b ?? [])

/**
 * Computes a workbook's formulas and answers `value(tabId, row, col)`.
 *
 * `update(next)` returns a new engine for the next workbook, recomputing only
 * cells downstream of what changed (or everything after a tab is added,
 * removed, renamed or resized, or a name changes). The engine it was called on
 * must not be used afterwards: the two share their tables.
 */
export class SheetEngine {
  /** Addresses (`tabId!A1`) of the formulas computed by the last build or update, in order. */
  readonly order: string[]

  private constructor(
    private readonly state: EngineState,
    order: string[],
  ) {
    this.order = order
  }

  static build(workbook: Workbook, options: EngineOptions = {}): SheetEngine {
    const now = options.now ?? (() => new Date())
    const tabs: TabState[] = workbook.tabs.map((tab, slot) => ({
      id: tab.id,
      name: tab.name,
      slot,
      rows: tabRows(tab),
      cols: tabCols(tab),
      literals: new Map(),
      results: new Map(),
      formulas: new Map(),
      spillOwner: new Map(),
    }))
    const byId = new Map(tabs.map((t) => [t.id, t]))
    const state: EngineState = {
      workbook,
      tabs,
      byId,
      byName: new Map(tabs.map((t) => [t.name.toLowerCase(), t])),
      refIndex: new Map(),
      rangeOwners: new Set(),
      formulaAt: new Map(),
      spills: new Map(),
      names: namesOf(workbook, byId),
      dirty: [],
      cyclic: new Set(),
      stamps: new Map(),
      seq: 0,
      now,
    }
    workbook.tabs.forEach((tab, slot) => {
      for (const [address, cell] of Object.entries(tab.cells)) {
        const pos = parseAddress(address)
        if (pos) setCell(state, slot, pos.row, pos.col, cell)
      }
    })

    // Edges between formula cells. A range finds the formulas inside it through a per-column index.
    const columns = new Map<number, number[]>() // (slot * COL_STRIDE + col) → sorted rows
    for (const key of state.formulaAt.keys()) {
      const { slot, row, col } = decodeKey(key)
      const id = slot * COL_STRIDE + col
      let rows = columns.get(id)
      if (!rows) columns.set(id, (rows = []))
      rows.push(row)
    }
    for (const rows of columns.values()) rows.sort((a, b) => a - b)

    const successors = new Map<number, number[]>()
    const indegree = new Map<number, number>()
    const addEdge = (from: number, to: number) => {
      let list = successors.get(from)
      if (!list) successors.set(from, (list = []))
      list.push(to)
      indegree.set(to, (indegree.get(to) ?? 0) + 1)
    }
    for (const entry of state.formulaAt.values()) {
      indegree.set(entry.key, indegree.get(entry.key) ?? 0)
      const seen = new Set<number>()
      for (const ref of entry.refs) {
        if (state.formulaAt.has(ref) && !seen.has(ref)) {
          seen.add(ref)
          addEdge(ref, entry.key)
        }
      }
      for (const { slot, rect } of entry.ranges) {
        for (let col = rect.left; col <= rect.right; col += 1) {
          const rows = columns.get(slot * COL_STRIDE + col)
          if (!rows) continue
          for (let i = lowerBound(rows, rect.top); i < rows.length && rows[i] <= rect.bottom; i += 1) {
            const key = keyOf(slot, rows[i], col)
            if (!seen.has(key)) {
              seen.add(key)
              addEdge(key, entry.key)
            }
          }
        }
      }
    }
    const order = evaluateInOrder(state, [...state.formulaAt.keys()], successors, indegree)
    // Spill sizes are known only now: re-run whatever reads a spilled cell.
    settleSpills(state, order)
    return new SheetEngine(state, order)
  }

  get workbook(): Workbook {
    return this.state.workbook
  }

  /**
   * Evaluate a formula as if it sat on `tabId` (its first value; nothing is stored).
   * `override` pretends one cell of that tab holds `value` (a validation rule checking an entry).
   */
  evaluate(tabId: string, formula: string, override?: { row: number; col: number; value: CellValue }): CellValue {
    const tab = this.state.byId.get(tabId)
    const ast = cachedParse(formula)
    if (!tab || !ast) return errors['#ERROR!']
    const nowDate = this.state.now()
    const today = todaySerial(nowDate, this.state.workbook.timeZone)
    const host = hostFor(this.state, tab.slot, today, nowSerial(nowDate, this.state.workbook.timeZone), override ? { slot: tab.slot, ...override } : undefined)
    const value = evalValue(ast, host)
    return isArrayValue(value) ? (value.data[0] ?? null) : value
  }

  /** Today's day serial, by the engine's clock (TODAY()). */
  today(): number {
    return todaySerial(this.state.now(), this.state.workbook.timeZone)
  }

  /** The value a cell shows: a formula's result, a spilled value, or the literal. Unknown tabs and off-sheet cells are blank. */
  value(tabId: string, row: number, col: number): CellValue {
    const tab = this.state.byId.get(tabId)
    if (!tab) return null
    return readCell(tab, row, col)
  }

  /** The spill a cell belongs to: its anchor formula (blocked ones too) or a covered cell. */
  spillAt(tabId: string, row: number, col: number): SpillInfo | null {
    const tab = this.state.byId.get(tabId)
    if (!tab) return null
    const spill = tab.spillOwner.get(cellIndex(row, col)) ?? this.state.spills.get(keyOf(tab.slot, row, col))
    return spill ? spillInfo(spill) : null
  }

  /** Every spill on a tab. */
  spillsOn(tabId: string): SpillInfo[] {
    const tab = this.state.byId.get(tabId)
    if (!tab) return []
    return [...this.state.spills.values()].filter((s) => s.slot === tab.slot).map(spillInfo)
  }

  /** How far a tab's active spills reach (rows and columns counted from A1; 0 × 0 without spills). */
  spillExtent(tabId: string): { rows: number; cols: number } {
    let rows = 0
    let cols = 0
    for (const spill of this.spillsOn(tabId)) {
      if (spill.blocked) continue
      rows = Math.max(rows, spill.rect.bottom + 1)
      cols = Math.max(cols, spill.rect.right + 1)
    }
    return { rows, cols }
  }

  update(next: Workbook): SheetEngine {
    const prev = this.state.workbook
    if (next === prev) return this
    const structural =
      next.tabs.length !== prev.tabs.length ||
      !sameNames(next.names, prev.names) ||
      next.timeZone !== prev.timeZone ||
      next.tabs.some((tab, i) => {
        const old = prev.tabs[i]
        return (
          tab.id !== old.id ||
          tab.name !== old.name ||
          tabRows(tab) !== tabRows(old) ||
          tabCols(tab) !== tabCols(old)
        )
      })
    if (structural) return SheetEngine.build(next, { now: this.state.now })

    const changed: number[] = []
    next.tabs.forEach((tab, slot) => {
      const old = prev.tabs[slot]
      if (tab.cells === old.cells) return
      for (const address of new Set([...Object.keys(old.cells), ...Object.keys(tab.cells)])) {
        const a = old.cells[address]
        const b = tab.cells[address]
        if (a === b) continue
        if (a && b && a.v === b.v && a.f === b.f && a.fmt === b.fmt) continue
        const pos = parseAddress(address)
        if (pos) changed.push(keyOf(slot, pos.row, pos.col))
      }
    })
    const state: EngineState = { ...this.state, workbook: next, dirty: [], cyclic: new Set(), stamps: new Map(), seq: 0 }
    if (changed.length === 0) return new SheetEngine(state, [])
    if (changed.length > INCREMENTAL_LIMIT) return SheetEngine.build(next, { now: state.now })

    for (const key of changed) {
      const { slot, row, col } = decodeKey(key)
      const address = toA1(row, col)
      setCell(state, slot, row, col, next.tabs[slot].cells[address])
    }

    // Everything downstream of the changed cells, with the edges between them.
    const affected = new Set<number>(changed)
    const successors = new Map<number, number[]>()
    const indegree = new Map<number, number>()
    const queue = [...changed]
    while (queue.length) {
      const key = queue.pop()!
      for (const dependent of dependentsOf(state, key)) {
        if (state.formulaAt.has(key)) {
          let list = successors.get(key)
          if (!list) successors.set(key, (list = []))
          list.push(dependent)
          indegree.set(dependent, (indegree.get(dependent) ?? 0) + 1)
        }
        if (!affected.has(dependent)) {
          affected.add(dependent)
          if (affected.size > INCREMENTAL_LIMIT) return SheetEngine.build(next, { now: state.now })
          queue.push(dependent)
        }
      }
    }
    const formulas = [...affected].filter((key) => state.formulaAt.has(key))
    for (const key of formulas) indegree.set(key, indegree.get(key) ?? 0)
    const order = evaluateInOrder(state, formulas, successors, indegree)
    settleSpills(state, order)
    return new SheetEngine(state, order)
  }
}

const spillInfo = (spill: Spill): SpillInfo => {
  const { row, col } = decodeKey(spill.key)
  return { row, col, rect: spill.rect, blocked: !spill.active }
}

function lowerBound(sorted: number[], value: number): number {
  let lo = 0
  let hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (sorted[mid] < value) lo = mid + 1
    else hi = mid
  }
  return lo
}

function toA1(row: number, col: number): string {
  let n = col + 1
  let name = ''
  while (n > 0) {
    const rem = (n - 1) % 26
    name = String.fromCharCode(65 + rem) + name
    n = Math.floor((n - 1) / 26)
  }
  return `${name}${row + 1}`
}

function readCell(tab: TabState, row: number, col: number): CellValue {
  const index = cellIndex(row, col)
  if (tab.formulas.has(index)) return tab.results.get(index) ?? null
  const literal = tab.literals.get(index)
  if (literal !== undefined) return literal
  const spill = tab.spillOwner.get(index)
  if (!spill) return null
  return spill.values[(row - spill.rect.top) * spill.width + (col - spill.rect.left)] ?? null
}

function resolverFor(state: EngineState, slot: number) {
  return (sheet: string | undefined): TabState | null =>
    sheet === undefined ? state.tabs[slot] : (state.byName.get(sheet.toLowerCase()) ?? null)
}

/** Put one cell's content into the tables, replacing whatever was there. */
function setCell(state: EngineState, slot: number, row: number, col: number, cell: SheetCell | undefined) {
  const tab = state.tabs[slot]
  const index = cellIndex(row, col)
  const key = keyOf(slot, row, col)
  const old = state.formulaAt.get(key)
  if (old) {
    for (const ref of old.refs) state.refIndex.get(ref)?.delete(key)
    state.rangeOwners.delete(key)
    state.formulaAt.delete(key)
    tab.formulas.delete(index)
    tab.results.delete(index)
    clearSpill(state, key)
  }
  tab.literals.delete(index)
  if (cell?.f !== undefined) {
    const ast = cachedParse(cell.f)
    const precedents = ast ? collectPrecedents(ast, resolverFor(state, slot), state.names) : { refs: [], ranges: [] }
    const entry: FormulaEntry = { key, ast, ...precedents }
    state.formulaAt.set(key, entry)
    tab.formulas.set(index, entry)
    for (const ref of entry.refs) {
      let set = state.refIndex.get(ref)
      if (!set) state.refIndex.set(ref, (set = new Set()))
      set.add(key)
    }
    if (entry.ranges.length) state.rangeOwners.add(key)
    return
  }
  const value = literalValue(cell)
  if (value !== null) tab.literals.set(index, value)
}

const inRect = (r: CellRect, row: number, col: number) => row >= r.top && row <= r.bottom && col >= r.left && col <= r.right
const overlaps = (a: CellRect, b: CellRect) => a.top <= b.bottom && b.top <= a.bottom && a.left <= b.right && b.left <= a.right

/** Formulas that read any cell of `rect` (other than `except`'s own cell), and spills that want to cover it. */
function readersOfRect(state: EngineState, slot: number, rect: CellRect, except: number): Set<number> {
  const out = new Set<number>()
  for (let r = rect.top; r <= rect.bottom; r += 1) {
    for (let c = rect.left; c <= rect.right; c += 1) {
      const key = keyOf(slot, r, c)
      if (key === except) continue
      const refs = state.refIndex.get(key)
      if (refs) for (const reader of refs) out.add(reader)
    }
  }
  for (const owner of state.rangeOwners) {
    const entry = state.formulaAt.get(owner)
    if (entry?.ranges.some((range) => range.slot === slot && overlaps(range.rect, rect))) out.add(owner)
  }
  for (const spill of state.spills.values()) {
    if (spill.key !== except && spill.slot === slot && overlaps(spill.rect, rect)) out.add(spill.key)
  }
  return out
}

function dependentsOf(state: EngineState, key: number): Set<number> {
  const out = new Set<number>(state.refIndex.get(key) ?? [])
  const { slot, row, col } = decodeKey(key)
  for (const owner of state.rangeOwners) {
    const entry = state.formulaAt.get(owner)
    if (!entry) continue
    for (const range of entry.ranges) {
      if (range.slot === slot && inRect(range.rect, row, col)) {
        out.add(owner)
        break
      }
    }
  }
  if (state.spills.size) {
    // Writing where a spill wants to go blocks (or, cleared, unblocks) it.
    for (const spill of state.spills.values()) {
      if (spill.key !== key && spill.slot === slot && inRect(spill.rect, row, col)) out.add(spill.key)
    }
    // Readers of an anchor's spilled cells run after the anchor.
    const own = state.spills.get(key)
    if (own?.active) for (const reader of readersOfRect(state, own.slot, own.rect, key)) out.add(reader)
  }
  return out
}

/** Kahn's algorithm over `nodes`, evaluating each when its inputs are ready; leftovers are cycles. */
function evaluateInOrder(
  state: EngineState,
  nodes: number[],
  successors: Map<number, number[]>,
  indegree: Map<number, number>,
): string[] {
  const order: string[] = []
  const ready = nodes.filter((key) => (indegree.get(key) ?? 0) === 0)
  const done = new Set<number>()
  const nowDate = state.now()
  const today = todaySerial(nowDate, state.workbook.timeZone)
  const now = nowSerial(nowDate, state.workbook.timeZone)
  while (ready.length) {
    const key = ready.pop()!
    done.add(key)
    evaluateFormula(state, key, today, now)
    const { slot, row, col } = decodeKey(key)
    order.push(`${state.tabs[slot].id}!${toA1(row, col)}`)
    for (const next of successors.get(key) ?? []) {
      const remaining = (indegree.get(next) ?? 0) - 1
      indegree.set(next, remaining)
      if (remaining === 0) ready.push(next)
    }
  }
  for (const key of nodes) {
    if (done.has(key)) continue
    const { slot, row, col } = decodeKey(key)
    state.cyclic.add(key)
    clearSpill(state, key)
    state.tabs[slot].results.set(cellIndex(row, col), errors['#CYCLE!'])
  }
  return order
}

/** Most extra rounds after a run; a spill still moving after them keeps its last values. */
const MAX_SPILL_ROUNDS = 8

/**
 * After a run, re-run the readers of every spill whose footprint changed (and
 * what depends on them), in dependency order, until nothing moves. A spill that
 * reads its own cells shows up as a cycle in a later round and stays #CYCLE!.
 */
function settleSpills(state: EngineState, order: string[]) {
  for (let round = 0; round < MAX_SPILL_ROUNDS && state.dirty.length; round += 1) {
    const dirty = state.dirty
    state.dirty = []
    const affected = new Set<number>()
    for (const { key, slot, rect, seq } of dirty) {
      for (const reader of readersOfRect(state, slot, rect, key)) {
        // A reader evaluated after the change already saw it.
        if (state.formulaAt.has(reader) && (state.stamps.get(reader) ?? -1) <= seq) affected.add(reader)
      }
    }
    if (!affected.size) continue
    const successors = new Map<number, number[]>()
    const indegree = new Map<number, number>()
    const queue = [...affected]
    while (queue.length) {
      const key = queue.pop()!
      for (const dependent of dependentsOf(state, key)) {
        if (!state.formulaAt.has(dependent)) continue
        let list = successors.get(key)
        if (!list) successors.set(key, (list = []))
        list.push(dependent)
        indegree.set(dependent, (indegree.get(dependent) ?? 0) + 1)
        if (!affected.has(dependent)) {
          affected.add(dependent)
          queue.push(dependent)
        }
      }
    }
    const nodes = [...affected]
    for (const key of nodes) indegree.set(key, indegree.get(key) ?? 0)
    order.push(...evaluateInOrder(state, nodes, successors, indegree))
  }
}

function uncover(tab: TabState, spill: Spill) {
  const { rect } = spill
  for (let r = rect.top; r <= rect.bottom; r += 1) {
    for (let c = rect.left; c <= rect.right; c += 1) {
      const index = cellIndex(r, c)
      if (tab.spillOwner.get(index) === spill) tab.spillOwner.delete(index)
    }
  }
}

/** Forget a formula's spill; readers of the cells it covered re-run. */
function clearSpill(state: EngineState, key: number) {
  const old = state.spills.get(key)
  if (!old) return
  state.spills.delete(key)
  if (!old.active) return
  uncover(state.tabs[old.slot], old)
  state.dirty.push({ key, slot: old.slot, rect: old.rect, seq: state.seq })
}

/** Spill `value` from the formula at `key`; the anchor's own value, or #SPILL! when blocked. */
function placeSpill(state: EngineState, key: number, value: ArrayValue): CellValue {
  const { slot, row, col } = decodeKey(key)
  const tab = state.tabs[slot]
  const rect = { top: row, left: col, bottom: row + value.rows - 1, right: col + value.cols - 1 }
  // As in Excel, a blank inside a spilled block shows 0.
  const values = value.data.map((v) => (v === null ? 0 : v))
  let blocked = rect.bottom >= tab.rows || rect.right >= tab.cols
  for (let r = rect.top; r <= rect.bottom && !blocked; r += 1) {
    for (let c = rect.left; c <= rect.right; c += 1) {
      if (r === row && c === col) continue
      const index = cellIndex(r, c)
      const owner = tab.spillOwner.get(index)
      if (tab.formulas.has(index) || tab.literals.has(index) || (owner && owner.key !== key)) {
        blocked = true
        break
      }
    }
  }
  const old = state.spills.get(key)
  const same =
    old !== undefined &&
    old.active === !blocked &&
    old.rect.top === rect.top &&
    old.rect.bottom === rect.bottom &&
    old.rect.left === rect.left &&
    old.rect.right === rect.right &&
    (blocked || old.values.every((v, i) => v === values[i]))
  if (same) {
    return blocked ? errors['#SPILL!'] : values[0]
  }
  if (old?.active) {
    uncover(tab, old)
    state.dirty.push({ key, slot, rect: old.rect, seq: state.seq })
  }
  const spill: Spill = { key, slot, rect, width: value.cols, values, active: !blocked }
  state.spills.set(key, spill)
  if (blocked) return errors['#SPILL!']
  for (let r = rect.top; r <= rect.bottom; r += 1) {
    for (let c = rect.left; c <= rect.right; c += 1) if (r !== row || c !== col) tab.spillOwner.set(cellIndex(r, c), spill)
  }
  state.dirty.push({ key, slot, rect, seq: state.seq })
  return values[0]
}

function evaluateFormula(state: EngineState, key: number, today: number, now: number) {
  const { slot, row, col } = decodeKey(key)
  const tab = state.tabs[slot]
  const entry = state.formulaAt.get(key)
  if (!entry) return
  state.seq += 1
  state.stamps.set(key, state.seq)
  let result: CellValue
  if (state.cyclic.has(key)) {
    clearSpill(state, key)
    result = errors['#CYCLE!']
  } else if (!entry.ast) {
    clearSpill(state, key)
    result = errors['#ERROR!']
  } else {
    const host = hostFor(state, slot, today, now)
    const value = evalValue(entry.ast, host)
    if (isArrayValue(value) && (value.rows > 1 || value.cols > 1)) result = placeSpill(state, key, value)
    else {
      clearSpill(state, key)
      result = isArrayValue(value) ? value.data[0] : value
      // A formula pointing at an empty cell shows 0, as in Excel.
      if (result === null) result = 0
    }
  }
  tab.results.set(cellIndex(row, col), result)
}

/** How a formula on tab `slot` reads the workbook; `override` pretends one cell holds another value. */
function hostFor(
  state: EngineState,
  slot: number,
  today: number,
  now: number,
  override?: { slot: number; row: number; col: number; value: CellValue },
): EvalHost {
  const resolve = resolverFor(state, slot)
  return {
      slot,
      resolveSlot: (sheet) => resolve(sheet)?.slot ?? null,
      bounds: (s) => ({ rows: state.tabs[s].rows, cols: state.tabs[s].cols }),
      value: (s, r, c) =>
        override && override.slot === s && override.row === r && override.col === c ? override.value : readCell(state.tabs[s], r, c),
      today: () => today,
      now: () => now,
      spill: (s, r, c) => {
        const spill = state.spills.get(keyOf(s, r, c))
        if (spill) return spill.active ? { kind: 'range', slot: s, rect: spill.rect } : errors['#SPILL!']
        // A formula with one value is its own 1×1 spill.
        if (state.tabs[s].formulas.has(cellIndex(r, c))) return { kind: 'range', slot: s, rect: { top: r, bottom: r, left: c, right: c } }
        return errors['#REF!']
      },
      name: (name) => {
        const named = state.names.get(name.toLowerCase())
        return named ? { kind: 'range', slot: named.slot, rect: named.rect } : null
      },
    }
}
