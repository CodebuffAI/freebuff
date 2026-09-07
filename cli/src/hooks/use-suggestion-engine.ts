import { promises as fs } from 'fs'

import {
  getAllPathsWithDirectories,
  getProjectFileTree,
  type PathInfo,
} from '@codebuff/common/project-file-tree'
import { useEffect, useMemo, useRef, useState } from 'react'


import { getProjectRoot } from '../project-files'
import { range } from '../utils/arrays'
import { logger } from '../utils/logger'

import type { SuggestionItem } from '../components/suggestion-menu'
import type { SlashCommand } from '../data/slash-commands'
import type { Prettify } from '../types/utils'
import type { AgentMode } from '../utils/constants'
import type { LocalAgentInfo } from '../utils/local-agent-registry'
import type { FileTreeNode } from '@codebuff/common/util/file'

export interface TriggerContext {
  active: boolean
  query: string
  startIndex: number
}

interface LineInfo {
  lineStart: number
  line: string
}

const getCurrentLineInfo = (
  input: string,
  cursorPosition?: number,
): LineInfo => {
  const upto = cursorPosition ?? input.length
  const textUpTo = input.slice(0, upto)
  const lastNewline = textUpTo.lastIndexOf('\n')
  const lineStart = lastNewline === -1 ? 0 : lastNewline + 1
  const line = textUpTo.slice(lineStart)
  return { lineStart, line }
}

const parseSlashContext = (input: string): TriggerContext => {
  if (!input) {
    return { active: false, query: '', startIndex: -1 }
  }

  const { lineStart, line } = getCurrentLineInfo(input)

  const match = line.match(/^(\s*)\/([^\s]*)$/)
  if (!match) {
    return { active: false, query: '', startIndex: -1 }
  }

  const [, leadingWhitespace, commandSegment] = match
  const startIndex = lineStart + leadingWhitespace.length

  // Slash commands only activate on the first line (startIndex must be 0)
  if (startIndex !== 0) {
    return { active: false, query: '', startIndex: -1 }
  }

  return { active: true, query: commandSegment, startIndex }
}

interface MentionParseResult {
  active: boolean
  query: string
  atIndex: number
}

// Helper to check if a position is inside string delimiters (double quotes or backticks only)
// Single quotes are excluded because they're commonly used as apostrophes (don't, it's, etc.)
export const isInsideStringDelimiters = (text: string, position: number): boolean => {
  let inDoubleQuote = false
  let inBacktick = false

  for (let i = 0; i < position; i++) {
    const char = text[i]
    
    // Check if this character is escaped by counting preceding backslashes
    let numBackslashes = 0
    let j = i - 1
    while (j >= 0 && text[j] === '\\') {
      numBackslashes++
      j--
    }
    
    // If there's an odd number of backslashes, the character is escaped
    const isEscaped = numBackslashes % 2 === 1

    if (!isEscaped) {
      if (char === '"' && !inBacktick) {
        inDoubleQuote = !inDoubleQuote
      } else if (char === '`' && !inDoubleQuote) {
        inBacktick = !inBacktick
      }
    }
  }

  return inDoubleQuote || inBacktick
}

export const parseAtInLine = (line: string): MentionParseResult => {
  const atIndex = line.lastIndexOf('@')
  if (atIndex === -1) {
    return { active: false, query: '', atIndex: -1 }
  }

  // Check if @ is inside string delimiters
  if (isInsideStringDelimiters(line, atIndex)) {
    return { active: false, query: '', atIndex: -1 }
  }

  const beforeChar = atIndex > 0 ? line[atIndex - 1] : ''
  
  // Don't trigger on escaped @: \@
  if (beforeChar === '\\') {
    return { active: false, query: '', atIndex: -1 }
  }

  // Don't trigger on email-like patterns or URLs: user@example.com, https://example.com/@user
  // Check for alphanumeric, dot, or colon before @
  if (beforeChar && /[a-zA-Z0-9.:]/.test(beforeChar)) {
    return { active: false, query: '', atIndex: -1 }
  }

  // Require whitespace or start of line before @
  if (beforeChar && !/\s/.test(beforeChar)) {
    return { active: false, query: '', atIndex: -1 }
  }

  const afterAt = line.slice(atIndex + 1)
  const firstSpaceIndex = afterAt.search(/\s/)
  const query = firstSpaceIndex === -1 ? afterAt : afterAt.slice(0, firstSpaceIndex)

  if (firstSpaceIndex !== -1) {
    return { active: false, query: '', atIndex: -1 }
  }

  return { active: true, query, atIndex }
}

const parseMentionContext = (
  input: string,
  cursorPosition: number,
): TriggerContext => {
  if (!input) {
    return { active: false, query: '', startIndex: -1 }
  }

  const { lineStart, line } = getCurrentLineInfo(input, cursorPosition)
  const { active, query, atIndex } = parseAtInLine(line)

  if (!active) {
    return { active: false, query: '', startIndex: -1 }
  }

  const startIndex = lineStart + atIndex

  return { active: true, query, startIndex }
}

export type MatchedSlashCommand = Prettify<
  SlashCommand &
    Pick<
      SuggestionItem,
      'descriptionHighlightIndices' | 'labelHighlightIndices'
    >
>

const filterSlashCommands = (
  commands: SlashCommand[],
  query: string,
): MatchedSlashCommand[] => {
  if (!query) {
    return commands
  }

  const normalized = query.toLowerCase()
  const matches: MatchedSlashCommand[] = []
  const seen = new Set<string>()
  const pushUnique = createPushUnique<MatchedSlashCommand, string>(
    (command) => command.id,
    seen,
  )
  // Prefix of ID
  for (const command of commands) {
    if (seen.has(command.id)) continue
    const id = command.id.toLowerCase()
    const aliasList = (command.aliases ?? []).map((alias) =>
      alias.toLowerCase(),
    )

    if (
      id.startsWith(normalized) ||
      aliasList.some((alias) => alias.startsWith(normalized))
    ) {
      const label = command.label.toLowerCase()
      const firstIndex = label.indexOf(normalized)
      const indices =
        firstIndex === -1
          ? null
          : createHighlightIndices(firstIndex, firstIndex + normalized.length)
      pushUnique(matches, {
        ...command,
        ...(indices && { labelHighlightIndices: indices }),
      })
    }
  }

  // Substring of ID
  for (const command of commands) {
    if (seen.has(command.id)) continue
    const id = command.id.toLowerCase()
    const aliasList = (command.aliases ?? []).map((alias) =>
      alias.toLowerCase(),
    )

    if (
      id.includes(normalized) ||
      aliasList.some((alias) => alias.includes(normalized))
    ) {
      const label = command.label.toLowerCase()
      const firstIndex = label.indexOf(normalized)
      const indices =
        firstIndex === -1
          ? null
          : createHighlightIndices(firstIndex, firstIndex + normalized.length)
      pushUnique(matches, {
        ...command,
        ...(indices && {
          labelHighlightIndices: indices,
        }),
      })
    }
  }

  // Substring of description
  for (const command of commands) {
    if (seen.has(command.id)) continue
    const description = command.description.toLowerCase()

    if (description.includes(normalized)) {
      const firstIndex = description.indexOf(normalized)
      const indices =
        firstIndex === -1
          ? null
          : createHighlightIndices(firstIndex, firstIndex + normalized.length)
      pushUnique(matches, {
        ...command,
        ...(indices && {
          descriptionHighlightIndices: indices,
        }),
      })
    }
  }

  return matches
}

export type MatchedAgentInfo = Prettify<
  LocalAgentInfo & {
    nameHighlightIndices?: number[] | null
    idHighlightIndices?: number[] | null
  }
>

export type MatchedFileInfo = Prettify<{
  filePath: string
  isDirectory: boolean
  pathHighlightIndices?: number[] | null
  matchScore?: number
}>

const flattenFileTree = (nodes: FileTreeNode[]): PathInfo[] =>
  getAllPathsWithDirectories(nodes)

const getFileName = (filePath: string): string => {
  const lastSlash = filePath.lastIndexOf('/')
  return lastSlash === -1 ? filePath : filePath.slice(lastSlash + 1)
}

const createHighlightIndices = (start: number, end: number): number[] => {
  const result: number[] = []
  for (let i = start; i < end; i++) {
    result.push(i)
  }
  return result
}

const createPushUnique = <T, K>(
  getKey: (item: T) => K,
  seen: Set<K>,
) => {
  return (target: T[], item: T) => {
    const key = getKey(item)
    if (!seen.has(key)) {
      target.push(item)
      seen.add(key)
    }
  }
}

/**
 * Fuzzy match: matches characters in order, allowing gaps.
 * Returns highlight indices if matched, null if not.
 * Also returns a score (lower is better) based on match quality.
 */
const fuzzyMatch = (
  text: string,
  query: string,
): { indices: number[]; score: number } | null => {
  const textLower = text.toLowerCase()
  const queryLower = query.toLowerCase()
  const indices: number[] = []
  let textIdx = 0
  let lastMatchIdx = -1
  let gaps = 0
  let consecutiveMatches = 0
  let maxConsecutive = 0

  for (let queryIdx = 0; queryIdx < queryLower.length; queryIdx++) {
    const char = queryLower[queryIdx]
    let found = false

    while (textIdx < textLower.length) {
      if (textLower[textIdx] === char) {
        // Prefer matches at word boundaries (after / or at start)
        if (lastMatchIdx >= 0 && textIdx > lastMatchIdx + 1) {
          gaps += textIdx - lastMatchIdx - 1
          consecutiveMatches = 1
        } else {
          consecutiveMatches++
          maxConsecutive = Math.max(maxConsecutive, consecutiveMatches)
        }
        indices.push(textIdx)
        lastMatchIdx = textIdx
        textIdx++
        found = true
        break
      }
      textIdx++
    }

    if (!found) return null
  }

  // Capture final consecutive run
  maxConsecutive = Math.max(maxConsecutive, consecutiveMatches)

  // Score: lower is better
  // - Fewer gaps = better
  // - Longer consecutive matches = better
  // - Matches at word boundaries (after /) = better
  let boundaryBonus = 0
  for (let i = 0; i < indices.length; i++) {
    const idx = indices[i]
    if (idx === 0 || text[idx - 1] === '/') {
      boundaryBonus++
    }
  }

  const score =
    gaps * 10 -
    maxConsecutive * 5 -
    boundaryBonus * 15 +
    (indices[0] ?? 0) // Prefer matches that start earlier

  return { indices, score }
}

export const filterFileMatches = (
  pathInfos: PathInfo[],
  query: string,
): MatchedFileInfo[] => {
  if (!query) {
    return []
  }

  const normalized = query.toLowerCase()
  const matches: MatchedFileInfo[] = []
  const seen = new Set<string>()

  const pushUnique = createPushUnique<MatchedFileInfo, string>(
    (file) => file.filePath,
    seen,
  )

  // Check if query contains slashes for path-segment matching
  const querySegments = normalized.split('/')
  const hasSlashes = querySegments.length > 1

  // Helper to match path segments (for queries with /)
  const matchPathSegments = (filePath: string): { indices: number[]; score: number } | null => {
    const pathLower = filePath.toLowerCase()
    const highlightIndices: number[] = []
    let searchStart = 0
    let totalGaps = 0

    for (const segment of querySegments) {
      if (!segment) continue

      const segmentIndex = pathLower.indexOf(segment, searchStart)
      if (segmentIndex === -1) {
        return null
      }

      // Count gaps between segments
      if (searchStart > 0) {
        totalGaps += segmentIndex - searchStart
      }

      for (let i = 0; i < segment.length; i++) {
        highlightIndices.push(segmentIndex + i)
      }

      searchStart = segmentIndex + segment.length
    }

    const score = totalGaps * 5 + filePath.length
    return { indices: highlightIndices, score }
  }

  for (const { path: filePath, isDirectory } of pathInfos) {
    if (seen.has(filePath)) continue

    const fileName = getFileName(filePath)
    const fileNameLower = fileName.toLowerCase()
    const pathLower = filePath.toLowerCase()

    let matchResult: { indices: number[]; score: number } | null = null

    if (hasSlashes) {
      // Try path segment matching first
      matchResult = matchPathSegments(filePath)
    }

    if (!matchResult) {
      // Try exact prefix of full path (highest priority)
      if (pathLower.startsWith(normalized)) {
        matchResult = {
          indices: createHighlightIndices(0, normalized.length),
          score: -1000 + filePath.length, // Very high priority
        }
      }
      // Try prefix of filename
      else if (fileNameLower.startsWith(normalized)) {
        const fileNameStart = filePath.lastIndexOf(fileName)
        matchResult = {
          indices: createHighlightIndices(fileNameStart, fileNameStart + normalized.length),
          score: -500 + filePath.length, // High priority
        }
      }
      // Try substring match in path
      else if (pathLower.includes(normalized)) {
        const idx = pathLower.indexOf(normalized)
        matchResult = {
          indices: createHighlightIndices(idx, idx + normalized.length),
          score: -100 + idx + filePath.length,
        }
      }
      // Try fuzzy match as fallback
      else {
        matchResult = fuzzyMatch(filePath, normalized)
      }
    }

    if (matchResult) {
      // Adjust score: prefer shorter paths
      const lengthPenalty = filePath.length * 2
      
      // Give bonus for exact directory matches (query matches the full path)
      // e.g. "cli" should prioritize "cli/" directory over "cli/package.json"
      const isExactMatch = pathLower === normalized
      const isExactDirMatch = isDirectory && isExactMatch
      const exactMatchBonus = isExactDirMatch ? -500 : 0
      
      // Only penalize directories when they're not an exact or prefix match
      // This ensures "cli/" appears before "cli/src/file.ts" when searching "cli"
      const isPrefixMatch = pathLower.startsWith(normalized)
      const dirPenalty = isDirectory && !isPrefixMatch ? 50 : 0
      
      const finalScore = matchResult.score + lengthPenalty + dirPenalty + exactMatchBonus

      pushUnique(matches, {
        filePath,
        isDirectory,
        pathHighlightIndices: matchResult.indices,
        matchScore: finalScore,
      })
    }
  }

  // Sort by score (lower is better)
  matches.sort((a, b) => (a.matchScore ?? 0) - (b.matchScore ?? 0))

  return matches.length > 100 ? matches.slice(0, 100) : matches
}

const filterAgentMatches = (
  agents: LocalAgentInfo[],
  query: string,
): MatchedAgentInfo[] => {
  if (!query) {
    return agents
  }

  const normalized = query.toLowerCase()
  const matches: MatchedAgentInfo[] = []
  const seen = new Set<string>()
  const pushUnique = createPushUnique<MatchedAgentInfo, string>(
    (agent) => agent.id,
    seen,
  )
  // Prefix of ID or name
  for (const agent of agents) {
    const id = agent.id.toLowerCase()

    if (id.startsWith(normalized)) {
      pushUnique(matches, {
        ...agent,
        idHighlightIndices: createHighlightIndices(0, normalized.length),
      })
      continue
    }

    const name = agent.displayName.toLowerCase()
    if (name.startsWith(normalized)) {
      pushUnique(matches, {
        ...agent,
        nameHighlightIndices: createHighlightIndices(0, normalized.length),
      })
    }
  }

  // Substring of ID or name
  for (const agent of agents) {
    if (seen.has(agent.id)) continue
    const id = agent.id.toLowerCase()
    const idFirstIndex = id.indexOf(normalized)
    if (idFirstIndex !== -1) {
      pushUnique(matches, {
        ...agent,
        idHighlightIndices: createHighlightIndices(
          idFirstIndex,
          idFirstIndex + normalized.length,
        ),
      })
      continue
    }

    const name = agent.displayName.toLowerCase()

    const nameFirstIndex = name.indexOf(normalized)
    if (nameFirstIndex !== -1) {
      pushUnique(matches, {
        ...agent,
        nameHighlightIndices: createHighlightIndices(
          nameFirstIndex,
          nameFirstIndex + normalized.length,
        ),
      })
      continue
    }
  }

  return matches
}

export interface SuggestionEngineResult {
  slashContext: TriggerContext
  mentionContext: TriggerContext
  slashMatches: MatchedSlashCommand[]
  agentMatches: MatchedAgentInfo[]
  fileMatches: MatchedFileInfo[]
  slashSuggestionItems: SuggestionItem[]
  agentSuggestionItems: SuggestionItem[]
  fileSuggestionItems: SuggestionItem[]
}

interface SuggestionEngineOptions {
  inputValue: string
  cursorPosition: number
  slashCommands: SlashCommand[]
  localAgents: LocalAgentInfo[]
  fileTree: FileTreeNode[]
  disableAgentSuggestions?: boolean
  currentAgentMode?: AgentMode
}

export const useSuggestionEngine = ({
  inputValue,
  cursorPosition,
  slashCommands,
  localAgents,
  fileTree,
  disableAgentSuggestions = false,
  currentAgentMode,
}: SuggestionEngineOptions): SuggestionEngineResult => {
  const slashCacheRef = useRef<Map<string, MatchedSlashCommand[]>>(
    new Map<string, SlashCommand[]>(),
  )
  const agentCacheRef = useRef<Map<string, MatchedAgentInfo[]>>(
    new Map<string, MatchedAgentInfo[]>(),
  )
  const fileCacheRef = useRef<Map<string, MatchedFileInfo[]>>(
    new Map<string, MatchedFileInfo[]>(),
  )
  const fileRefreshIdRef = useRef(0)
  const [filePaths, setFilePaths] = useState<PathInfo[]>(() =>
    flattenFileTree(fileTree),
  )

  useEffect(() => {
    slashCacheRef.current.clear()
  }, [slashCommands])

  useEffect(() => {
    agentCacheRef.current.clear()
  }, [localAgents])

  useEffect(() => {
    fileCacheRef.current.clear()
  }, [filePaths])

  useEffect(() => {
    setFilePaths(flattenFileTree(fileTree))
  }, [fileTree])

  // Keep the parsed query synchronized with the text that selection handlers
  // mutate. A deferred query can lag by one keystroke, causing Enter or Tab to
  // replace the wrong range in the current input.
  const slashContext = useMemo(
    () => parseSlashContext(inputValue),
    [inputValue],
  )

  // The cursor position must match the text being parsed. Using a deferred
  // input with the current cursor causes desync during heavy renders.
  const mentionContext = useMemo(
    () => parseMentionContext(inputValue, cursorPosition),
    [inputValue, cursorPosition],
  )

  useEffect(() => {
    if (!mentionContext.active) {
      return
    }

    const requestId = ++fileRefreshIdRef.current
    let cancelled = false

    const refreshFilePaths = async () => {
      try {
        const projectRoot = getProjectRoot()
        const freshTree = await getProjectFileTree({
          projectRoot,
          fs,
        })

        if (cancelled || fileRefreshIdRef.current !== requestId) {
          return
        }

        setFilePaths(flattenFileTree(freshTree))
      } catch (error) {
        logger.debug({ error }, 'Failed to refresh file suggestions from disk')
      }
    }

    void refreshFilePaths()

    return () => {
      cancelled = true
    }
  }, [mentionContext.active])

  const slashMatches = useMemo<MatchedSlashCommand[]>(() => {
    if (!slashContext.active) {
      return []
    }

    const key = slashContext.query.toLowerCase()
    const cached = slashCacheRef.current.get(key)
    if (cached) {
      return cached
    }

    const matched = filterSlashCommands(slashCommands, slashContext.query)
    slashCacheRef.current.set(key, matched)
    return matched
  }, [slashContext, slashCommands])

  const agentMatches = useMemo<MatchedAgentInfo[]>(() => {
    if (!mentionContext.active || disableAgentSuggestions) {
      return []
    }

    const key = mentionContext.query.toLowerCase()
    const cached = agentCacheRef.current.get(key)
    if (cached) {
      return cached
    }

    const computed = filterAgentMatches(localAgents, mentionContext.query)
    agentCacheRef.current.set(key, computed)
    return computed
  }, [mentionContext, localAgents, disableAgentSuggestions])

  const fileMatches = useMemo<MatchedFileInfo[]>(() => {
    if (!mentionContext.active) {
      return []
    }

    const key = mentionContext.query.toLowerCase()
    const cached = fileCacheRef.current.get(key)
    if (cached) {
      return cached
    }

    const computed = filterFileMatches(filePaths, mentionContext.query)
    fileCacheRef.current.set(key, computed)
    return computed
  }, [mentionContext, filePaths])

  const slashSuggestionItems = useMemo<SuggestionItem[]>(() => {
    return slashMatches.map((command) => {
      // Check if this is a mode command and if it's the current mode
      const modeMatch = command.id.match(/^mode:(default|max|plan)$/i)
      const isCurrentMode =
        modeMatch && currentAgentMode?.toLowerCase() === modeMatch[1]

      return {
        id: command.id,
        label: command.label,
        labelHighlightIndices: command.labelHighlightIndices,
        description: isCurrentMode
          ? `${command.description} (current)`
          : command.description,
        descriptionHighlightIndices: command.descriptionHighlightIndices,
      }
    })
  }, [slashMatches, currentAgentMode])

  const agentSuggestionItems = useMemo<SuggestionItem[]>(() => {
    return agentMatches.map((agent) => ({
      id: agent.id,
      label: agent.id,
      labelHighlightIndices: agent.idHighlightIndices,
      description: '',
      descriptionHighlightIndices: null,
    }))
  }, [agentMatches])

  const fileSuggestionItems = useMemo<SuggestionItem[]>(() => {
    return fileMatches.map((file) => {
      const fileName = getFileName(file.filePath)
      const isRootLevel = !file.filePath.includes('/')
      // Show directories with trailing / in the label
      const displayLabel = file.isDirectory ? `${fileName}/` : fileName
      const displayPath = file.isDirectory ? `${file.filePath}/` : file.filePath
      
      return {
        id: file.filePath,
        label: displayLabel,
        labelHighlightIndices: file.pathHighlightIndices
          ? file.pathHighlightIndices.map((idx) => {
              const fileNameStart = file.filePath.lastIndexOf(fileName)
              return idx >= fileNameStart ? idx - fileNameStart : -1
            }).filter((idx) => idx >= 0)
          : null,
        description: isRootLevel ? '.' : displayPath,
        descriptionHighlightIndices: isRootLevel ? null : file.pathHighlightIndices,
      }
    })
  }, [fileMatches])

  return {
    slashContext,
    mentionContext,
    slashMatches,
    agentMatches,
    fileMatches,
    slashSuggestionItems,
    agentSuggestionItems,
    fileSuggestionItems,
  }
}
