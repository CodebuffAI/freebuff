import {
  printFileTree,
  printFileTreeWithTokens,
} from '@codebuff/common/util/file'
import { sampleSizeWithSeed } from '@codebuff/common/util/random'

import { countTokens } from '../util/token-counter'

import type { Logger } from '@codebuff/common/types/contracts/logger'
import type {
  FileTreeNode,
  ProjectFileContext,
} from '@codebuff/common/util/file'

type TruncationLevel = 'none' | 'unimportant-files' | 'tokens' | 'depth-based'
const DEBUG = false

export const truncateFileTreeBasedOnTokenBudget = (params: {
  fileContext: ProjectFileContext
  tokenBudget: number
  logger: Logger
}): {
  printedTree: string
  tokenCount: number
  truncationLevel: TruncationLevel
} => {
  const { fileContext, tokenBudget, logger } = params
  const startTime = performance.now()
  const { fileTree, fileTokenScores } = fileContext

  // NOTE: We are always filtering out files with "unimportant" extensions.
  const filteredTree = removeUnimportantFiles(fileTree)

  const treeWithTokens = printFileTreeWithTokens(filteredTree, fileTokenScores)
  const treeWithTokensCount = countTokens(treeWithTokens)

  if (treeWithTokensCount <= tokenBudget) {
    return {
      printedTree: treeWithTokens,
      tokenCount: treeWithTokensCount,
      truncationLevel: 'none',
    }
  }

  const printedFilteredTree = printFileTree(filteredTree)
  const filteredTreeNoTokensCount = countTokens(printedFilteredTree)

  if (filteredTreeNoTokensCount <= tokenBudget) {
    const filteredTreeWithTokens = printFileTreeWithTokens(
      filteredTree,
      fileTokenScores,
    )
    const filteredTreeWithTokensCount = countTokens(filteredTreeWithTokens)
    if (filteredTreeWithTokensCount <= tokenBudget) {
      if (DEBUG) {
        logger.debug(
          {
            tokenBudget,
            filteredTreeWithTokensCount,
            duration: performance.now() - startTime,
          },
          'truncateFileTreeBasedOnTokenBudget unimportant-files',
        )
      }
      return {
        printedTree: filteredTreeWithTokens,
        tokenCount: filteredTreeWithTokensCount,
        truncationLevel: 'unimportant-files',
      }
    }
    const { printedTree, tokenCount } = pruneFileTokenScores({
      fileTree: filteredTree,
      fileTokenScores,
      tokenBudget,
      logger,
    })

    if (tokenCount <= tokenBudget) {
      if (DEBUG) {
        logger.debug(
          { tokenBudget, tokenCount, duration: performance.now() - startTime },
          'truncateFileTreeBasedOnTokenBudget tokens',
        )
      }
      return {
        printedTree,
        tokenCount,
        truncationLevel: 'tokens',
      }
    }
  }

  const start = performance.now()

  // Get all files with their depths
  const getFilesWithDepths = (
    nodes: FileTreeNode[],
    parentDepth = 0,
  ): Array<{ node: FileTreeNode; path: string; depth: number }> => {
    return nodes.flatMap((node) => {
      if (node.type === 'file') {
        return [{ node, path: node.filePath, depth: parentDepth }]
      }
      return (
        node.children?.flatMap((child) =>
          getFilesWithDepths([child], parentDepth + 1),
        ) ?? []
      )
    })
  }

  // Get initial state
  let currentTree = filteredTree
  let currentTokenCount = filteredTreeNoTokensCount
  let currentPrintedTree = ''

  // Get all files sorted by depth
  const allFiles = getFilesWithDepths(currentTree)
  const sortedFiles = allFiles.sort((a, b) => b.depth - a.depth)

  // Sample 30 random files and count their tokens together
  const sampleCount = Math.min(30, sortedFiles.length)
  const sampleSeed = `${sortedFiles.length}:${sampleCount}:${sortedFiles[0]?.path ?? ''}:${sortedFiles[sortedFiles.length - 1]?.path ?? ''}`
  const sampleFiles = sampleSizeWithSeed(sortedFiles, sampleCount, sampleSeed)
  const sampleText = sampleFiles.map((f) => f.node.name).join(' ')
  const sampleTokens = countTokens(sampleText)

  // Calculate average tokens per file from sample
  const avgTokensPerFileName = sampleTokens / sampleCount

  const tokensToRemove = currentTokenCount - tokenBudget
  // Calculate how many files to remove to hit token budget
  // Remove half to account for other tokens like directories that will also be removed.
  let estimatedFilesToRemove =
    Math.ceil((0.5 * tokensToRemove) / avgTokensPerFileName) + 100

  let iterationCount = 0
  const MAX_ITERATIONS = 10
  let previousTokenCount = Infinity

  while (estimatedFilesToRemove > 0 && iterationCount < MAX_ITERATIONS) {
    // Build a set of files to remove, taking deepest ones first
    const filesToRemove = new Set(
      sortedFiles
        .slice(0, Math.min(estimatedFilesToRemove, sortedFiles.length))
        .map((f) => f.path),
    )
    sortedFiles.splice(0, estimatedFilesToRemove)

    // Helper to filter out removed files
    const filterRemovedFiles = (node: FileTreeNode): FileTreeNode | null => {
      if (node.type === 'file') {
        return filesToRemove.has(node.filePath) ? null : node
      }

      const newChildren = node.children
        ?.map(filterRemovedFiles)
        .filter((n): n is FileTreeNode => n !== null)

      return newChildren?.length ? { ...node, children: newChildren } : null
    }

    currentTree = currentTree
      .map(filterRemovedFiles)
      .filter((n): n is FileTreeNode => n !== null)

    currentPrintedTree = printFileTree(currentTree)
    currentTokenCount = countTokens(currentPrintedTree)

    // Safety check - if we're not making progress, break
    if (currentTokenCount >= previousTokenCount) {
      logger.warn(
        { currentTokenCount, previousTokenCount, iterationCount },
        'No progress in reducing tokens, breaking loop',
      )
      break
    }
    previousTokenCount = currentTokenCount

    const tokensToRemove = currentTokenCount - tokenBudget
    estimatedFilesToRemove =
      tokensToRemove > 0
        ? Math.ceil((0.5 * tokensToRemove) / avgTokensPerFileName) + 100
        : 0

    iterationCount++
  }

  if (iterationCount >= MAX_ITERATIONS) {
    logger.warn(
      { iterationCount, currentTokenCount, tokenBudget },
      'Hit max iterations while truncating file tree',
    )
  }

  const end = performance.now()
  if (end - start > 100) {
    logger.debug(
      { durationMs: end - start, tokenCount: currentTokenCount },
      'fileNameTruncation took a while',
    )
  }
  if (DEBUG) {
    logger.debug(
      {
        tokenBudget,
        tokenCount: currentTokenCount,
        duration: performance.now() - startTime,
      },
      'truncateFileTreeBasedOnTokenBudget depth-based',
    )
  }
  return {
    printedTree: currentPrintedTree,
    tokenCount: currentTokenCount,
    truncationLevel: 'depth-based',
  }
}

function pruneFileTokenScores(params: {
  fileTree: FileTreeNode[]
  fileTokenScores: Record<string, Record<string, number>>
  tokenBudget: number
  logger: Logger
}) {
  const { fileTree, fileTokenScores, tokenBudget, logger } = params
  const startTime = performance.now()

  // Create sorted array of tokens by score
  const sortedTokens = Object.entries(fileTokenScores)
    .flatMap(([filePath, tokens]) =>
      Object.entries(tokens).map(([token, score]) => ({
        filePath,
        token,
        score,
      })),
    )
    .sort((a, b) => a.score - b.score)

  let printedTree = printFileTreeWithTokens(fileTree, fileTokenScores)
  let totalTokens = countTokens(printedTree)

  if (totalTokens <= tokenBudget) {
    return { pruned: fileTokenScores, printedTree, tokenCount: totalTokens }
  }

  // Quick estimate - assume each token name takes 5 tokens
  const tokensToRemove = totalTokens - tokenBudget
  const initialKeepIndex = Math.max(0, Math.ceil(tokensToRemove / 5))

  // Build initial pruned object from higher-scoring tokens
  let pruned: Record<string, Record<string, number>> = {}
  for (let i = initialKeepIndex; i < sortedTokens.length; i++) {
    const { filePath, token, score } = sortedTokens[i]
    if (!pruned[filePath]) {
      pruned[filePath] = {}
    }
    pruned[filePath][token] = score
  }

  let index = initialKeepIndex
  printedTree = printFileTreeWithTokens(fileTree, pruned)
  totalTokens = countTokens(printedTree)

  while (totalTokens > tokenBudget && index < sortedTokens.length) {
    const remainingToRemove = totalTokens - tokenBudget
    const batchSize = Math.ceil(remainingToRemove / 5) + 500

    // Remove batch of tokens from pruned object
    for (let i = index; i < index + batchSize && i < sortedTokens.length; i++) {
      const { filePath, token } = sortedTokens[i]
      if (pruned[filePath]?.[token] !== undefined) {
        delete pruned[filePath][token]
        if (Object.keys(pruned[filePath]).length === 0) {
          delete pruned[filePath]
        }
      }
    }

    // Note: The below function can take a while, so we optimized to have few loop iterations.
    printedTree = printFileTreeWithTokens(fileTree, pruned)
    totalTokens = countTokens(printedTree)
    index += batchSize
  }

  const endTime = performance.now()
  if (endTime - startTime > 100) {
    logger.debug(
      {
        tokenBudget,
        durationMs: endTime - startTime,
        finalTokenCount: totalTokens,
        remainingTokenEntries: Object.values(pruned).reduce(
          (sum, tokens) => sum + Object.keys(tokens).length,
          0,
        ),
      },
      'pruneFileTokenScores took a while',
    )
  }
  return { pruned, printedTree, tokenCount: totalTokens }
}

const removeUnimportantFiles = (fileTree: FileTreeNode[]): FileTreeNode[] => {
  const shouldKeepFile = (node: FileTreeNode): boolean => {
    if (node.type === 'directory') {
      // Filter out common build/cache directories
      const dirPath = node.filePath.toLowerCase()
      const isUnimportantDir = UNIMPORTANT_DIR_PATTERNS.some((dir) =>
        dirPath.includes(dir),
      )
      if (isUnimportantDir) {
        return false
      }
      // Keep directory if it has any important children
      const filteredChildren = node.children?.filter(shouldKeepFile) ?? []
      node.children = filteredChildren
      return filteredChildren.length > 0
    }

    const filePath = node.filePath.toLowerCase()
    return !UNIMPORTANT_EXTENSIONS.some((ext) => filePath.endsWith(ext))
  }

  return fileTree.filter(shouldKeepFile)
}

const UNIMPORTANT_DIR_PATTERNS = [
  // Build output directories
  '/dist/',
  '/build/',
  '/out/',
  '/target/',

  // Package manager directories
  '/node_modules/',
  '/.venv/',
  '/vendor/',
] as const

const UNIMPORTANT_EXTENSIONS = [
  // Generated JavaScript/TypeScript files
  '.min.js',
  '.min.css',
  '.map',
  '.d.ts',

  // Python generated/cache files
  '.pyc',
  '.pyo',
  '__pycache__',
  '.pyd',
  '.so',
  '.egg-info',
  '.whl',

  // Java/Kotlin compiled files
  '.class',
  '.jar',
  '.war',

  // Ruby generated files
  '.gem',
  '.rbc',

  // Logs and temporary files
  '.log',
  '.tmp',
  '.temp',
  '.swp',
  '.bak',
  '.cache',

  // Documentation generated files
  '.docx',
  '.pdf',
  '.chm',

  // Compressed files
  '.zip',
  '.tar',
  '.gz',
  '.rar',
  '.7z',
  '.iso',
  '.dmg',
  '.pkg',
  '.deb',
  '.rpm',
  '.exe',
  '.dll',
  '.lib',
  '.so',

  // Media and binary files
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.ico',
  '.svg',
  '.mp3',
  '.mp4',
  '.mov',
  '.avi',
  '.bmp',
  '.tiff',
  '.tif',
  '.webp',
] as const
