/**
 * A1 addresses: column letters, cell keys and ranges. Pure, no React.
 *
 * Rows and columns are 0-based internally (`{ row: 0, col: 0 }` is `A1`).
 */

export type CellPos = { row: number; col: number }

/** An inclusive rectangle, normalised so `top <= bottom` and `left <= right`. */
export type CellRect = { top: number; left: number; bottom: number; right: number }

const ADDRESS = /^([A-Z]{1,3})([1-9][0-9]{0,6})$/

/** `0` → `A`, `25` → `Z`, `26` → `AA`. */
export function colName(col: number): string {
  let n = col + 1
  let name = ''
  while (n > 0) {
    const rem = (n - 1) % 26
    name = String.fromCharCode(65 + rem) + name
    n = Math.floor((n - 1) / 26)
  }
  return name
}

/** `A` → `0`, `AA` → `26`. Letters must be upper case. */
export function colIndex(name: string): number {
  let n = 0
  for (let i = 0; i < name.length; i += 1) n = n * 26 + (name.charCodeAt(i) - 64)
  return n - 1
}

export function toAddress(pos: CellPos): string {
  return `${colName(pos.col)}${pos.row + 1}`
}

/** `B3` → `{ row: 2, col: 1 }`; anything else (lower case, `$`, `A0`) → `null`. */
export function parseAddress(address: string): CellPos | null {
  const match = ADDRESS.exec(address)
  if (!match) return null
  return { row: Number(match[2]) - 1, col: colIndex(match[1]) }
}

export function rectOf(a: CellPos, b: CellPos): CellRect {
  return {
    top: Math.min(a.row, b.row),
    bottom: Math.max(a.row, b.row),
    left: Math.min(a.col, b.col),
    right: Math.max(a.col, b.col),
  }
}

export function rectContains(rect: CellRect, pos: CellPos): boolean {
  return pos.row >= rect.top && pos.row <= rect.bottom && pos.col >= rect.left && pos.col <= rect.right
}

export function rectSize(rect: CellRect): { rows: number; cols: number } {
  return { rows: rect.bottom - rect.top + 1, cols: rect.right - rect.left + 1 }
}

/** `A1:C3`, or `A1` for a single cell. */
export function rectToRange(rect: CellRect): string {
  const start = toAddress({ row: rect.top, col: rect.left })
  if (rect.top === rect.bottom && rect.left === rect.right) return start
  return `${start}:${toAddress({ row: rect.bottom, col: rect.right })}`
}

/** `A1:C3` or `A1` → a rect; `null` when malformed. (No sheet prefix, no `$`.) */
export function parseRange(range: string): CellRect | null {
  const [first, second, extra] = range.split(':')
  if (extra !== undefined || !first) return null
  const a = parseAddress(first)
  const b = second === undefined ? a : parseAddress(second)
  if (!a || !b) return null
  return rectOf(a, b)
}

/**
 * A range with an optional tab prefix: `Summary!A1:C3`, `'Q4 plan'!B2`.
 * Returns the tab name (unquoted) when present.
 */
export function parseSheetRange(source: string): { tab?: string; rect: CellRect } | null {
  const bang = source.lastIndexOf('!')
  if (bang === -1) {
    const rect = parseRange(source)
    return rect ? { rect } : null
  }
  let tab = source.slice(0, bang)
  if (tab.startsWith("'")) {
    if (!tab.endsWith("'") || tab.length < 3) return null
    tab = tab.slice(1, -1).replace(/''/g, "'")
  }
  if (!tab) return null
  const rect = parseRange(source.slice(bang + 1))
  return rect ? { tab, rect } : null
}

/** A tab name as a formula writes it: bare when it is a plain word, otherwise quoted. */
export function quoteTabName(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) && !/^[A-Za-z]{1,3}[0-9]+$/.test(name)
    ? name
    : `'${name.replace(/'/g, "''")}'`
}
