/** One top-level folder a project checkpoint would hold, with its size before compression. */
export type CheckpointFolder = { name: string; bytes: number }

/**
 * A Cloud project's latest checkpoint that failed for being over the 4 GiB
 * limit: when, and its largest folders (none when the size scan could not
 * finish). Kept on the project's sandbox until a checkpoint succeeds
 * (`freebuff_cloud_sandbox.checkpoint_too_large`).
 */
export type CheckpointTooLarge = { at: string; largest: CheckpointFolder[] }

const size = (bytes: number) =>
  bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
    : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`

/** What a user is told when a project's checkpoint is over the limit even without what can be rebuilt. */
export function checkpointTooLargeMessage(largest: readonly CheckpointFolder[] = []) {
  const folders = largest.length
    ? ` Its largest folders, before compression: ${largest.map((f) => `“${f.name}” (${size(f.bytes)})`).join(', ')}.`
    : ''
  return `Cloud can’t save this project: even without dependencies, build output, Python virtual environments and caches, its files are over the 4 GiB limit for a saved copy.${folders} Delete large generated or data files you no longer need, or move them out of this project (for example to cloud storage or a separate GitHub repository) and download them only when you need them. Until the project fits, Cloud can’t archive it or back up its newest changes.`
}
