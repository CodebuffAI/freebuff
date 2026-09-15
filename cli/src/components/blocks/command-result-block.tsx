import { TextAttributes } from '@opentui/core'
import { memo } from 'react'

import { useTheme } from '../../hooks/use-theme'

import type { ReactNode } from 'react'

interface CommandResultBlockProps {
  content: string
  commandResult: 'undo' | 'redo'
}

/**
 * Renders /undo and /redo confirmation messages with per-part colors so they
 * stand out from plain agent output without relying on non-serializable
 * render blocks:
 *
 *   - heading: bold, in the accent color (amber for undo, green for redo)
 *   - icons (↺ / 🗑): accent color; filenames: default foreground; " (deleted)": muted
 *   - diff stat bar (e.g. "app.js | 10 ++++++---"): " | " in the accent color,
 *     and the + / - runs colored git-style (green additions, red deletions)
 *   - diff summary: "(+)" green, "(-)" red
 *
 * The content format is produced by `undoToRecord` / `redoToRecord` in
 * `cli/src/state/undo-store.ts`.
 */
export const CommandResultBlock = memo(
  ({ content, commandResult }: CommandResultBlockProps) => {
    const theme = useTheme()
    const accent = commandResult === 'undo' ? theme.warning : theme.success

    const renderBar = (bar: string, keyPrefix: string): ReactNode[] => {
      // Split the stat bar into contiguous + and - runs so each gets its own
      // color (git convention: additions green, deletions red).
      const nodes: ReactNode[] = []
      let run = ''
      for (let i = 0; i <= bar.length; i++) {
        const next = i < bar.length ? bar[i] : ''
        // End the run before adding a different char so runs stay exact
        // (e.g. "+++++++++----" splits into "+++++++++" and "----").
        if (run && (i === bar.length || next !== run[0])) {
          nodes.push(
            <span
              key={`${keyPrefix}-${i}`}
              fg={run[0] === '+' ? theme.success : theme.error}
            >
              {run}
            </span>,
          )
          run = ''
        }
        if (i < bar.length) run += bar[i]
      }
      return nodes
    }

    const renderLine = (rawLine: string, idx: number): ReactNode => {
      const line = rawLine
      if (!line.trim()) return null

      // Heading: **Undid the last change:** / **Redid the last change (2 files):**
      const headingMatch = /^\*\*(.+)\*\*$/u.exec(line)
      if (headingMatch) {
        return (
          <text key={idx} style={{ wrapMode: 'word' }}>
            <span fg={accent} attributes={TextAttributes.BOLD}>
              {headingMatch[1]}
            </span>
          </text>
        )
      }

      // File lines: "  ↺ app.js" / "  🗑 notas.md (deleted)"
      // The u flag matters: 🗑 is an astral code point (surrogate pair) and
      // without it a character class treats it as two lone surrogates.
      const fileMatch = /^ {2}([↺🗑]) (.*)$/u.exec(line)
      if (fileMatch) {
        const rest = fileMatch[2]!
        const deletedMatch = /^(.*) \(deleted\)$/u.exec(rest)
        return (
          <text key={idx} style={{ wrapMode: 'word' }}>
            <span fg={accent}>{fileMatch[1]}</span>
            <span fg={theme.foreground}>
              {` ${deletedMatch ? deletedMatch[1] : rest}`}
            </span>
            {deletedMatch && <span fg={theme.muted}> (deleted)</span>}
          </text>
        )
      }

      // Diff stat line: "app.js | 10 ++++++---"
      const statMatch = /^\s*(.+?)\s+\|\s+(\d+)\s+([+-]+)\s*$/u.exec(line)
      if (statMatch) {
        return (
          <text key={idx} style={{ wrapMode: 'word' }}>
            <span fg={theme.foreground}>{statMatch[1]}</span>
            <span fg={accent}>{' | '}</span>
            <span fg={theme.foreground}>{` ${statMatch[2]} `}</span>
            {renderBar(statMatch[3]!, `bar-${idx}`)}
          </text>
        )
      }

      // Diff summary: "1 file changed, 2 insertions(+), 5 deletions(-)"
      if (/^\s*\d+ files? changed/u.test(line)) {
        const parts = line.trim().split(/(\([+-]\))/)
        return (
          <text key={idx} style={{ wrapMode: 'word' }}>
            {parts.map((part, pIdx) => {
              if (part === '(+)') {
                return (
                  <span key={pIdx} fg={theme.success}>
                    {part}
                  </span>
                )
              }
              if (part === '(-)') {
                return (
                  <span key={pIdx} fg={theme.error}>
                    {part}
                  </span>
                )
              }
              return (
                <span key={pIdx} fg={theme.foreground}>
                  {part}
                </span>
              )
            })}
          </text>
        )
      }

      // Binary stat lines: " Bin 0 -> 123 bytes"
      if (/^\s*Bin\b/u.test(line)) {
        return (
          <text key={idx} style={{ wrapMode: 'word' }}>
            <span fg={theme.muted}>{line.trim()}</span>
          </text>
        )
      }

      // Fallback: plain text.
      return (
        <text key={idx} style={{ wrapMode: 'word' }}>
          <span fg={theme.foreground}>{line}</span>
        </text>
      )
    }

    return (
      <box style={{ flexDirection: 'column', gap: 0, width: '100%' }}>
        {content.split('\n').map((line, idx) => renderLine(line, idx))}
      </box>
    )
  },
)

CommandResultBlock.displayName = 'CommandResultBlock'
