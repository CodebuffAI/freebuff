/**
 * Freebuff Sheets — TSV (the clipboard format Excel and Google Sheets exchange)
 * and CSV (RFC 4180). Pure.
 *
 * Writing quotes a field only when it must (it holds the delimiter, a quote, a
 * newline, or leading/trailing spaces for CSV). Reading accepts quoted fields,
 * doubled quotes, CRLF or LF, and drops the single trailing newline Excel adds.
 */

function quoteField(value: string, delimiter: string, quoteSpaces: boolean): string {
  const needs =
    value.includes(delimiter) ||
    value.includes('"') ||
    value.includes('\n') ||
    value.includes('\r') ||
    (quoteSpaces && value !== value.trim())
  return needs ? `"${value.replace(/"/g, '""')}"` : value
}

export function writeDelimited(rows: string[][], delimiter: '\t' | ','): string {
  const lineEnd = delimiter === ',' ? '\r\n' : '\n'
  return rows.map((row) => row.map((field) => quoteField(field, delimiter, delimiter === ',')).join(delimiter)).join(lineEnd)
}

export const toTsv = (rows: string[][]) => writeDelimited(rows, '\t')
export const toCsv = (rows: string[][]) => writeDelimited(rows, ',')

/** Parse delimited text into rows of fields. Ragged rows are kept ragged. */
export function readDelimited(text: string, delimiter: '\t' | ','): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let i = 0
  let quoted = false
  // Strip a UTF-8 BOM, which Excel's CSV export puts first.
  if (text.charCodeAt(0) === 0xfeff) i = 1
  const n = text.length
  let fieldStarted = false
  while (i < n) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        quoted = false
        i += 1
        continue
      }
      field += ch
      i += 1
      continue
    }
    if (ch === '"' && !fieldStarted) {
      quoted = true
      fieldStarted = true
      i += 1
      continue
    }
    if (ch === delimiter) {
      row.push(field)
      field = ''
      fieldStarted = false
      i += 1
      continue
    }
    if (ch === '\r' || ch === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      fieldStarted = false
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1
      continue
    }
    field += ch
    fieldStarted = true
    i += 1
  }
  // The last line, unless the text ended with its newline.
  if (fieldStarted || field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

export const parseTsv = (text: string) => readDelimited(text, '\t')
export const parseCsv = (text: string) => readDelimited(text, ',')
