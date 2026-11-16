/**
 * CSV/TSV (DDE) injection: a text cell written to a file another app opens is never run as a
 * formula there. Spreadsheet apps trim leading whitespace (and a BOM) before deciding, and treat
 * a leading `=`, `+`, `-`, `@`, tab or CR as a formula, so such text gets a leading `'`.
 *
 * THE RULE: anything labelled export, download or "copy as CSV/TSV for other apps" is guarded
 * with `formulaSafeCell`. An in-app lossless copy (the sheet's clipboard, pasted back into our own
 * grid) stays raw. Only TEXT is guarded: a number such as -5 is a value, never prefixed.
 */
const FORMULA_START = /^[\p{White_Space}﻿]*[=+\-@]|^[\t\r]/u

export function formulaSafeCell(text: string): string {
  return FORMULA_START.test(text) ? `'${text}` : text
}
