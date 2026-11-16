/**
 * Trust in a dashboard's numbers: which rows still match where they came from, and who may say
 * so. Pure and shared by the app (before a save) and the store (on every write, whoever writes).
 *
 * The rules, one stored → next transition at a time (`normaliseDataWrite`):
 *  - `refresh` (the recipe) and `certified` are the OWNER's: anyone else's change is refused.
 *    The owner's agent may set a recipe (it works on their behalf) but never certifies: a
 *    certification is a person vouching.
 *  - `provenance` and `lastRun` are the record of a pull: the owner's agent's, or a server refresh's
 *    (`pull`: the owner-approved recipe, run on the server, whoever asked). Anyone else's write (a
 *    person's, or an editor's own agent) carries the stored ones forward whatever it sent, so a
 *    hand edit can never claim a fetch.
 *  - When a write changes a dataset's rows or columns, the rows are matched against the stored
 *    ones (`diffRows`) and `lastChange` is recomputed here; anything the writer sent is ignored.
 *    Unless the agent recorded a fresh pull with it (a new `provenance`), the dataset is stamped
 *    `edited` (by the person, or "Buffy") at `now`: "edited by Maya, no longer matches its source".
 *  - A certification counts only while its `rowsHash` matches the rows (`certification`).
 *  - A dataset carrying the owner's recipe or certification is removed (or renamed away) only by
 *    the owner, and a certified one only by the owner in person: removing it would strip their word.
 */

import { APPROVAL_VIA, connectedRecipeState, normaliseRecipeApproval, type ApprovalMode } from './data-connect'
import type { Dashboard, Dataset, DataRow, RowChange } from './data'

/** The author name an agent's stamps carry. */
export const AGENT_NAME = 'Buffy'

export type DataWriter = {
  /** The artifact's owner (a person, or their agent: see `agent`). */
  owner: boolean
  /** The write comes from the agent (any run), not from a person's save. */
  agent: boolean
  /** The write's time, ISO; the store's clock on the server. */
  now: string
  /** The person's display name for `edited` and `certified` stamps (ignored for the agent). */
  by?: string | null
  /** How the write treats a connected recipe's approval (data-connect.ts `ApprovalMode`); a save mints. */
  approvals?: ApprovalMode
  /**
   * A server refresh's write (`ArtifactStore.saveRefresh`): the rows came from the owner-approved
   * recipe, run by the server, so its provenance and run record stand whoever asked for it.
   */
  pull?: boolean
  /**
   * `stored` is the source of a new artifact (a copy, Made from), not this artifact's last body:
   * datasets the write leaves out are not removed from anything.
   */
  copy?: boolean
}

export type DataWriteResult = { ok: true; dashboard: Dashboard } | { ok: false; refusal: string }

/** FNV-1a (32-bit, hex) of a dataset's columns and rows: what a certification vouches for. */
export function rowsHash(dataset: Pick<Dataset, 'columns' | 'rows'>): string {
  const text = JSON.stringify([dataset.columns.map((c) => [c.key, c.type]), dataset.rows.map(canonicalRow)])
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** A row with its keys sorted and missing cells as null-free (a left-out cell reads as null). */
function canonicalRow(row: DataRow): Array<[string, unknown]> {
  return Object.keys(row)
    .filter((key) => row[key] !== null && row[key] !== undefined)
    .sort()
    .map((key) => [key, row[key]])
}

const rowText = (row: DataRow) => JSON.stringify(canonicalRow(row))

/**
 * The columns that identify a row: the dataset's `key`, else the first column when its values
 * are all present and unique in both versions, else none (rows then match as whole rows).
 */
export function rowKeyColumns(before: Pick<Dataset, 'columns' | 'rows' | 'key'> | undefined, after: Pick<Dataset, 'columns' | 'rows' | 'key'>): string[] {
  if (after.key?.length) return after.key
  const first = after.columns[0]?.key
  if (!first || (before && before.columns[0]?.key !== first)) return []
  const unique = (rows: DataRow[]) => {
    const seen = new Set<string>()
    for (const row of rows) {
      const v = row[first]
      if (v === null || v === undefined) return false
      const k = String(v)
      if (seen.has(k)) return false
      seen.add(k)
    }
    return true
  }
  return unique(after.rows) && (!before || unique(before.rows)) ? [first] : []
}

/**
 * Rows added, removed, changed and unchanged between two versions of a dataset. Matched by
 * `rowKeyColumns` when there is one (a row whose key stays but whose cells differ is changed),
 * else as whole rows (a changed row reads as one removed and one added).
 */
export function diffRows(
  before: Pick<Dataset, 'columns' | 'rows' | 'key'> | undefined,
  after: Pick<Dataset, 'columns' | 'rows' | 'key'>,
  at: string,
): RowChange {
  const old = before?.rows ?? []
  const key = rowKeyColumns(before, after)
  if (key.length) {
    const keyOf = (row: DataRow) => JSON.stringify(key.map((k) => row[k] ?? null))
    const previous = new Map<string, DataRow>()
    for (const row of old) if (!previous.has(keyOf(row))) previous.set(keyOf(row), row)
    let added = 0
    let changed = 0
    let unchanged = 0
    const seen = new Set<string>()
    for (const row of after.rows) {
      const k = keyOf(row)
      const was = previous.get(k)
      if (!was || seen.has(k)) added++
      else if (rowText(was) === rowText(row)) unchanged++
      else changed++
      seen.add(k)
    }
    const removed = [...previous.keys()].filter((k) => !seen.has(k)).length
    return { at, added, removed, changed, unchanged, keyed: true }
  }
  // Whole rows as a multiset.
  const counts = new Map<string, number>()
  for (const row of old) counts.set(rowText(row), (counts.get(rowText(row)) ?? 0) + 1)
  let unchanged = 0
  let added = 0
  for (const row of after.rows) {
    const t = rowText(row)
    const n = counts.get(t) ?? 0
    if (n > 0) {
      counts.set(t, n - 1)
      unchanged++
    } else added++
  }
  const removed = [...counts.values()].reduce((a, b) => a + b, 0)
  return { at, added, removed, changed: 0, unchanged, keyed: false }
}

/** Whether the rows a write leaves differ from the stored ones (columns or any cell). */
export function rowsDiffer(before: Pick<Dataset, 'columns' | 'rows'> | undefined, after: Pick<Dataset, 'columns' | 'rows'>): boolean {
  if (!before) return after.rows.length > 0
  // The full canonical text, never the short hash: a crafted collision must not hide an edit.
  return canonicalText(before) !== canonicalText(after)
}

const canonicalText = (dataset: Pick<Dataset, 'columns' | 'rows'>) =>
  JSON.stringify([dataset.columns.map((c) => [c.key, c.type]), dataset.rows.map(canonicalRow)])

/** A certification's state: none, valid (the rows are the ones vouched for), or void (they changed since). */
export function certification(dataset: Dataset): 'none' | 'valid' | 'void' {
  if (!dataset.certified) return 'none'
  return dataset.certified.rowsHash === rowsHash(dataset) ? 'valid' : 'void'
}

/** Structural equality of JSON values (key order ignored; undefined and a missing key alike). */
export function isDeepStrictEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) {
    const other = b as unknown[]
    return a.length === other.length && a.every((item, i) => isDeepStrictEqual(item, other[i]))
  }
  const x = a as Record<string, unknown>
  const y = b as Record<string, unknown>
  const keys = new Set([...Object.keys(x), ...Object.keys(y)].filter((k) => x[k] !== undefined || y[k] !== undefined))
  for (const key of keys) if (!isDeepStrictEqual(x[key], y[key])) return false
  return true
}

const cleanName = (name: string | null | undefined) => {
  const trimmed = (name ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)
  return trimmed || null
}

/**
 * One write over the stored dashboard, by the rules at the top of this file: the dashboard to
 * store (stamps and records set here, never trusted from the writer), or why it is refused.
 * `stored` is null for a new artifact (its creator is the owner).
 */
export function normaliseDataWrite(stored: Dashboard | null, next: Dashboard, writer: DataWriter): DataWriteResult {
  const before = new Map((stored?.datasets ?? []).map((d) => [d.id, d]))
  const person = cleanName(writer.by) ?? 'an editor'
  // Who may record a pull: the owner's agent, or the server's refresh of the approved recipe.
  const recordsPull = writer.pull === true || (writer.agent && writer.owner)
  if (!writer.copy) {
    const kept = new Set(next.datasets.map((d) => d.id))
    for (const [id, old] of before) {
      if (kept.has(id)) continue
      if (old.refresh !== undefined && !writer.owner)
        return { ok: false, refusal: `Only the owner can remove dataset ${id}: it has their refresh recipe` }
      if (old.certified !== undefined && (!writer.owner || writer.agent))
        return {
          ok: false,
          refusal: writer.agent
            ? `Only the owner can remove dataset ${id}: it is certified; ask them to`
            : `Only the owner can remove dataset ${id}: it is certified`,
        }
    }
  }
  const datasets: Dataset[] = []
  for (const dataset of next.datasets) {
    const old = before.get(dataset.id)
    // Refusals name the id only: a title is collaborator text and refusals reach the agent unframed.
    const name = `dataset ${dataset.id}`
    // The recipe is the owner's (their agent may write it on their behalf).
    if (!writer.owner && !isDeepStrictEqual(dataset.refresh, old?.refresh))
      return { ok: false, refusal: `Only the owner can change how ${name} is refreshed` }
    // A certification is the owner's own word: never their agent's, never an editor's.
    if (!isDeepStrictEqual(dataset.certified, old?.certified) && (!writer.owner || writer.agent)) {
      return {
        ok: false,
        refusal: writer.agent
          ? `Only the owner can certify ${name}; ask them to`
          : `Only the owner can certify ${name} or remove its certification`,
      }
    }
    let out: Dataset = { ...dataset }
    // A connected recipe's approval is the owner's own word, stamped here (data-connect.ts).
    out = withField(out, 'refresh', normaliseRecipeApproval(old?.refresh, dataset.refresh, writer, person))
    // The pull's record is the owner's agent's or a server refresh's: anyone else's write keeps the
    // stored one, whatever it sent (an editor's agent cannot launder rows as a "fresh pull").
    if (!recordsPull) {
      out = withField(out, 'provenance', old?.provenance)
      out = withField(out, 'lastRun', old?.lastRun)
    }
    // Stamps are this function's alone: start from the stored ones.
    out = withField(out, 'edited', old?.edited)
    out = withField(out, 'lastChange', old?.lastChange)
    if (rowsDiffer(old, dataset)) {
      out = withField(out, 'lastChange', diffRows(old, dataset, writer.now))
      const freshPull = recordsPull && dataset.provenance !== undefined && !isDeepStrictEqual(dataset.provenance, old?.provenance)
      // A new dataset is what it is (an import, a paste): only a change to stored rows is an edit.
      if (old) out = withField(out, 'edited', freshPull ? undefined : { by: writer.agent ? AGENT_NAME : person, at: writer.now })
      // The rows a certification vouched for are gone: void it for good (not by hash alone).
      if (out.certified && isDeepStrictEqual(dataset.certified, old?.certified)) out = withField(out, 'certified', { ...out.certified, rowsHash: 'changed' })
    }
    // A provenance-only write (rows untouched) never clears an edited stamp: only rows written
    // with a fresh pull do, so a hand edit cannot be laundered by restamping its provenance.
    // An owner's new or changed certification vouches for the rows as they are now.
    if (dataset.certified && !isDeepStrictEqual(dataset.certified, old?.certified)) {
      out = withField(out, 'certified', { ...dataset.certified, by: person, at: writer.now, rowsHash: rowsHash(dataset) })
    }
    datasets.push(out)
  }
  return { ok: true, dashboard: { ...next, datasets } }
}

function withField<K extends keyof Dataset>(dataset: Dataset, key: K, value: Dataset[K] | undefined): Dataset {
  if (value === undefined) {
    if (!(key in dataset)) return dataset
    const { [key]: _drop, ...rest } = dataset
    return rest as Dataset
  }
  return { ...dataset, [key]: value }
}

/**
 * The store's form of `normaliseDataWrite`, on body text: the body to store, or the refusal. An
 * unreadable stored body has nothing to keep; an unreadable `next` is the validator's to refuse
 * (passed through unchanged). Rules that throw part-way refuse the write (fail closed).
 */
export function normaliseDataBody(
  storedBody: string | null,
  nextBody: string,
  writer: DataWriter,
): { ok: true; body: string } | { ok: false; refusal: string } {
  const next = parseObject(nextBody)
  if (!next || !Array.isArray(next.datasets)) return { ok: true, body: nextBody }
  const stored = storedBody === null ? null : parseObject(storedBody)
  const storedDashboard = stored && Array.isArray(stored.datasets) ? (stored as unknown as Dashboard) : null
  try {
    const result = normaliseDataWrite(storedDashboard, next as unknown as Dashboard, writer)
    return result.ok ? { ok: true, body: JSON.stringify(result.dashboard) } : result
  } catch {
    // The store validates `next` before this runs, so a throw means the rules could not be applied
    // (a stored body they cannot read): refuse rather than store stamps and records unchecked.
    return { ok: false, refusal: "This dashboard's trust records could not be checked, so the change was not saved" }
  }
}

/**
 * Whether a stored dataset's connected recipe may run (artifact-data-refresh.ts): it is an
 * integration recipe whose owner approval (stamped only by `normaliseDataWrite` on the owner's
 * own save, in the store's enforced pipeline, which alone marks it `via: APPROVAL_VIA`) covers it
 * exactly as stored. False for anything unreadable, missing, pending, or stamped without the
 * marker (an approval saved before the pipeline enforced these rules, or forged).
 */
export function recipeTrustedForRun(storedBody: string, datasetId: string): boolean {
  const stored = parseObject(storedBody)
  const datasets = stored && Array.isArray(stored.datasets) ? (stored.datasets as Dataset[]) : []
  const dataset = datasets.find((d) => d && typeof d === 'object' && d.id === datasetId)
  return dataset?.refresh?.approved?.via === APPROVAL_VIA && connectedRecipeState(dataset.refresh) === 'approved'
}

/**
 * The body a reader other than the owner is shown: each dataset's `provenance.account` (the owner's
 * connected account label, possibly their email) left out. The text unchanged when there is none.
 */
export function withoutOwnerOnlyDataFields(body: string): string {
  const parsed = parseObject(body)
  const datasets = parsed && Array.isArray(parsed.datasets) ? (parsed.datasets as Array<Record<string, unknown>>) : null
  if (!datasets?.some((d) => ownerOnlyAccount(d) !== undefined)) return body
  return JSON.stringify({
    ...parsed,
    datasets: datasets.map((d) => {
      if (ownerOnlyAccount(d) === undefined) return d
      const { account: _owners, ...provenance } = d.provenance as Record<string, unknown>
      return { ...d, provenance }
    }),
  })
}

/**
 * A non-owner's write puts the stored owner-only fields back: where a dataset's provenance is the
 * stored one minus `account` (what `withoutOwnerOnlyDataFields` showed them), the stored account
 * returns, so their round trip neither erases it nor reads as a new provenance. Any other
 * provenance is theirs as sent (the trust rules decide what a person's provenance may be).
 */
export function withOwnerOnlyDataFields(storedBody: string | null, nextBody: string): string {
  const stored = storedBody === null ? null : parseObject(storedBody)
  const storedSets = stored && Array.isArray(stored.datasets) ? (stored.datasets as Array<Record<string, unknown>>) : []
  const accounts = new Map(storedSets.filter((d) => ownerOnlyAccount(d) !== undefined).map((d) => [d.id, d] as const))
  if (!accounts.size) return nextBody
  const next = parseObject(nextBody)
  const nextSets = next && Array.isArray(next.datasets) ? (next.datasets as Array<Record<string, unknown>>) : null
  if (!nextSets) return nextBody
  let changed = false
  const datasets = nextSets.map((d) => {
    const old = d && typeof d === 'object' ? accounts.get(d.id) : undefined
    if (!old || ownerOnlyAccount(d) !== undefined || !d.provenance || typeof d.provenance !== 'object') return d
    const { account, ...rest } = old.provenance as Record<string, unknown>
    if (!isDeepStrictEqual(rest, d.provenance)) return d
    changed = true
    return { ...d, provenance: { ...(d.provenance as Record<string, unknown>), account } }
  })
  return changed ? JSON.stringify({ ...next, datasets }) : nextBody
}

const ownerOnlyAccount = (dataset: Record<string, unknown> | null | undefined): unknown =>
  dataset && typeof dataset === 'object' && dataset.provenance && typeof dataset.provenance === 'object'
    ? (dataset.provenance as Record<string, unknown>).account
    : undefined

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text) as unknown
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** Why one dataset's numbers may not be what its source says now, for banners and the readout. */
export type DatasetDoubt = {
  datasetId: string
  name: string
  /** Hand-edited after the pull. */
  edited?: { by: string; at: string }
  /** The agent's last refresh failed. */
  failed?: string
  /** A certification that no longer matches the rows. */
  voidCertificate?: boolean
  /** Rows that break the dataset's `expect`. */
  checks: string[]
}

/** What a dataset's `expect` finds wrong with its rows (empty when it passes or has none). */
export function expectProblems(dataset: Dataset): string[] {
  const out: string[] = []
  const expect = dataset.expect
  if (!expect) return out
  if (expect.minRows !== undefined && dataset.rows.length < expect.minRows)
    out.push(`has ${dataset.rows.length} rows; at least ${expect.minRows} expected`)
  for (const key of expect.required ?? []) {
    const empty = dataset.rows.filter((row) => row[key] === null || row[key] === undefined || row[key] === '').length
    if (empty) out.push(`${empty} ${empty === 1 ? 'row has' : 'rows have'} no ${key} (required)`)
  }
  return out
}

/** Every dataset whose rows are in doubt, with why, in dataset order. */
export function datasetDoubts(dashboard: Dashboard): DatasetDoubt[] {
  const out: DatasetDoubt[] = []
  for (const dataset of dashboard.datasets) {
    const doubt: DatasetDoubt = { datasetId: dataset.id, name: dataset.title ?? dataset.id, checks: expectProblems(dataset) }
    if (dataset.edited) doubt.edited = dataset.edited
    if (dataset.lastRun?.status === 'failed') doubt.failed = dataset.lastRun.message ?? 'no reason given'
    if (certification(dataset) === 'void') doubt.voidCertificate = true
    if (doubt.edited || doubt.failed || doubt.voidCertificate || doubt.checks.length) out.push(doubt)
  }
  return out
}

/**
 * What changed in a dashboard between two versions, by id, for the agent (a delta read) and the
 * history list: blocks and datasets added, removed or edited; per dataset, rows added, removed
 * and changed (matched by key) and its recipe, provenance, run and certification; filters,
 * parameters and settings. Ids only (never titles), one line per change, at most `max` lines.
 */
export function dashboardDelta(before: Dashboard, after: Dashboard, max = 40): string[] {
  const out: string[] = []
  const byId = <T extends { id: string }>(list: readonly T[] | undefined) => new Map((list ?? []).map((item) => [item.id, item]))
  const listDelta = <T extends { id: string }>(noun: string, a: readonly T[] | undefined, b: readonly T[] | undefined) => {
    const old = byId(a)
    const now = byId(b)
    for (const id of now.keys()) if (!old.has(id)) out.push(`added ${noun} ${id}`)
    for (const id of old.keys()) if (!now.has(id)) out.push(`removed ${noun} ${id}`)
    return { old, now }
  }
  const blocks = listDelta('block', before.blocks, after.blocks)
  for (const [id, block] of blocks.now) {
    const was = blocks.old.get(id)
    if (was && !isDeepStrictEqual(was, block)) out.push(`edited block ${id}`)
  }
  const order = (list: readonly { id: string }[]) => list.map((b) => b.id).filter((id) => blocks.old.has(id) && blocks.now.has(id)).join(',')
  if (order(before.blocks) !== order(after.blocks)) out.push('reordered blocks')
  const datasets = listDelta('dataset', before.datasets, after.datasets)
  for (const [id, dataset] of datasets.now) {
    const was = datasets.old.get(id)
    if (!was) continue
    if (rowsDiffer(was, dataset)) {
      const change = diffRows(was, dataset, '')
      out.push(`dataset ${id} rows: +${change.added} -${change.removed} ~${change.changed} (=${change.unchanged})${change.keyed ? '' : ' unkeyed'}`)
    }
    for (const field of ['refresh', 'provenance', 'lastRun', 'edited', 'certified', 'calculated', 'key', 'expect', 'title', 'sourceId'] as const) {
      if (!isDeepStrictEqual(was[field], dataset[field])) out.push(`dataset ${id} ${field} ${dataset[field] === undefined ? 'removed' : was[field] === undefined ? 'set' : 'changed'}`)
    }
  }
  const filters = listDelta('filter', before.filters, after.filters)
  for (const [id, filter] of filters.now) if (filters.old.has(id) && !isDeepStrictEqual(filters.old.get(id), filter)) out.push(`edited filter ${id}`)
  const params = listDelta('parameter', before.params, after.params)
  for (const [id, param] of params.now) if (params.old.has(id) && !isDeepStrictEqual(params.old.get(id), param)) out.push(`edited parameter ${id}`)
  const sources = listDelta('source', before.sources, after.sources)
  for (const [id, source] of sources.now) if (sources.old.has(id) && !isDeepStrictEqual(sources.old.get(id), source)) out.push(`edited source ${id}`)
  for (const field of ['title', 'subtitle', 'asOf', 'layout', 'currency', 'tabs'] as const) {
    if (!isDeepStrictEqual(before[field], after[field])) out.push(`${field} changed`)
  }
  return out.length > max ? [...out.slice(0, max), `(+${out.length - max} more)`] : out
}
