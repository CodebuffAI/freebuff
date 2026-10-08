// Spreadsheet applications trim leading Unicode whitespace before deciding
// whether a cell is a formula. Prefix the literal apostrophe before that
// whitespace, including raw tab/CR/LF, so the full value is always text.
const FORMULA_PREFIX = /^[\p{White_Space}﻿]*[=+\-@]/u

/** One RFC 4180 CSV field that a spreadsheet will never run as a formula. */
export function csvCell(value: unknown): string {
  const text = String(value ?? '')
  const safe = FORMULA_PREFIX.test(text) ? `'${text}` : text
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

export function csvRow(values: readonly unknown[]): string {
  return values.map(csvCell).join(',')
}
