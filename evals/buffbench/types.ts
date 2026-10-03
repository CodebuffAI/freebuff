import type { JudgingResult } from './judge'

export interface FileState {
  path: string
  preContent: string
  postContent: string
}

export interface EvalCommit {
  sha: string
  parentSha: string
  spec: string
  fileStates: FileState[]
}

export interface EvalData {
  repoUrl: string
  testRepoName?: string
  generationDate: string
  initCommand?: string
  evalCommits: EvalCommit[]
}

export interface FileDiff {
  path: string
  status: 'modified' | 'added' | 'deleted' | 'renamed'
  oldPath?: string
  diff: string
}

export interface EvalCommitV2 {
  id: string
  sha: string
  parentSha: string
  spec: string
  prompt: string
  supplementalFiles: string[]
  fileDiffs: FileDiff[]
}

export interface BinInstall {
  name: string
  installScript: string
  binPath: string
}

export interface EvalDataV2 {
  repoUrl: string
  testRepoName?: string
  generationDate: string
  initCommand?: string
  binInstalls?: BinInstall[]
  env?: Record<string, string>
  finalCheckCommands?: string[]
  evalCommits: EvalCommitV2[]
}

export interface FinalCheckOutput {
  command: string
  exitCode: number
  stdout: string
  stderr: string
}

export interface EvalRun {
  commitSha: string
  prompt: string
  diff: string
  judging: JudgingResult
  cost: number
  /** Whole task, clone and final checks included. */
  durationMs: number
  /** The agent's own run alone (see agent-runner.ts). */
  agentDurationMs?: number
  error?: string
  finalCheckOutputs?: FinalCheckOutput[]
}

export interface AgentEvalResults {
  agentId: string
  runs: EvalRun[]
  averageScore: number
  averageScoreExcludingFailures: number
  averageCost: number
  averageDuration: number
}
