import { z } from 'zod/v4'
import { labSelectionSchema } from './agentic-ad-lab'

/**
 * Agentic Ads Lab batch mode (COD-833): run one procedure N times on each of a
 * set of lab repositories, grade every run with the production grader, and
 * report its perfect rate before the campaign gets traffic.
 *
 * An environment case prepares the chat's VM account before the accepted run's
 * agent starts. Each chat has its own Linux user and HOME, so a case changes
 * only that chat. Toolchains go under `~/.cache`, which Cloud checkpoints
 * exclude.
 */

const LAB = '$HOME/.cache/freebuff-lab'
const RC_MARK = '# freebuff-lab toolchain'

/**
 * Shadow the VM's own Node binaries for this chat only. `~/.local/bin` is first
 * on every Cloud chat shell's PATH; a manager activated the usual way prepends
 * its own bin directory and so still wins.
 */
const HIDE_SYSTEM_NODE = `mkdir -p "$HOME/.local/bin"
for tool in node npm npx corepack; do
  printf '#!/bin/sh\\necho "sh: 1: %s: not found" >&2\\nexit 127\\n' "$tool" > "$HOME/.local/bin/$tool"
  chmod 755 "$HOME/.local/bin/$tool"
done`

/** Appends the activation a developer keeps in their shell profile, once. */
const profile = (
  lines: string,
) => `for rc in "$HOME/.bashrc" "$HOME/.profile"; do
  grep -qF '${RC_MARK}' "$rc" 2>/dev/null || printf '%s\\n' '${RC_MARK}' ${lines
    .split('\n')
    .map((line) => `'${line}'`)
    .join(' ')} >> "$rc"
done`

const NVM = `set -eu
export NVM_DIR="${LAB}/nvm"
mkdir -p "$NVM_DIR"
if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | PROFILE=/dev/null bash >/dev/null 2>&1
fi
set +u
. "$NVM_DIR/nvm.sh"
nvm install 22 >/dev/null 2>&1
nvm alias default 22 >/dev/null
set -u
${profile(`export NVM_DIR="$HOME/.cache/freebuff-lab/nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"`)}
${HIDE_SYSTEM_NODE}`

const MISE = `set -eu
export MISE_DATA_DIR="${LAB}/mise"
MISE="$MISE_DATA_DIR/bin/mise"
if [ ! -x "$MISE" ]; then
  curl -fsSL https://mise.run | MISE_INSTALL_PATH="$MISE" sh >/dev/null 2>&1
fi
"$MISE" use --global node@22 >/dev/null 2>&1
${profile(`export MISE_DATA_DIR="$HOME/.cache/freebuff-lab/mise"
eval "$("$MISE_DATA_DIR/bin/mise" activate bash)"`)}
${HIDE_SYSTEM_NODE}`

const VOLTA = `set -eu
export VOLTA_HOME="${LAB}/volta"
if [ ! -x "$VOLTA_HOME/bin/volta" ]; then
  curl -fsSL https://get.volta.sh | bash -s -- --skip-setup >/dev/null 2>&1
fi
"$VOLTA_HOME/bin/volta" install node@22 >/dev/null 2>&1
${profile(`export VOLTA_HOME="$HOME/.cache/freebuff-lab/volta"
export PATH="$VOLTA_HOME/bin:$PATH"`)}
${HIDE_SYSTEM_NODE}`

/**
 * A second thread editing package.json while the sponsored run works in the
 * same checkout. Every 20 seconds, for at most 40 minutes, a detached writer
 * sets `freebuffLabConcurrentEdit` to its next count and logs that count
 * outside the checkout. The probe stops it and compares.
 */
const CONCURRENT_WRITER = `set -eu
mkdir -p "${LAB}"
rm -f "${LAB}/edits"
[ -f package.json ] || { echo 'No package.json in this repository; the collision case needs one.' >&2; exit 3; }
setsid nohup python3 -c '
import json, os, time
log = os.path.expanduser("~/.cache/freebuff-lab/edits")
for n in range(1, 121):
    time.sleep(20)
    try:
        with open("package.json") as f:
            data = json.load(f)
    except Exception:
        with open(log, "a") as f:
            f.write("unreadable\\n")
        continue
    data["freebuffLabConcurrentEdit"] = n
    with open("package.json", "w") as f:
        json.dump(data, f, indent=2)
        f.write("\\n")
    with open(log, "a") as f:
        f.write("%d\\n" % n)
' >/dev/null 2>&1 < /dev/null &
echo $! > "${LAB}/writer.pid"`

// setsid execs the writer in place, so the saved pid is the writer itself.
const CONCURRENT_PROBE = `if [ -s "${LAB}/writer.pid" ]; then
  kill "$(cat "${LAB}/writer.pid")" 2>/dev/null || true
  rm -f "${LAB}/writer.pid"
fi
python3 -c '
import json, os
log = os.path.expanduser("~/.cache/freebuff-lab/edits")
lines = open(log).read().split() if os.path.exists(log) else []
written = [int(x) for x in lines if x.isdigit()]
try:
    marker = json.load(open("package.json")).get("freebuffLabConcurrentEdit")
    valid = True
except Exception:
    marker, valid = None, False
last = written[-1] if written else None
print(json.dumps({
    "kind": "concurrent-package-json",
    "editsWritten": len(written),
    "unreadable": lines.count("unreadable"),
    "lastEdit": last,
    "markerInFile": marker if isinstance(marker, int) else None,
    "packageJsonValid": valid,
}))
'`

export const LAB_ENVIRONMENTS = {
  default: {
    label: 'Lab VM as is',
    description: 'The Cloud VM’s own Node toolchain.',
    setup: null,
    probe: null,
  },
  'node-nvm': {
    label: 'Node through nvm only',
    description:
      'Node 22 installed with nvm and activated from ~/.bashrc. The system node, npm and npx are not on PATH.',
    setup: NVM,
    probe: null,
  },
  'node-mise': {
    label: 'Node through mise only',
    description:
      'Node 22 installed with mise and activated from ~/.bashrc. mise itself and the system node are not on PATH.',
    setup: MISE,
    probe: null,
  },
  'node-volta': {
    label: 'Node through Volta only',
    description:
      'Node 22 installed with Volta, whose bin directory is added in ~/.bashrc. The system node is not on PATH.',
    setup: VOLTA,
    probe: null,
  },
  'concurrent-package-json': {
    label: 'Second thread edits package.json',
    description:
      'While the sponsored run works, another writer edits package.json every 20 seconds. Measures how often the two collide.',
    setup: CONCURRENT_WRITER,
    probe: CONCURRENT_PROBE,
  },
} as const satisfies Record<
  string,
  {
    label: string
    description: string
    setup: string | null
    probe: string | null
  }
>
export type LabEnvironment = keyof typeof LAB_ENVIRONMENTS
export const LAB_ENVIRONMENT_KEYS = Object.keys(LAB_ENVIRONMENTS) as [
  LabEnvironment,
  ...LabEnvironment[],
]

export const LAB_BATCH_MAX_REPETITIONS = 20
export const LAB_BATCH_MAX_REPOSITORIES = 10
/** A batch's runs, all repositories together. */
export const LAB_BATCH_MAX_RUNS = 100

export const labBatchInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    /** The ad to test; its text is copied into the batch when it is created. */
    selection: labSelectionSchema,
    projectIds: z
      .array(z.string().regex(/^[a-zA-Z0-9_-]{1,120}$/))
      .min(1)
      .max(LAB_BATCH_MAX_REPOSITORIES),
    repetitions: z.number().int().min(1).max(LAB_BATCH_MAX_REPETITIONS),
    environment: z.enum(LAB_ENVIRONMENT_KEYS),
    /** How the batch answers the run's signup question; no person is watching. */
    signup: z.enum(['decline', 'confirm']),
  })
  .strict()
  .refine(
    (input) =>
      new Set(input.projectIds).size === input.projectIds.length &&
      input.projectIds.length * input.repetitions <= LAB_BATCH_MAX_RUNS,
    `A batch runs at most ${LAB_BATCH_MAX_RUNS} times in all, on distinct repositories.`,
  )
export type LabBatchInput = z.infer<typeof labBatchInputSchema>

/** One graded run, as the production grader's tier ladder names it. */
export type LabRunGrade = {
  tier: 'perfect' | 'handoff' | 'partial' | 'broken' | 'lost'
  causeKey: string
  cause: string
  stepsCompleted: number | null
  stepsTotal: number | null
  grader: 'model' | 'rules'
  rubricVersion: string
}

export type LabConcurrencyProbe = {
  kind: 'concurrent-package-json'
  editsWritten: number
  unreadable: number
  lastEdit: number | null
  markerInFile: number | null
  packageJsonValid: boolean
}

export type LabBatchRun = {
  workspaceId: string
  projectId: string
  slot: number
  runId: string
  runStatus: string | null
  signup: string
  grade: LabRunGrade | null
  probe: LabConcurrencyProbe | { kind: 'setup-failed'; error: string } | null
}

export type LabBatch = {
  id: string
  name: string
  adName: string
  procedureSha256: string
  environment: LabEnvironment
  signup: 'decline' | 'confirm'
  repetitions: number
  repositories: Array<{ projectId: string; fullName: string }>
  state: 'running' | 'stopped'
  createdAt: string
  runs: LabBatchRun[]
}

/**
 * A run whose writer edited package.json and whose last edit is missing
 * afterwards was overwritten from a stale copy, or the file was left invalid.
 * The writer's edit can land after the agent's last write, so the file
 * holding the LAST edit is the only clean outcome. Null: nothing to measure.
 */
export function labProbeCollided(probe: LabBatchRun['probe']): boolean | null {
  if (!probe || probe.kind !== 'concurrent-package-json') return null
  if (!probe.editsWritten) return null
  return (
    !probe.packageJsonValid ||
    probe.unreadable > 0 ||
    probe.markerInFile !== probe.lastEdit
  )
}

export type LabBatchSummary = {
  planned: number
  started: number
  graded: number
  perfect: number
  /** perfect / graded, or null before any run is graded. */
  perfectRate: number | null
  byTier: Record<LabRunGrade['tier'], number>
  byCause: Array<{ causeKey: string; count: number }>
  /** Graded runs by how far they got: `completed/total`, `unknown` when the grader could not count. */
  byStepReached: Array<{ reached: string; count: number }>
  collisions: { measured: number; collided: number } | null
}

export function summarizeLabBatch(batch: LabBatch): LabBatchSummary {
  const graded = batch.runs.flatMap((run) => (run.grade ? [run.grade] : []))
  const count = <K extends string>(keys: K[]) => {
    const totals = new Map<K, number>()
    for (const key of keys) totals.set(key, (totals.get(key) ?? 0) + 1)
    return [...totals].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
  }
  const byTier = { perfect: 0, handoff: 0, partial: 0, broken: 0, lost: 0 }
  for (const grade of graded) byTier[grade.tier]++
  const probes = batch.runs.flatMap((run) => {
    const collided = labProbeCollided(run.probe)
    return collided === null ? [] : [collided]
  })
  return {
    planned: batch.repositories.length * batch.repetitions,
    started: batch.runs.length,
    graded: graded.length,
    perfect: byTier.perfect,
    perfectRate: graded.length ? byTier.perfect / graded.length : null,
    byTier,
    byCause: count(
      graded.filter((g) => g.tier !== 'perfect').map((g) => g.causeKey),
    ).map(([causeKey, n]) => ({ causeKey, count: n })),
    byStepReached: count(
      graded.map((g) =>
        g.stepsTotal === null || g.stepsCompleted === null
          ? 'unknown'
          : `${g.stepsCompleted}/${g.stepsTotal}`,
      ),
    ).map(([reached, n]) => ({ reached, count: n })),
    collisions:
      batch.environment === 'concurrent-package-json'
        ? {
            measured: probes.length,
            collided: probes.filter(Boolean).length,
          }
        : null,
  }
}

/** The first run-less slot: each repository's slots are claimed in order. */
export function nextLabBatchSlot(
  batch: Pick<LabBatch, 'repositories' | 'repetitions' | 'runs'>,
  busyProjects: ReadonlySet<string> = new Set(),
): { projectId: string; slot: number } | null {
  for (let slot = 0; slot < batch.repetitions; slot++)
    for (const { projectId } of batch.repositories) {
      if (busyProjects.has(projectId)) continue
      if (
        !batch.runs.some(
          (run) => run.projectId === projectId && run.slot === slot,
        )
      )
        return { projectId, slot }
    }
  return null
}
