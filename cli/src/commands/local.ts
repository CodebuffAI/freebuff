import os from 'node:os'

import {
  LOCAL_MODEL_DISCLAIMER,
  LOCAL_RUNTIMES,
  discoverLocalModels,
  estimateLocalFit,
  localByokInput,
  type LocalRuntimeStatus,
} from '@codebuff/common/local-models'

import { startNewChat } from '../project-files'
import { stopActiveRun } from '../utils/active-run'
import {
  describeByokConnection,
  getCliByokStore,
  saveSelectedByokConnection,
} from '../utils/byok'
import { getSystemMessage } from '../utils/message-history'

import type { RouterParams } from './command-registry'

export const LOCAL_USAGE = [
  'Run the agent on a model served by this machine.',
  '',
  LOCAL_MODEL_DISCLAIMER,
  '',
  '**Detect a local runtime**',
  '`/local` or `/local detect` probes Ollama (11434), LM Studio (1234), llama.cpp (8080) and vLLM (8000) on loopback only.',
  '',
  '**Start a local run**',
  '`/local use ollama qwen2.5-coder:7b`',
  '`/local use <runtime> <model> [--context-window=N]`',
  '',
  'This saves an OpenAI-compatible BYOK connection pointed at 127.0.0.1 and selects it, so the same agent, tools and device control run without a Freebuff server in the inference path. `/byok off` returns to hosted models.',
].join('\n')

function post(params: RouterParams, message: string): void {
  params.setMessages((messages) => [...messages, getSystemMessage(message)])
  params.saveToHistory(params.inputValue.trim())
  params.setInputValue({ text: '', cursorPosition: 0, lastEditDueToNav: false })
}

function describeStatuses(statuses: LocalRuntimeStatus[]): string {
  const lines: string[] = []
  for (const status of statuses) {
    if (!status.reachable) {
      lines.push(`○ ${status.label} (${status.baseUrl}) — ${status.error ?? 'not reachable'}`)
      continue
    }
    const models = status.models.slice(0, 8).map((model) => `\`${model.id}\``)
    const more = status.models.length > models.length ? ` and ${status.models.length - models.length} more` : ''
    lines.push(
      `● ${status.label} (${status.baseUrl}) — ${status.models.length} model${
        status.models.length === 1 ? '' : 's'
      }${models.length ? `: ${models.join(', ')}${more}` : ''}`,
    )
  }
  return lines.join('\n')
}

function resetTranscriptForSourceChange(params: RouterParams): void {
  stopActiveRun('session-transition')
  params.setMessages(() => [])
  params.clearMessages()
  startNewChat()
}

export async function handleLocalCommand(
  params: RouterParams,
  rawArgs: string,
): Promise<void> {
  const tokens = rawArgs.trim().split(/\s+/).filter(Boolean)
  const action = tokens.shift()
  if (!action || action === 'help') {
    post(params, LOCAL_USAGE)
    return
  }

  if (action === 'detect' || action === 'models') {
    const statuses = await discoverLocalModels()
    const reachable = statuses.filter((status) => status.reachable)
    if (action === 'models' && tokens[0]) {
      const status = statuses.find((entry) => entry.id === tokens[0])
      if (!status) {
        post(params, `Unknown runtime ${tokens[0]}. Known: ${LOCAL_RUNTIMES.map((runtime) => runtime.id).join(', ')}.`)
        return
      }
      post(
        params,
        status.reachable
          ? status.models.length
            ? status.models
                .map(
                  (model) =>
                    `${model.id}${model.contextWindow ? `  ·  ${model.contextWindow} ctx` : ''}`,
                )
                .join('\n')
            : `${status.label} is running but serves no models. Load one in ${status.label} first.`
          : `${status.label} is not reachable (${status.error ?? 'not running'}).`,
      )
      return
    }
    post(
      params,
      reachable.length === 0
        ? `No local runtime answered on loopback.\n\n${describeStatuses(statuses)}\n\nStart one (for example \`ollama serve\`), then run \`/local\` again.`
        : `${describeStatuses(statuses)}\n\nStart a run with \`/local use <runtime> <model>\`. Local models are slower and weaker than the hosted ones; the tools are the same.`,
    )
    return
  }

  if (action === 'use') {
    const runtimeId = tokens.shift()
    const model = tokens.shift()
    let contextWindow: number | undefined
    for (const token of tokens) {
      const match = /^--context-window=(\d+)$/.exec(token)
      if (match) contextWindow = Number(match[1])
    }
    if (!runtimeId || !model) {
      post(params, `Usage: /local use <runtime> <model> [--context-window=N]\n\n${LOCAL_USAGE}`)
      return
    }
    const runtime = LOCAL_RUNTIMES.find((entry) => entry.id === runtimeId)
    if (!runtime) {
      post(params, `Unknown runtime ${runtimeId}. Known: ${LOCAL_RUNTIMES.map((entry) => entry.id).join(', ')}.`)
      return
    }

    const statuses = await discoverLocalModels({ runtimes: [runtime] })
    const status = statuses[0]!
    if (!status.reachable) {
      post(
        params,
        `${runtime.label} is not reachable at ${runtime.baseUrl} (${status.error ?? 'not running'}). Start it, then retry.`,
      )
      return
    }
    const modelInfo = status.models.find((entry) => entry.id === model)
    if (!modelInfo) {
      post(
        params,
        `Warning: \`${model}\` is not in ${runtime.label}'s model list${status.models.length ? ` (${status.models.slice(0, 8).map((entry) => entry.id).join(', ')})` : ''}. The run will probably fail; load the model first.`,
      )
    }

    const fit = estimateLocalFit({ model, totalMemoryBytes: os.totalmem() })
    const connection = await getCliByokStore().create(
      localByokInput({
        runtime,
        model,
        ...(modelInfo ? { modelInfo } : {}),
        ...(contextWindow === undefined ? {} : { modelInfo: { contextWindow } }),
      }),
    )
    const validation = await getCliByokStore().validate(connection)
    if (!validation.ok) {
      post(
        params,
        `Saved ${describeByokConnection(connection)}, but it could not be reached: ${validation.message}`,
      )
      return
    }
    saveSelectedByokConnection(connection)
    resetTranscriptForSourceChange(params)
    post(
      params,
      `Using ${describeByokConnection(connection)}.\n\n${LOCAL_MODEL_DISCLAIMER}${
        fit === 'too-large'
          ? `\n\nThis model likely does not fit in this machine's memory (${Math.round(os.totalmem() / 1024 ** 3)} GB total). Expect swapping or a failed load; try a smaller quantization.`
          : fit === 'tight'
            ? '\n\nThis model is close to the machine\'s memory limit; a smaller quantization will be faster.'
            : ''
      }`,
    )
    return
  }

  post(params, LOCAL_USAGE)
}
