import { execFileSync, spawnSync } from 'child_process'
import fs from 'fs'
import path from 'path'

import { API_KEY_ENV_VAR } from '@codebuff/common/old-constants'
import { getErrorObject } from '@codebuff/common/util/error'
import { getUserCredentials } from '@codebuff/sdk'
import { Freestyle } from 'freestyle'

import type {
  AgentTask,
  ExternalAgentType,
  runAgentOnCommit,
} from './agent-runner'
import type { EvalDataV2 } from './types'
import type { Vm } from 'freestyle'

/**
 * --freestyle: each agent-on-task runs in its own Freestyle VM. The VM gets
 * this checkout's bench code, runs the agent as a local run does
 * (freestyle-task.ts), writes the result and powers itself off. This machine
 * launches, polls and judges, so a laptop that sleeps delays a run without
 * tainting it. The eval files, which hold every answer, are never shipped.
 */

export const VM_BENCH_DIR = '/opt/buffbench'
const VM_RUN_DIR = '/opt/buffbench-run'
export const VM_INPUT_PATH = `${VM_RUN_DIR}/input.json`
export const VM_RESULT_PATH = `${VM_RUN_DIR}/result.json`
const VM_LOG_PATH = `${VM_RUN_DIR}/task.log`

export type FreestyleTaskInput = {
  agentId: string
  externalAgentType?: ExternalAgentType
  task: AgentTask
  repoUrl: string
  initCommand?: string
  env?: Record<string, string>
  binInstalls?: EvalDataV2['binInstalls']
  finalCheckCommands?: string[]
}

/** What the bench imports, plus every package.json so the VM's frozen
 *  install matches bun.lock. */
const BENCH_SOURCE_PATHS = [
  'package.json',
  'bun.lock',
  'bunfig.toml',
  'tsconfig.json',
  'tsconfig.base.json',
  'patches',
  'agents',
  'common',
  'evals',
  'packages/agent-runtime',
  'packages/code-map',
  'packages/llm-providers',
  'sdk',
]

/** The external CLI agents' keys; the VM gets these, the Codebuff key and
 *  the public NEXT_PUBLIC_* config, nothing else from this environment. */
const FORWARDED_ENV = [
  'CLAUDE_CODE_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'OPENCODE_API_KEY',
  'OPENCODE_MODEL',
]

export function createFreestyleSandbox() {
  const freestyle = new Freestyle()
  const apiKey = process.env[API_KEY_ENV_VAR] || getUserCredentials()?.authToken
  if (!apiKey) {
    throw new Error(`--freestyle needs ${API_KEY_ENV_VAR} or a CLI login.`)
  }
  const env: Record<string, string> = { [API_KEY_ENV_VAR]: apiKey }
  for (const [name, value] of Object.entries(process.env)) {
    if (
      value &&
      (name.startsWith('NEXT_PUBLIC_') || FORWARDED_ENV.includes(name))
    ) {
      env[name] = value
    }
  }
  const source = packBenchSource()

  return async (
    input: FreestyleTaskInput,
  ): Promise<Awaited<ReturnType<typeof runAgentOnCommit>>> => {
    const startTime = Date.now()
    let vm: Vm | undefined
    try {
      ;({ vm } = await freestyle.vms.create({
        snapshotId: 'freestyle/ubuntu',
        firewall: {
          rules: [
            { action: 'allow', source: {}, destination: { public: true } },
          ],
        },
        // The VM powers itself off when the task ends; a crash must leave it
        // off too rather than reboot it.
        automaticRestart: false,
        // Cost guards: pause a hung task, delete a VM nobody collected.
        maxRunSeconds: 2 * 60 * 60,
        ttlSeconds: 24 * 60 * 60,
        metadata: { purpose: 'buffbench' },
      }))
      console.log(`[${input.task.id}] ${input.agentId} is in VM ${vm.id}`)
      await startTask(vm, source, input, env)

      // The VM's state decides, not this machine's clock: a task that ended
      // while the laptop slept is simply collected on wake.
      let state: string | undefined
      for (let failures = 0; state !== 'stopped' && state !== 'paused'; ) {
        await new Promise((resolve) => setTimeout(resolve, 30_000))
        try {
          state = (await vm.data()).state
          failures = 0
        } catch (error) {
          if (++failures === 40) throw error
        }
      }
      if (!(await vm.fs.exists(VM_RESULT_PATH))) {
        const log = await vm.fs.readTextFile(VM_LOG_PATH).catch(() => '')
        throw new Error(
          `VM ${vm.id} ${state} without a result. Log:\n${log.slice(-8000)}`,
        )
      }
      return JSON.parse(await vm.fs.readTextFile(VM_RESULT_PATH))
    } catch (e) {
      return {
        diff: '',
        contextFiles: {},
        durationMs: Date.now() - startTime,
        cost: 0,
        error: `Freestyle: ${getErrorObject(e).message}`,
        trace: [],
      }
    } finally {
      await vm?.delete().catch(() => {})
    }
  }
}

/** The bench code as it is on disk: tracked files and new, unignored ones. */
function packBenchSource(): Buffer {
  const repoRoot = path.join(__dirname, '..', '..')
  const listFiles = (...args: string[]) =>
    execFileSync('git', ['ls-files', '-z', ...args], {
      cwd: repoRoot,
      encoding: 'utf-8',
    }).split('\0')
  const files = new Set([
    ...listFiles('-co', '--exclude-standard', '--', ...BENCH_SOURCE_PATHS),
    ...listFiles('--', '*package.json'),
  ])
  const shipped = [...files].filter(
    (file) =>
      file &&
      !/^evals\/buffbench\/eval-[^/]*\.json$/.test(file) &&
      fs.existsSync(path.join(repoRoot, file)),
  )
  const tar = spawnSync('tar', ['-czf', '-', '--null', '-T', '-'], {
    cwd: repoRoot,
    input: shipped.join('\0'),
    maxBuffer: 1024 * 1024 * 1024,
    // Otherwise macOS tar adds ._ resource-fork files.
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  })
  if (tar.status !== 0) throw new Error(tar.stderr.toString())
  return tar.stdout
}

async function startTask(
  vm: Vm,
  source: Buffer,
  input: FreestyleTaskInput,
  env: Record<string, string>,
) {
  const run = async (step: ReturnType<Vm['exec']>) => {
    const { statusCode, stdout, stderr } = await step
    if (statusCode !== 0) {
      throw new Error(`exit ${statusCode}: ${stdout}${stderr}`.slice(-4000))
    }
  }
  await vm.fs.writeFile('/tmp/buffbench.tgz', source)
  await run(
    vm
      .linuxUser('root')
      .exec(
        `mkdir -p ${VM_BENCH_DIR} ${VM_RUN_DIR} && chown ubuntu:ubuntu ${VM_BENCH_DIR} ${VM_RUN_DIR}`,
      ),
  )
  await run(
    vm.exec({
      // --warning: macOS tar's extended headers are noise to GNU tar.
      command: `tar --warning=no-unknown-keyword -xzf /tmp/buffbench.tgz -C ${VM_BENCH_DIR} && cd ${VM_BENCH_DIR} && bun install --frozen-lockfile --filter @codebuff/evals`,
      timeoutMs: 300_000,
    }),
  )
  await vm.fs.writeFile(VM_INPUT_PATH, JSON.stringify(input))
  // A transient unit outlives this call (exec caps at 5 minutes) and powers
  // the VM off however the task ends. --setenv=NAME reads the value from
  // this exec's environment, keeping secrets off the command line.
  await run(
    vm.linuxUser('root').exec({
      command: [
        'systemd-run --unit=buffbench --uid=ubuntu --gid=ubuntu',
        `--working-directory=${VM_BENCH_DIR} --setenv=HOME=/home/ubuntu`,
        ...Object.keys(env).map((name) => `--setenv=${name}`),
        `-p StandardOutput=append:${VM_LOG_PATH} -p StandardError=append:${VM_LOG_PATH}`,
        `-p 'ExecStopPost=+/usr/bin/systemctl poweroff --no-block'`,
        '/usr/local/bin/bun evals/buffbench/freestyle-task.ts',
      ].join(' '),
      env,
    }),
  )
}
