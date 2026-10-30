/** Bump when the summary policy changes, so reports never mix implementations. */
export const SUMMARY_COMPACTION_VERSION = 'summary-v1'

/** Request metadata is analytics, never an authorization or billing decision. */
export const COMPACTION_METADATA_KEYS = [
  'compaction_version',
  'compaction_root_version',
  'compaction_root_run_id',
  'compaction_root_model',
  'compaction_root_start_context_tokens',
  'compaction_request_id',
  'compaction_request_group',
  'compaction_id',
  'compaction_summary_id',
  'compaction_trigger',
  'compaction_summary',
] as const

export function compactionMetadata(
  metadata: unknown,
): Record<string, string> {
  const result: Record<string, string> = {}
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
    return result
  const record = metadata as Record<string, unknown>
  for (const key of [
    ...COMPACTION_METADATA_KEYS,
    'trace_session_id',
  ] as const) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0 && value.length <= 200)
      result[key] = value
  }
  return result
}

/** A child or auxiliary request must not inherit its parent's request group. */
export function clearCompactionRequestMetadata(
  metadata: Record<string, string> | undefined,
): Record<string, string> {
  const result = { ...metadata }
  for (const key of COMPACTION_METADATA_KEYS) {
    if (!key.startsWith('compaction_root_')) delete result[key]
  }
  return result
}
