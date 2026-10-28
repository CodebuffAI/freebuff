/** Stable product messages, also used when Desktop imports Cloud history. */
export const CLOUD_RESOURCE_MESSAGE =
  'Your cloud environment has reached its resource limit. Open this chat in the Desktop app to continue locally.'
export const CLOUD_RESOURCE_PENDING =
  'Your cloud environment has reached its resource limit. Your files are being saved for recovery. Open this chat in the Desktop app to continue locally.'
export const CLOUD_RESOURCE_MOVE_REASON =
  'The cloud environment is running low on resources. Continue the same task locally, preserving completed work and checking any interrupted command before retrying it.'
export const CLOUD_RESOURCE_EVENT = 'resource_limit'
export type CloudResourceKind =
  | 'disk'
  | 'memory'
  | 'cpu'
  | 'processes'
  | 'files'
  | 'time'
export const isCloudResourceMessage = (message: string | null | undefined) =>
  message === CLOUD_RESOURCE_MESSAGE || message === CLOUD_RESOURCE_PENDING

/** Which limit was hit, in plain words, and what usually takes that resource. */
const RESOURCE_EXPLANATIONS: Record<
  CloudResourceKind,
  { what: string; advice: string }
> = {
  disk: {
    what: "Cloud stopped this turn because the project's disk is almost full (under 2 GB free).",
    advice:
      'Build output and large folders such as node_modules usually take the space; remove what you no longer need before running this project in Cloud again.',
  },
  memory: {
    what: 'Cloud stopped this turn because the project used up its memory.',
    advice:
      'A dev server, build or test run that keeps growing is the usual cause; stop it, or split the task into smaller steps, before running this project in Cloud again.',
  },
  cpu: {
    what: 'Cloud stopped this turn because the project kept the CPU fully busy for over 30 seconds.',
    advice:
      'A runaway build or loop is the usual cause; stop it before running this project in Cloud again.',
  },
  processes: {
    what: 'Cloud stopped this turn because the project is running too many processes.',
    advice:
      'Dev servers and watchers left running are the usual cause; stop the ones you no longer need before running this project in Cloud again.',
  },
  files: {
    what: 'Cloud stopped this turn because a process has too many files open.',
    advice:
      'A file watcher over a huge folder is the usual cause; stop it before running this project in Cloud again.',
  },
  time: {
    what: 'Cloud stopped this turn because it passed the two-hour limit for one turn.',
    advice: 'Send the work as smaller steps.',
  },
}

/**
 * Where the files went, for a run whose client cannot move it to this computer
 * (web). Recovery takes the chat's files out of Cloud into a copy only Desktop
 * reads; a new Cloud chat starts from the project's source, not from them, and
 * deleting the chat purges the copy. "Your files are saved" alone sent web users
 * to a new chat that was empty (2026-10-28).
 */
export const CLOUD_RESOURCE_FILES_WHERE =
  'They are kept for this chat only, and only the Freebuff Desktop app can get them back. A new chat does not start from them, and deleting this chat deletes them.'

/**
 * The transcript note written next to a resource-limit failure: which limit,
 * whether the files are already safe, what to clean up. CLOUD_RESOURCE_MESSAGE
 * itself stays the fixed sentence Desktop builds compare against
 * (`isCloudResourceMessage`), so the explanation travels as a text event.
 * `movesLocally` is false when the run's client cannot continue it locally.
 */
export function cloudResourceExplanation(
  kind: CloudResourceKind,
  recovered: boolean,
  movesLocally = true,
): string {
  const { what, advice } = RESOURCE_EXPLANATIONS[kind]
  const files = recovered
    ? 'Your files are saved.'
    : 'Your files are being saved for recovery; this can take a few minutes.'
  return movesLocally
    ? `${what} ${files} ${advice}`
    : `${what} ${files} ${CLOUD_RESOURCE_FILES_WHERE} ${advice}`
}
