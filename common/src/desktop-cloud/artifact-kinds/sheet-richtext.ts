/**
 * Freebuff Sheets — rich text inside one cell, as styled runs (`cell.runs`) over the plain text
 * `cell.v`. The editor types it Markdown-ish: **bold**, *italic*, ~~strike~~, ++underline++ and
 * [label](https://url); a cell that holds runs edits back as the same markup. Pure.
 *
 * `v` stays the plain text, so formulas, find, sort and CSV read the words, never the markup.
 */

import { safeLinkHref } from './safe-link'
import type { SheetCell, TextRun } from './sheet'

const LINK = /^\[([^\]\n]+)\]\(([^)\s]+)\)/
const WORD = /[\p{L}\p{N}]/u
const MARKS: Array<{ open: string; key: 'bold' | 'italic' | 'strike' | 'underline' }> = [
  { open: '**', key: 'bold' },
  { open: '~~', key: 'strike' },
  { open: '++', key: 'underline' },
  { open: '*', key: 'italic' },
]

/** A run with no style of its own folds into its plain neighbours. */
function push(runs: TextRun[], run: TextRun) {
  if (!run.text) return
  const last = runs[runs.length - 1]
  const plain = (r: TextRun) => Object.keys(r).length === 1
  if (last && plain(last) && plain(run)) last.text += run.text
  else runs.push(run)
}

/**
 * Markup → plain text plus runs; `null` when `raw` holds no markup (so it is ordinary text).
 * An unsafe link (`javascript:`) stays literal text.
 */
export function parseRichText(raw: string): { text: string; runs: TextRun[] } | null {
  const runs: TextRun[] = []
  let plain = ''
  let styled = false
  let i = 0
  while (i < raw.length) {
    const rest = raw.slice(i)
    const link = LINK.exec(rest)
    if (link) {
      const href = safeLinkHref(link[2])
      if (href) {
        push(runs, { text: plain })
        plain = ''
        push(runs, { text: link[1], link: href })
        styled = true
        i += link[0].length
        continue
      }
    }
    const mark = MARKS.find((m) => rest.startsWith(m.open))
    if (mark) {
      const close = rest.indexOf(mark.open, mark.open.length + 1)
      const inner = close > 0 ? rest.slice(mark.open.length, close) : ''
      // Stricter than Markdown so arithmetic and globs stay text ("2*3*4", "*.ts,*.tsx"): the
      // markers sit at word edges, the marked text starts and ends with a letter or digit,
      // and never crosses a line.
      const before = i === 0 ? '' : raw[i - 1]
      const after = raw[i + close + mark.open.length] ?? ''
      const edge = (ch: string) => ch === '' || (!WORD.test(ch) && ch !== '*' && ch !== '~' && ch !== '+')
      if (
        inner &&
        WORD.test(inner[0]) &&
        WORD.test(inner[inner.length - 1]) &&
        edge(before) &&
        edge(after) &&
        !inner.includes('\n') &&
        !(mark.open === '*' && inner.includes('*'))
      ) {
        push(runs, { text: plain })
        plain = ''
        const run: TextRun = { text: inner }
        run[mark.key] = true
        push(runs, run)
        styled = true
        i += close + mark.open.length
        continue
      }
    }
    plain += raw[i]
    i += 1
  }
  if (!styled) return null
  push(runs, { text: plain })
  return { text: runs.map((run) => run.text).join(''), runs }
}

/** Runs → the markup the editor shows (the inverse of `parseRichText` for what it makes). */
export function richTextToMarkup(runs: readonly TextRun[]): string {
  return runs
    .map((run) => {
      let text = run.text
      if (run.link) return `[${text}](${run.link})`
      if (run.italic) text = `*${text}*`
      if (run.strike) text = `~~${text}~~`
      if (run.underline) text = `++${text}++`
      if (run.bold) text = `**${text}**`
      return text
    })
    .join('')
}

/** The runs a cell shows, or null when they no longer match its text (a stale edit). */
export function cellRuns(cell: SheetCell | undefined): TextRun[] | null {
  if (!cell?.runs || typeof cell.v !== 'string') return null
  return cell.runs.map((run) => run.text).join('') === cell.v ? cell.runs : null
}

/** `@Maya` or `@maya.lee`: a person mention, shown as a chip (no directory behind it). */
export function isMention(text: string): boolean {
  return /^@[\p{L}\p{N}._-]{1,40}(?: [\p{L}\p{N}._-]{1,40})?$/u.test(text)
}
