import * as fs from 'fs'
import * as path from 'path'

import { getLanguageConfig } from './languages'

import type { LanguageConfig } from './languages'
import type { Parser, Query } from 'web-tree-sitter'

export const DEBUG_PARSING = false
const IGNORE_TOKENS = ['__init__', '__post_init__', '__call__', 'constructor']
const MAX_CALLERS = 25
const DEFAULT_MAX_PARSE_FILES = 2_000
const DEFAULT_MAX_PARSE_FILE_BYTES = 300_000
const DEFAULT_MAX_TOTAL_PARSE_BYTES = 60_000_000

const MAX_PARSE_FILES = getPositiveIntegerEnv(
  'CODEBUFF_MAX_PARSE_FILES',
  DEFAULT_MAX_PARSE_FILES,
)
const MAX_PARSE_FILE_BYTES = getPositiveIntegerEnv(
  'CODEBUFF_MAX_PARSE_FILE_BYTES',
  DEFAULT_MAX_PARSE_FILE_BYTES,
)
const MAX_TOTAL_PARSE_BYTES = getPositiveIntegerEnv(
  'CODEBUFF_MAX_TOTAL_PARSE_BYTES',
  DEFAULT_MAX_TOTAL_PARSE_BYTES,
)

type ParseTokensOptions = {
  maxBytes?: number
  remainingBytes?: number
}

type ParsedTokens = {
  numLines: number
  identifiers: string[]
  calls: string[]
}

type ParsedTokensForScoring = ParsedTokens & {
  bytes: number
  skipped: boolean
}

type SourceReader = (filePath: string) => string | null | Promise<string | null>

type FileCallData = {
  calls: string[]
  scores: Record<string, number>
}

export interface TokenCallerMap {
  [filePath: string]: {
    [token: string]: string[] // Array of files that call this token
  }
}

export interface FileTokenData {
  tokenScores: { [filePath: string]: { [token: string]: number } }
  tokenCallers: TokenCallerMap
}

export async function getFileTokenScores(
  projectRoot: string,
  filePaths: string[],
  readFile?: SourceReader,
): Promise<FileTokenData> {
  const startTime = Date.now()
  const tokenScores: Record<string, Record<string, number>> = {}
  const externalCalls: Record<string, number> = {}
  const fileCallsMap = new Map<string, string[]>()
  let parsedFiles = 0
  let totalParsedBytes = 0

  for (const filePath of filePaths) {
    if (
      parsedFiles >= MAX_PARSE_FILES ||
      totalParsedBytes >= MAX_TOTAL_PARSE_BYTES
    ) {
      break
    }

    const fullPath = path.join(projectRoot, filePath)
    const languageConfig = await getLanguageConfig(fullPath)
    if (!languageConfig) continue

    const parsed = await parseTokensForScoring({
      filePath,
      fullPath,
      languageConfig,
      readFile,
      remainingBytes: MAX_TOTAL_PARSE_BYTES - totalParsedBytes,
    })
    if (parsed.skipped) continue

    parsedFiles++
    totalParsedBytes += parsed.bytes

    const { scores, calls } = scoreFileTokens(fullPath, parsed)
    tokenScores[filePath] = scores
    fileCallsMap.set(filePath, calls)

    for (const call of calls) {
      if (!scores[call]) {
        externalCalls[call] = (externalCalls[call] ?? 0) + 1
      }
    }
  }

  const tokenCallers = buildTokenCallers(tokenScores, fileCallsMap)
  boostScoresByExternalCalls(tokenScores, externalCalls)

  if (DEBUG_PARSING) {
    const endTime = Date.now()
    console.log(`Parsed ${filePaths.length} files in ${endTime - startTime}ms`)

    try {
      fs.writeFileSync(
        '../debug/debug-parse.json',
        JSON.stringify({
          tokenCallers,
          tokenScores,
          fileCallsMap,
          externalCalls,
        }),
      )
    } catch {
      // Silently ignore debug file write errors in test environments
    }
  }

  return { tokenScores, tokenCallers }
}

export function parseTokens(
  filePath: string,
  languageConfig: LanguageConfig,
  readFile?: (filePath: string) => string | null,
  options: ParseTokensOptions = {},
): ParsedTokens {
  const { numLines, identifiers, calls } = parseTokensWithLimits(
    filePath,
    languageConfig,
    readFile,
    options,
  )
  return { numLines, identifiers, calls }
}

async function parseTokensForScoring(params: {
  filePath: string
  fullPath: string
  languageConfig: LanguageConfig
  readFile?: SourceReader
  remainingBytes: number
}): Promise<ParsedTokensForScoring> {
  const { filePath, fullPath, languageConfig, readFile, remainingBytes } =
    params

  if (!readFile) {
    return parseTokensWithLimits(fullPath, languageConfig, undefined, {
      maxBytes: MAX_PARSE_FILE_BYTES,
      remainingBytes,
    })
  }

  try {
    const source = await readFile(filePath)
    return parseTokensWithLimits(filePath, languageConfig, () => source, {
      maxBytes: MAX_PARSE_FILE_BYTES,
      remainingBytes,
    })
  } catch (e) {
    if (DEBUG_PARSING) {
      console.error(`Error reading source: ${e}`)
      console.log(filePath)
    }
    return emptyParsedTokens(false)
  }
}

function parseTokensWithLimits(
  filePath: string,
  languageConfig: LanguageConfig,
  readFile: ((filePath: string) => string | null) | undefined,
  options: ParseTokensOptions,
): ParsedTokensForScoring {
  const { parser, query } = languageConfig

  try {
    const maxBytes = options.maxBytes ?? MAX_PARSE_FILE_BYTES
    const remainingBytes = options.remainingBytes ?? MAX_TOTAL_PARSE_BYTES
    if (remainingBytes <= 0) {
      return emptyParsedTokens(true)
    }

    const source = loadSourceWithinLimits({
      filePath,
      readFile,
      maxBytes,
      remainingBytes,
    })
    if (!source) {
      return emptyParsedTokens(true)
    }

    if (!parser || !query) {
      throw new Error('Parser or query not found')
    }

    const parseResults = parseFile(parser, query, source.code)
    const identifiers = Array.from(new Set(parseResults.identifier))
    const calls = Array.from(new Set(parseResults['call.identifier']))

    if (DEBUG_PARSING) {
      console.log(`\nParsing ${filePath}:`)
      console.log('Identifiers:', identifiers)
      console.log('Calls:', calls)
    }

    return {
      numLines: countLines(source.code),
      identifiers: identifiers ?? [],
      calls: calls ?? [],
      bytes: source.bytes,
      skipped: false,
    }
  } catch (e) {
    if (DEBUG_PARSING) {
      console.error(`Error parsing query: ${e}`)
      console.log(filePath)
    }
    return emptyParsedTokens(false)
  }
}

function loadSourceWithinLimits(params: {
  filePath: string
  readFile?: (filePath: string) => string | null
  maxBytes: number
  remainingBytes: number
}): { code: string; bytes: number } | null {
  const { filePath, readFile, maxBytes, remainingBytes } = params

  if (!readFile) {
    const bytes = fs.statSync(filePath).size
    if (bytes > maxBytes || bytes > remainingBytes) return null

    return {
      code: fs.readFileSync(filePath, 'utf8'),
      bytes,
    }
  }

  const code = readFile(filePath)
  if (code === null) return null

  const bytes = Buffer.byteLength(code, 'utf8')
  if (bytes > maxBytes || bytes > remainingBytes) return null

  return { code, bytes }
}

function scoreFileTokens(fullPath: string, parsed: ParsedTokens): FileCallData {
  const scores: Record<string, number> = {}
  const dirs = path.dirname(fullPath).split(path.sep)
  const depth = dirs.length
  const tokenBaseScore =
    0.8 ** depth * Math.sqrt(parsed.numLines / (parsed.identifiers.length + 1))

  for (const identifier of parsed.identifiers) {
    if (!IGNORE_TOKENS.includes(identifier)) {
      scores[identifier] = tokenBaseScore
    }
  }

  return { scores, calls: parsed.calls }
}

function buildTokenCallers(
  tokenScores: Record<string, Record<string, number>>,
  fileCallsMap: Map<string, string[]>,
): TokenCallerMap {
  const tokenDefinitionMap = new Map<string, string>()
  const highestScores = new Map<string, number>()

  for (const [filePath, scores] of Object.entries(tokenScores)) {
    for (const [token, score] of Object.entries(scores)) {
      const currentHighestScore = highestScores.get(token) ?? -Infinity
      if (score > currentHighestScore) {
        highestScores.set(token, score)
        tokenDefinitionMap.set(token, filePath)
      }
    }
  }

  const tokenCallers: TokenCallerMap = {}
  for (const [callingFile, calls] of fileCallsMap.entries()) {
    for (const call of calls) {
      const definingFile = tokenDefinitionMap.get(call)
      if (!definingFile || callingFile === definingFile || call in {}) {
        continue
      }

      const callersByToken = (tokenCallers[definingFile] ??= {})
      const callerFiles = (callersByToken[call] ??= [])
      if (
        callerFiles.length < MAX_CALLERS &&
        !callerFiles.includes(callingFile)
      ) {
        callerFiles.push(callingFile)
      }
    }
  }

  return tokenCallers
}

function boostScoresByExternalCalls(
  tokenScores: Record<string, Record<string, number>>,
  externalCalls: Record<string, number>,
): void {
  for (const scores of Object.values(tokenScores)) {
    for (const token of Object.keys(scores)) {
      const numCalls = externalCalls[token] ?? 0
      scores[token] *= 1 + Math.log(1 + numCalls)
      scores[token] = Math.round(scores[token] * 1000) / 1000
    }
  }
}

function emptyParsedTokens(skipped: boolean): ParsedTokensForScoring {
  return {
    numLines: 0,
    identifiers: [],
    calls: [],
    bytes: 0,
    skipped,
  }
}

function countLines(sourceCode: string): number {
  return (sourceCode.match(/\n/g)?.length ?? 0) + 1
}

function getPositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback

  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function parseFile(
  parser: Parser,
  query: Query,
  sourceCode: string,
): { [key: string]: string[] } {
  const tree = parser.parse(sourceCode)
  if (!tree) {
    return {}
  }
  try {
    const captures = query.captures(tree.rootNode)
    const result: { [key: string]: string[] } = {}

    for (const capture of captures) {
      const { name, node } = capture
      if (!result[name]) {
        result[name] = []
      }
      result[name].push(node.text)
    }

    return result
  } finally {
    ;(tree as { delete?: () => void }).delete?.()
  }
}
