import { execSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { API_KEY_ENV_VAR } from '@codebuff/common/old-constants'
import {
  CodebuffClient,
  getUserCredentials,
  loadLocalAgents,
} from '@codebuff/sdk'
import pLimit from 'p-limit'

import { runAgentOnCommit, type ExternalAgentType } from './agent-runner'
import { formatTaskResults } from './format-output'
import { createFreestyleSandbox } from './freestyle-sandbox'
import { judgeCommitResult } from './judge'
import { extractAgentLessons, saveAgentLessons } from './lessons-extractor'
import { analyzeAgentTraces, type AgentTraceData } from './trace-analyzer'
import { logger } from '../logger'
import { analyzeAllTasks } from './meta-analyzer'

import type { AgentEvalResults, EvalDataV2, EvalCommitV2 } from './types'

function parseAgentId(agent: string): {
  agentId: string
  externalAgentType?: ExternalAgentType
} {
  if (agent.startsWith('external:')) {
    const externalType = agent.slice('external:'.length) as ExternalAgentType
    if (
      externalType !== 'claude' &&
      externalType !== 'codex' &&
      externalType !== 'opencode'
    ) {
      throw new Error(
        `Unknown external agent type: ${externalType}. Supported: claude, codex, opencode`,
      )
    }
    return { agentId: agent, externalAgentType: externalType }
  }
  return { agentId: agent }
}

async function runTask(options: {
  client: CodebuffClient
  commit: EvalDataV2['evalCommits'][0]
  agents: string[]
  repoUrl: string
  initCommand?: string
  env?: Record<string, string>
  logsDir: string
  index: number
  totalTasks: number
  analyzerContext: {
    agentDefinitions: any[]
    agentTypeDefinition: string
    testedAgentIds: string[]
  }
  localAgentDefinitions: any[]
  extractLessons: boolean
  printEvents: boolean
  finalCheckCommands?: string[]
  disableAnalysis?: boolean
  saveTraces?: boolean
  /** Set with --freestyle: runs one agent on one task in its own VM. */
  runInFreestyle?: ReturnType<typeof createFreestyleSandbox>
  binInstalls?: EvalDataV2['binInstalls']
}) {
  const {
    client,
    commit,
    agents,
    repoUrl,
    initCommand,
    env,
    logsDir,
    index,
    totalTasks,
    analyzerContext,
    localAgentDefinitions,
    extractLessons,
    printEvents,
    finalCheckCommands,
    disableAnalysis,
    saveTraces = false,
    runInFreestyle,
    binInstalls,
  } = options

  console.log(
    `\n=== Task ${index + 1}/${totalTasks}: ${commit.id} (${commit.sha.slice(0, 7)}) ===`,
  )

  // Store trace data for this commit to analyze later
  const commitTraces: AgentTraceData[] = []

  const agentPromises = agents.map(async (agent) => {
    const { agentId, externalAgentType } = parseAgentId(agent)

    const agentResult = runInFreestyle
      ? await runInFreestyle({
          agentId,
          externalAgentType,
          // The task without its ground truth, which stays here for the judge.
          task: {
            id: commit.id,
            parentSha: commit.parentSha,
            prompt: commit.prompt,
            supplementalFiles: commit.supplementalFiles,
            fileDiffs: commit.fileDiffs.map(({ path, status }) => ({
              path,
              status,
            })),
          },
          repoUrl,
          initCommand,
          env,
          binInstalls,
          finalCheckCommands,
        })
      : await runAgentOnCommit({
          client,
          agentId,
          commit,
          repoUrl,
          initCommand,
          env,
          localAgentDefinitions,
          printEvents,
          finalCheckCommands,
          externalAgentType,
        })

    const judgeResult = await judgeCommitResult({
      client,
      commit,
      contextFiles: agentResult.contextFiles,
      agentDiff: agentResult.diff,
      error: agentResult.error,
      finalCheckOutputs: agentResult.finalCheckOutputs
        ? agentResult.finalCheckOutputs
            .map(
              (output) =>
                `### ${output.command}\n\`\`\`\n${output.stdout}${output.stderr ? '\nSTDERR:\n' + output.stderr : ''}\n\`\`\``,
            )
            .join('\n\n')
        : undefined,
    })

    // Extract and append agent lessons
    if (extractLessons) {
      console.log(`[${commit.id}] Extracting lessons for ${agentId}...`)
      const { lessons } = await extractAgentLessons({
        client,
        localAgentDefinitions,
        prompt: commit.prompt,
        groundTruthFileDiffs: commit.fileDiffs,
        contextFiles: agentResult.contextFiles,
        agentDiff: agentResult.diff,
        agentTrace: agentResult.trace,
        judgeResult,
        error: agentResult.error,
      })

      saveAgentLessons({
        agentId,
        commitId: commit.id,
        commitSha: commit.sha,
        prompt: commit.prompt,
        lessons,
        lessonsDir: path.join(__dirname, 'agent-lessons'),
      })
    }

    const evalRun = {
      commitSha: commit.sha,
      prompt: commit.prompt,
      diff: agentResult.diff,
      judging: judgeResult,
      cost: agentResult.cost,
      durationMs: agentResult.durationMs,
      agentDurationMs: agentResult.agentDurationMs,
      error: agentResult.error,
      finalCheckOutputs: agentResult.finalCheckOutputs,
    }

    // Save trace to logs directory
    const safeTaskId = commit.id.replace(/[^a-zA-Z0-9-]/g, '_')
    const safeAgentId = agentId.replace(/[^a-zA-Z0-9-]/g, '_')
    const safeCommitShort = commit.sha.slice(0, 7)
    const traceFilename = `${index + 1}-${safeTaskId}-${safeAgentId}-${safeCommitShort}.json`
    const tracePath = path.join(logsDir, traceFilename)

    // Store judging result and trace for combined output later
    commitTraces.push({
      agentId,
      commitSha: commit.sha,
      prompt: commit.prompt,
      trace: agentResult.trace,
      diff: agentResult.diff,
      judgeResult,
      cost: agentResult.cost,
      durationMs: agentResult.durationMs,
      agentDurationMs: agentResult.agentDurationMs,
      error: agentResult.error,
      timestamp: new Date().toISOString(),
      finalCheckOutputs: agentResult.finalCheckOutputs,
    })

    // Save judge traces to separate files if saveTraces is enabled
    if (saveTraces) {
      const tracesDir = path.join(logsDir, 'traces')
      if (!fs.existsSync(tracesDir)) {
        fs.mkdirSync(tracesDir, { recursive: true })
      }

      // Save agent trace only (not judge traces)
      const agentTracePath = path.join(
        tracesDir,
        `${index + 1}-${safeTaskId}-${safeAgentId}-${safeCommitShort}-agent.json`,
      )
      fs.writeFileSync(
        agentTracePath,
        JSON.stringify(agentResult.trace, null, 2),
      )
    }

    fs.writeFileSync(
      tracePath,
      JSON.stringify(commitTraces[commitTraces.length - 1], null, 2),
    )

    return { agentId, evalRun }
  })

  const agentResults = await Promise.all(agentPromises)

  // After all agents complete for this commit, run trace analysis
  const traceAnalysis = disableAnalysis
    ? undefined
    : await analyzeAgentTraces({
        client,
        traces: commitTraces,
        codingAgentPrompt: commit.prompt,
        analyzerContext,
      })

  const analysisData = {
    commitSha: commit.sha,
    timestamp: new Date().toISOString(),
    ...traceAnalysis,
    results: commitTraces.map((t) => ({
      agentId: t.agentId,
      ...t.judgeResult,
      cost: t.cost,
      durationMs: t.durationMs,
      agentDurationMs: t.agentDurationMs,
      error: t.error,
    })),
    prompt: commit.prompt,
  }

  // Save analysis to logs directory
  const safeTaskId = commit.id.replace(/[^a-zA-Z0-9-]/g, '_')
  const analysisCommitShort = commit.sha.slice(0, 7)
  const analysisFilename = `${index + 1}-${safeTaskId}-ANALYSIS-${analysisCommitShort}.json`
  const analysisPath = path.join(logsDir, analysisFilename)
  fs.writeFileSync(analysisPath, JSON.stringify(analysisData, null, 2))

  // Print all agent results with their judging, then trace analysis together
  console.log(
    formatTaskResults({
      commit,
      taskNumber: index + 1,
      totalTasks,
      agentResults: commitTraces.map((trace) => ({
        agentId: trace.agentId,
        judging: trace.judgeResult,
        cost: trace.cost,
        durationMs: trace.durationMs,
        error: trace.error,
        traceFilePath: path.join(
          logsDir,
          `${index + 1}-${commit.id.replace(/[^a-zA-Z0-9-]/g, '_')}-${trace.agentId.replace(/[^a-zA-Z0-9-]/g, '_')}-${commit.sha.slice(0, 7)}.json`,
        ),
      })),
      traceAnalysis,
    }),
  )

  return { commit, agentResults, commitTraces }
}

/**
 * Install binaries specified in binInstalls config to a temporary directory
 * Returns the temporary directory path and updated env with PATH
 */
export function installBinaries(binInstalls: EvalDataV2['binInstalls']): {
  tempDir: string | null
  env: Record<string, string>
} {
  if (!binInstalls || binInstalls.length === 0) {
    return { tempDir: null, env: {} }
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebuff-bins-'))

  const binPaths: string[] = []

  for (const bin of binInstalls) {
    try {
      execSync(bin.installScript, {
        cwd: tempDir,
        stdio: 'ignore',
        env: { ...process.env, INSTALL_DIR: tempDir },
      })

      const fullBinPath = path.join(tempDir, bin.binPath)
      if (fs.existsSync(fullBinPath)) {
        binPaths.push(path.dirname(fullBinPath))
        console.log(`✓ ${bin.name} installed at ${fullBinPath}`)
      } else {
        console.warn(
          `Warning: Expected binary not found at ${fullBinPath} after installing ${bin.name}`,
        )
      }
    } catch (error) {
      console.error(`Error installing ${bin.name}:`, error)
      throw error
    }
  }

  // Prepend all bin paths to PATH
  const updatedPath = [...binPaths, process.env.PATH].filter(Boolean).join(':')

  return {
    tempDir,
    env: { PATH: updatedPath },
  }
}

interface CommitWithSource {
  commit: EvalCommitV2
  evalData: EvalDataV2
  evalDataPath: string
}

export async function runBuffBench(options: {
  evalDataPaths: string[]
  agents: string[]
  taskConcurrency?: number
  client?: CodebuffClient
  taskIds?: string[]
  extractLessons?: boolean
  disableAnalysis?: boolean
  saveTraces?: boolean
  /** 'freestyle' (recommended, --freestyle) runs every agent-on-task in its
   *  own Freestyle VM, so a sleeping laptop cannot taint the run. */
  sandbox?: 'local' | 'freestyle'
}) {
  const {
    evalDataPaths,
    agents,
    taskConcurrency = 1,
    taskIds,
    extractLessons = false,
    disableAnalysis = false,
    saveTraces = false,
    sandbox = 'local',
  } = options

  if (evalDataPaths.length === 0) {
    throw new Error('At least one eval data path is required')
  }

  // Load all eval files and create a mapping of commits to their source eval data
  const allCommitsWithSource: CommitWithSource[] = []
  const loadedEvalFiles: { path: string; data: EvalDataV2 }[] = []

  for (const evalDataPath of evalDataPaths) {
    const evalData: EvalDataV2 = JSON.parse(
      fs.readFileSync(evalDataPath, 'utf-8'),
    )
    loadedEvalFiles.push({ path: evalDataPath, data: evalData })

    for (const commit of evalData.evalCommits) {
      allCommitsWithSource.push({
        commit,
        evalData,
        evalDataPath,
      })
    }
  }

  console.log(
    `Loaded ${loadedEvalFiles.length} eval file(s) with ${allCommitsWithSource.length} total tasks`,
  )
  for (const { path: p, data } of loadedEvalFiles) {
    console.log(`  - ${path.basename(p)}: ${data.evalCommits.length} tasks`)
  }

  // Collect all unique binInstalls from all eval files
  const allBinInstalls = loadedEvalFiles.flatMap(
    (f) => f.data.binInstalls ?? [],
  )
  const uniqueBinInstalls = allBinInstalls.filter(
    (bin, index, self) => index === self.findIndex((b) => b.name === bin.name),
  )

  // Install binaries once at the beginning; a Freestyle VM installs its own.
  const runInFreestyle =
    sandbox === 'freestyle' ? createFreestyleSandbox() : undefined
  if (!runInFreestyle) {
    console.log('Recommended: --freestyle runs each task in its own VM.')
  }
  const { tempDir: binsTempDir, env: binsEnv } = installBinaries(
    runInFreestyle ? [] : uniqueBinInstalls,
  )

  let commitsToRun: CommitWithSource[]
  if (taskIds && taskIds.length > 0) {
    const foundCommits: CommitWithSource[] = []
    const notFoundIds: string[] = []

    for (const taskId of taskIds) {
      const found = allCommitsWithSource.find((c) => c.commit.id === taskId)
      if (found) {
        foundCommits.push(found)
      } else {
        notFoundIds.push(taskId)
      }
    }

    if (notFoundIds.length > 0) {
      const availableIds = allCommitsWithSource
        .map((c) => c.commit.id)
        .join(', ')
      throw new Error(
        `Task ID(s) not found: ${notFoundIds.join(', ')}. Available task IDs: ${availableIds}`,
      )
    }

    commitsToRun = foundCommits
    console.log(`Running ${foundCommits.length} task(s): ${taskIds.join(', ')}`)
  } else {
    commitsToRun = allCommitsWithSource
  }

  const client =
    options.client ??
    new CodebuffClient({
      logger,
      apiKey: process.env[API_KEY_ENV_VAR] || getUserCredentials()?.authToken,
    })

  // Load local agent definitions and type definition file for analyzers
  const agentsPath = path.join(__dirname, '../../agents')
  const loadedAgents = await loadLocalAgents({ agentsPath })
  const agentTypeDefinitionPath = path.join(
    agentsPath,
    'types',
    'agent-definition.ts',
  )
  const agentTypeDefinition = fs.existsSync(agentTypeDefinitionPath)
    ? fs.readFileSync(agentTypeDefinitionPath, 'utf-8')
    : ''

  const analyzerContext = {
    agentDefinitions: Object.values(loadedAgents),
    agentTypeDefinition,
    testedAgentIds: agents,
  }

  const startTime = Date.now()
  const results: Record<string, AgentEvalResults> = {}

  // Create logs directory with current date and time and agent IDs
  const date = new Date().toISOString().replace(/:/g, '-').slice(0, 16) // YYYY-MM-DDTHH-MM
  const agentNames = agents
    .map((id) => id.replace(/[^a-zA-Z0-9-]/g, '_'))
    .join('_vs_')
  const logsDir = path.join(__dirname, 'logs', `${date}_${agentNames}`)
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true })
  }

  for (const agentId of agents) {
    results[agentId] = {
      agentId,
      runs: [],
      averageScore: 0,
      averageScoreExcludingFailures: 0,
      averageCost: 0,
      averageDuration: 0,
    }
  }

  const commitLimit = pLimit(taskConcurrency)

  const commitPromises = commitsToRun.map(({ commit, evalData }, index) => {
    // Merge binaries env with this eval's env
    const mergedEnv = { ...binsEnv, ...evalData.env }

    return commitLimit(() =>
      runTask({
        client,
        commit,
        agents,
        repoUrl: evalData.repoUrl,
        initCommand: evalData.initCommand,
        env: mergedEnv,
        logsDir,
        index,
        totalTasks: commitsToRun.length,
        analyzerContext,
        localAgentDefinitions: analyzerContext.agentDefinitions,
        extractLessons,
        printEvents: agents.length === 1 && taskConcurrency === 1,
        finalCheckCommands: evalData.finalCheckCommands,
        disableAnalysis,
        saveTraces,
        runInFreestyle,
        binInstalls: uniqueBinInstalls,
      }),
    )
  })

  const commitResults = await Promise.allSettled(commitPromises)

  // Track which commits had any agent errors
  const commitShasWithErrors = new Set<string>()

  for (const result of commitResults) {
    if (result.status === 'fulfilled') {
      const { commit, agentResults } = result.value

      // Check if any agent had an error for this commit
      const hasAnyError = agentResults.some(({ evalRun }) => evalRun.error)
      if (hasAnyError) {
        commitShasWithErrors.add(commit.sha)
      }

      for (const { agentId, evalRun } of agentResults) {
        results[agentId].runs.push(evalRun)
      }
    } else {
      console.error('Commit processing failed:', result.reason)
    }
  }

  for (const agentData of Object.values(results)) {
    // Filter out runs from commits where ANY agent had an error
    const validRuns = agentData.runs.filter(
      (r) => !commitShasWithErrors.has(r.commitSha),
    )

    agentData.averageScore =
      validRuns.length > 0
        ? validRuns.reduce((sum, r) => sum + r.judging.overallScore, 0) /
          validRuns.length
        : 0

    // Calculate average excluding huge failures (scores ≤1.0)
    const runsExcludingFailures = validRuns.filter(
      (r) => r.judging.overallScore > 1.0,
    )
    agentData.averageScoreExcludingFailures =
      runsExcludingFailures.length > 0
        ? runsExcludingFailures.reduce(
            (sum, r) => sum + r.judging.overallScore,
            0,
          ) / runsExcludingFailures.length
        : 0

    agentData.averageCost =
      validRuns.length > 0
        ? validRuns.reduce((sum, r) => sum + r.cost, 0) / validRuns.length
        : 0

    agentData.averageDuration =
      validRuns.length > 0
        ? validRuns.reduce((sum, r) => sum + r.durationMs, 0) / validRuns.length
        : 0
  }

  const logFiles = fs.readdirSync(logsDir)

  const metaAnalysis = disableAnalysis
    ? undefined
    : await analyzeAllTasks({
        client,
        logsDir,
        agents,
        analyzerContext,
      })

  if (metaAnalysis) {
    // Print meta-analysis results
    console.log('\n=== Meta-Analysis Results ===')
    console.log('\nOverall Comparison:')
    console.log(metaAnalysis.overallComparison)

    if (metaAnalysis.agentInsights.length > 0) {
      console.log('\nAgent-Specific Insights:')
      for (const insight of metaAnalysis.agentInsights) {
        console.log(`\n[${insight.agentId}]`)
        if (insight.consistentStrengths.length > 0) {
          console.log('  Strengths:', insight.consistentStrengths.join(', '))
        }
        if (insight.consistentWeaknesses.length > 0) {
          console.log('  Weaknesses:', insight.consistentWeaknesses.join(', '))
        }
      }
    }

    if (metaAnalysis.keyFindings.length > 0) {
      console.log('\nKey Findings:')
      metaAnalysis.keyFindings.forEach((finding, i) => {
        console.log(`  ${i + 1}. ${finding}`)
      })
    }
  }

  const finalResults = {
    metadata: {
      timestamp: new Date().toISOString(),
      evalDataPaths,
      agentsTested: agents,
      commitsEvaluated: commitsToRun.length,
      totalCommitsInEval: allCommitsWithSource.length,
      evalFiles: loadedEvalFiles.map((f) => ({
        path: f.path,
        repoUrl: f.data.repoUrl,
        taskCount: f.data.evalCommits.length,
      })),
      totalDuration: Date.now() - startTime,
      logsDirectory: logsDir,
      files: logFiles,
    },
    metaAnalysis,
    ...results,
  }

  const finalResultsPath = path.join(logsDir, 'FINAL_RESULTS.json')
  fs.writeFileSync(finalResultsPath, JSON.stringify(finalResults, null, 2))

  // Cleanup binaries installation
  if (binsTempDir) {
    try {
      fs.rmSync(binsTempDir, { recursive: true, force: true })
      console.log(`✓ Cleaned up binaries installation at ${binsTempDir}.`)
    } catch (error) {
      console.warn(`Warning: Failed to cleanup binaries directory:`, error)
    }
  }

  console.log(`Traces saved to ${logsDir}`)
  if (commitShasWithErrors.size > 0) {
    console.log(
      `\nNote: ${commitShasWithErrors.size} commit(s) had agent errors and were excluded from averages`,
    )
  }
  console.log('\n=== Summary ===')
  for (const [agentId, data] of Object.entries(results)) {
    const validRuns = data.runs.filter(
      (r) => !commitShasWithErrors.has(r.commitSha),
    )
    const runsExcludingFailures = validRuns.filter(
      (r) => r.judging.overallScore > 1.0,
    )
    console.log(`\n${agentId}:`)
    console.log(`  Average Score: ${data.averageScore.toFixed(2)}/10`)
    console.log(
      `  Average Score (excluding failures ≤1.0): ${data.averageScoreExcludingFailures.toFixed(2)}/10 (${runsExcludingFailures.length}/${validRuns.length} runs)`,
    )
    console.log(`  Average Cost: ${data.averageCost.toFixed(4)}`)
    console.log(
      `  Average Duration: ${(data.averageDuration / 1000).toFixed(1)}s`,
    )
    console.log(
      `  Valid runs: ${validRuns.length}/${data.runs.length} (excluding ${commitShasWithErrors.size} commit(s) with errors)`,
    )
  }

  // Print all overall scores for distribution analysis
  console.log('\n=== Score Distribution ===')
  for (const [agentId, data] of Object.entries(results)) {
    const validRuns = data.runs.filter(
      (r) => !commitShasWithErrors.has(r.commitSha),
    )
    const scores = validRuns.map((r) => r.judging.overallScore.toFixed(1))
    console.log(`\n${agentId}:`)
    console.log(`  Scores: ${scores.join(', ')}`)
  }

  return finalResults
}
