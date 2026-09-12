import { spawnSync } from 'child_process'
import { existsSync } from 'fs'
import { rm } from 'fs/promises'
import path from 'path'

import { resolveSkillsDirs } from '@codebuff/sdk'
import { useKeyboard } from '@opentui/react'
import React, { useCallback, useEffect, useMemo, useState } from 'react'

import { Button } from './button'
import { ClickableTitleBox } from './clickable-title-box'
import { useTheme } from '../hooks/use-theme'
import { getProjectRoot, tryGetProjectRoot } from '../project-files'
import { refreshSkillRegistry } from '../utils/skill-registry'
import { truncateToSingleLinePreview } from '../utils/agent-display'
import { clamp } from '../utils/math'
import {
  resolveSkillsPanelAction,
} from '../utils/skills-panel-actions'
import {
  estimateTokens,
  matchesSkillQuery,
  renderTokens,
} from '../utils/skills-panel-format'
import { BORDER_CHARS } from '../utils/ui-constants'

import type { SkillDefinition } from '@codebuff/common/types/skill'
import type { KeyEvent } from '@opentui/core'

interface SkillsPanelProps {
  skills: SkillDefinition[]
  /** Invoke the named skill: enters skill input mode, like /skill:<name>. */
  onInvoke: (name: string) => void
  onClose: () => void
  /** Width of the surrounding chat chrome, so rows truncate on the same
   *  column the composer wraps on. */
  width: number
  /** Rows to show before the list starts scrolling around the selection. */
  maxVisibleRows?: number
}

const DEFAULT_MAX_VISIBLE_ROWS = 8

/** Keep the selected row inside the window even when the list scrolls past it. */
function windowStart(
  selectedIndex: number,
  total: number,
  visible: number,
): number {
  if (total <= visible) return 0
  return clamp(selectedIndex - Math.floor(visible / 2), 0, total - visible)
}

/** Which skills directory a skill loaded from, for the row badge. */
let projectSkillsDirs: Set<string> | null = null

function getProjectSkillsDirs(): Set<string> {
  // Lazily computed on first render: getProjectRoot() is only meaningful
  // after the CLI finishes booting, and module-load order does not guarantee
  // that. One Set, resolved once — the project root cannot change mid-session.
  projectSkillsDirs ??= new Set(
    resolveSkillsDirs({ cwd: tryGetProjectRoot() || process.cwd() }).map(
      (dir) => path.resolve(dir),
    ),
  )
  return projectSkillsDirs
}

function sourceOf(skill: SkillDefinition): 'project' | 'global' {
  // <skillsDir>/<skill-name>/SKILL.md — the grandparent of the file is the
  // skills directory it was discovered in. Resolved on both sides so mixed
  // separators cannot break the comparison on Windows.
  const skillsDir = path.resolve(
    path.dirname(path.dirname(skill.filePath)),
  )
  return getProjectSkillsDirs().has(skillsDir) ? 'project' : 'global'
}

export const SkillsPanel: React.FC<SkillsPanelProps> = ({
  skills,
  onInvoke,
  onClose,
  width,
  maxVisibleRows = DEFAULT_MAX_VISIBLE_ROWS,
}) => {
  const theme = useTheme()

  // Selection tracks the skill name, so it stays put when the list re-sorts
  // or a sibling is deleted.
  const [selectedName, setSelectedName] = useState<string | null>(
    skills[0]?.name ?? null,
  )
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [searching, setSearching] = useState(false)
  const [query, setQuery] = useState('')
  const filterActive = query.length > 0

  const filtered = useMemo(
    () => skills.filter((skill) => matchesSkillQuery(skill, query)),
    [skills, query],
  )

  // Selection rides through the filter by name; when the current selection
  // (or the whole list) filters away, snap to the top so Enter is never dead.
  const selectedIndex = Math.max(
    0,
    filtered.findIndex((skill) => skill.name === selectedName),
  )
  const selected = filtered[selectedIndex]
  useEffect(() => {
    if (!selected) setSelectedName(filtered[0]?.name ?? null)
  }, [selected, filtered])

  // Nothing left to manage: hand the composer back rather than leave an empty
  // box for the user to dismiss.
  useEffect(() => {
    if (skills.length === 0) onClose()
  }, [skills.length, onClose])

  // A pending confirmation for a skill that just vanished (deleted out from
  // under us in another terminal) can no longer land on anything.
  useEffect(() => {
    if (confirmingDelete && !selected) setConfirmingDelete(false)
  }, [confirmingDelete, selected])

  const deleteSelected = useCallback(async () => {
    if (!selected) return
    // Claude Code semantics: removing a skill removes its DIRECTORY, not just
    // SKILL.md — a skill can carry supporting files (reference docs, scripts)
    // that would otherwise be orphaned.
    const skillDir = path.dirname(selected.filePath)
    if (!existsSync(skillDir)) {
      setNotice(`Directory not found: ${skillDir}`)
      return
    }
    try {
      await rm(skillDir, { recursive: true })
      // Refresh the registry right away: the version bump re-renders the
      // panel with the refreshed list instead of waiting for the
      // refresh-on-open.
      void refreshSkillRegistry()
      // Dropping the row moves the cursor to whatever fills the vacancy.
      const successor = filtered[selectedIndex + 1] ?? filtered[selectedIndex - 1]
      setSelectedName(successor?.name ?? null)
      setNotice(`Deleted ${skillDir}`)
    } catch (error) {
      setNotice(
        `Could not delete: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }, [selected, filtered, selectedIndex])

  const openInEditor = useCallback(() => {
    if (!selected) return
    const editor =
      process.env.VISUAL ?? process.env.EDITOR ?? (process.platform === 'win32' ? 'notepad' : 'vi')
    // Inherit stdio so the editor owns the terminal, matching how /bash runs
    // interactive commands.
    const result = spawnSync(editor, [selected.filePath], { stdio: 'inherit' })
    if (result.error || result.status !== 0) {
      setNotice(`Could not open $EDITOR (${editor}). Set EDITOR and try again.`)
    }
  }, [selected])

  const handleKey = useCallback(
    (key: KeyEvent) => {
      const action = resolveSkillsPanelAction(key, {
        confirmingDelete,
        searching,
        filterActive,
      })
      if (action.type === 'none') return
      // Any deliberate action supersedes the last complaint.
      if (action.type !== 'confirm') setNotice(null)

      switch (action.type) {
        case 'close':
          onClose()
          return
        case 'cancel':
          setConfirmingDelete(false)
          return
        case 'search-start':
          setSearching(true)
          return
        case 'search-exit':
          setSearching(false)
          return
        case 'search-clear':
          setQuery('')
          return
        case 'search-input':
          setQuery((prev) => prev + action.char)
          return
        case 'search-backspace':
          if (query.length > 0) setQuery(query.slice(0, -1))
          // Backspace on an empty query leaves search mode (common editor
          // convention) instead of stranding the user in an empty search.
          else setSearching(false)
          return
        case 'select': {
          const to = clamp(selectedIndex + action.delta, 0, filtered.length - 1)
          setSelectedName(filtered[to]?.name ?? null)
          return
        }
        case 'invoke':
          if (selected) onInvoke(selected.name)
          return
        case 'open':
          openInEditor()
          return
        case 'delete':
          if (selected) setConfirmingDelete(true)
          return
        case 'confirm':
          setConfirmingDelete(false)
          void deleteSelected()
          return
      }
    },
    [
      confirmingDelete,
      deleteSelected,
      filtered,
      filterActive,
      onClose,
      onInvoke,
      openInEditor,
      query,
      searching,
      selected,
      selectedIndex,
   ],
  )

  useKeyboard(handleKey)

  // A row must fit one line or it wraps and the list stops being scannable.
  // Budget: two border columns, two padding columns, then "❯ " + badge + gap
  // + right-aligned token estimate, so descriptions truncate where the
  // composer would.
  const promptWidth = Math.max(10, width - 22)
  const rowLabel = useCallback(
    (skill: SkillDefinition) => {
      const badge = sourceOf(skill) === 'project' ? 'project' : 'global'
      const tokens = renderTokens(estimateTokens(skill))
      const suffix = ` ${tokens}`
      const body =
        truncateToSingleLinePreview(skill.description, promptWidth - suffix.length) ?? ''
      return `${badge.padEnd(7)} ${body.padEnd(Math.max(0, promptWidth - suffix.length))}${suffix}`
    },
    [promptWidth],
  )

  const projectCount = useMemo(
    () => skills.filter((skill) => sourceOf(skill) === 'project').length,
    [skills],
  )
  const globalCount = skills.length - projectCount
  const hiddenBySearch = skills.length - filtered.length

  const start = windowStart(selectedIndex, filtered.length, maxVisibleRows)
  const visible = filtered.slice(start, start + maxVisibleRows)
  const hiddenBelow = filtered.length - (start + visible.length)

  return (
    <ClickableTitleBox
      title={` ▾ Skills — ${skills.length} loaded (${projectCount} project, ${globalCount} global) `}
      titleAlignment="center"
      onTitleClick={onClose}
      style={{
        width: '100%',
        borderStyle: 'single',
        borderColor: theme.border,
        customBorderChars: BORDER_CHARS,
        paddingLeft: 1,
        paddingRight: 1,
        flexDirection: 'column',
      }}
    >
      {start > 0 && <text style={{ fg: theme.muted }}>{`  ↑ ${start} more`}</text>}

      {visible.map((skill, offset) => {
        const index = start + offset
        const isSelected = index === selectedIndex

        return (
          <Button
            key={skill.name}
            onMouseOver={() => setSelectedName(skill.name)}
            style={{
              width: '100%',
              height: 1,
              backgroundColor: isSelected ? theme.surface : undefined,
            }}
          >
            <text
              style={{
                fg: isSelected ? theme.info : theme.foreground,
                wrapMode: 'none',
              }}
            >
              {isSelected ? '❯ ' : '  '}
              {rowLabel(skill)}
            </text>
          </Button>
        )
      })}

      {hiddenBelow > 0 && (
        <text style={{ fg: theme.muted }}>{`  ↓ ${hiddenBelow} more`}</text>
      )}

      {hiddenBySearch > 0 && (
        <text style={{ fg: theme.muted }}>
          {`${hiddenBySearch} hidden by filter`}
          </text>
      )}

      {notice && <text style={{ fg: theme.warning }}>{notice}</text>}

      {searching ? (
        <text style={{ fg: theme.info, wrapMode: 'none' }}>
          {`/${query}▏ type to filter · esc done`}
        </text>
      ) : confirmingDelete ? (
        <text style={{ fg: theme.warning }}>
          {`Delete ${selected && path.dirname(selected.filePath)}/? Enter confirm · Esc cancel`}
        </text>
      ) : (
        <text style={{ fg: theme.muted }}>
          {filterActive
            ? '/ filter · esc clears filter · esc again closes'
            : '/ filter · Enter run · o open · d delete · esc close'}
        </text>
      )}
    </ClickableTitleBox>
  )
}
