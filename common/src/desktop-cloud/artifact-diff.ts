import { joinDocSuggestions, splitDocSuggestions } from './artifact-kinds/doc-suggestions'
import { carryDocBlockIds } from './artifact-kinds/doc-block-ids'
import { applyDocBodyEdit } from './artifact-kinds/doc-blocks'
import { docTabs, parseTabMarker, splitBlocks, tabOfBlock, type DocBlockEdit, type DocTab } from './artifact-kinds/doc-tabs'
import { colName, parseAddress, toAddress } from './artifact-kinds/sheet-address'

import type { ArtifactKind } from './artifacts'
import { boundId, deepEqual, has, idOf, isObj, keyed, parseObject, withoutBoundTo } from './artifact-merge'

/**
 * A structural diff between two versions of one artifact's body, for the "Compare versions" view
 * and for the agent's `read_artifact {sinceRevision}` summary, plus restoring ONE changed unit's
 * old value onto the live body.
 *
 * Units follow the three-way merge (artifact-merge.ts): a doc's top-level blocks (its suggestions
 * sidecar is not a block), a sheet's tabs by id and cells by address (after aligning inserted or
 * deleted rows and columns), slides and their elements by id, whiteboard elements by id (arrows
 * are connectors), a dashboard's sources/datasets/blocks/filters/params by id, a design's boards
 * by id and its nodes as one design-wide map.
 *
 * Pure and total: nothing here throws. A JSON body that does not parse (or whose lists cannot be
 * keyed) gives `ok: false` and one whole-body change. A restored body is NOT schema-validated
 * here (the caller validates it like any other save); the cheap dangling cases the validators
 * would reject (an arrow bound to a missing element, a node whose parent is gone, the last slide)
 * are refused instead. JSON bodies are written back compact, as the store keeps them, and only
 * the restored unit changes: every other key, known or not, is kept.
 */

export type DiffSegment = { op: 'same' | 'add' | 'del'; text: string }
export type ArtifactDiffOp = 'added' | 'removed' | 'changed' | 'moved' | 'renamed'
export type ArtifactDiffChange = {
  /** Stable unique key: 'block:3', 'tab:<id>', 'slide:<id>', 'element:<slideId>/<elId>', 'cell:<tabId>!B3', 'node:<id>'… */
  id: string
  /** 'block'|'tab'|'slide'|'element'|'cell'|'row'|'column'|'format'|'source'|'dataset'|'block'|'filter'|'param'|'connector'|'board'|'node'|'style'|'token'|'page'|'note'|'title'|'setting'|'body' */
  unit: string
  op: ArtifactDiffOp
  /** Human: 'Slide 3 “Pricing”', 'Cell Sheet1!B3', 'Paragraph 4'. */
  label: string
  /** Which fields changed (slides, design, whiteboard, data, sheet formats). */
  fields?: string[]
  /** A short textual rendering of the old unit (capped). */
  before?: string
  after?: string
  /** Word diff of `before` → `after`, when both are text. */
  words?: DiffSegment[]
  /** Sheet: value, formula and rich text equal; only format or style keys differ. */
  formatOnly?: boolean
  /** Whether `restoreArtifactChange` can apply it. */
  restorable: boolean
  /** For grouping in the UI: the tab name, the slide label, the board title. */
  group?: string
  /** Extra lines (a dataset's row count delta and sample changed rows). */
  detail?: string[]
}
export type ArtifactDiff = {
  kind: ArtifactKind
  ok: boolean
  changes: ArtifactDiffChange[]
  omitted: number
  counts: { unit: string; added: number; removed: number; changed: number; moved: number; renamed: number }[]
  formatOnlyCount: number
  summary: string
}

type RestoreResult = { ok: true; body: string } | { ok: false; reason: string }

// ---------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------

const DEFAULT_CAP = 200
const DEFAULT_ROW_SAMPLES = 3
const DEFAULT_MAX_LINES = 40

export function diffArtifactBodies(
  kind: ArtifactKind,
  before: string,
  after: string,
  options: { cap?: number; rowSamples?: number } = {},
): ArtifactDiff {
  const cap = Math.max(0, Math.floor(options.cap ?? DEFAULT_CAP))
  const computed = compute(kind, before, after, { rowSamples: options.rowSamples ?? DEFAULT_ROW_SAMPLES })
  return finish(kind, computed, cap)
}

export function describeArtifactDiff(
  kind: ArtifactKind,
  before: string,
  after: string,
  options: { maxLines?: number } = {},
): string {
  const maxLines = Math.max(0, Math.floor(options.maxLines ?? DEFAULT_MAX_LINES))
  const diff = diffArtifactBodies(kind, before, after, { cap: Number.MAX_SAFE_INTEGER })
  const lines = [diff.summary]
  const shown = diff.changes.slice(0, maxLines)
  for (const change of shown) {
    lines.push(bulletOf(change))
    for (const extra of change.detail ?? []) lines.push(`  ${oneLine(extra, 160)}`)
  }
  const more = diff.changes.length - shown.length
  if (more > 0) lines.push(`…and ${more} more`)
  return lines.join('\n')
}

export function restoreArtifactChange(
  kind: ArtifactKind,
  before: string,
  after: string,
  current: string,
  changeId: string,
): RestoreResult {
  try {
    const computed = compute(kind, before, after, { rowSamples: 0 })
    const entry = computed.entries.find((e) => e.change.id === changeId)
    if (!entry) return fail(`No change "${changeId}" between these versions`)
    if (!entry.restore) return fail(entry.reason ?? `${entry.change.label} cannot be restored on its own`)
    return entry.restore(current)
  } catch {
    return fail('The change could not be restored')
  }
}

// ---------------------------------------------------------------------------------------------
// Shared machinery
// ---------------------------------------------------------------------------------------------

type Obj = Record<string, unknown>
type Restorer = (current: string) => RestoreResult
type Entry = { change: ArtifactDiffChange; restore?: Restorer; reason?: string }
type Computed = { ok: boolean; entries: Entry[] }
type Ctx = { rowSamples: number }
type ChangeInput = Omit<ArtifactDiffChange, 'restorable'>

const TEXT_CAP = 2000
/** wordDiff's LCS table cap (tokens × tokens); above it the middle is one del + one add. */
const WORD_LCS_CELLS = 250_000
/** Block / row / column alignment cap, as the merge's. Above it: no alignment. */
const ALIGN_LCS_CELLS = 4_000_000

class NotComparable extends Error {}

const fail = (reason: string): RestoreResult => ({ ok: false, reason })

// re-derived from artifact-merge.ts, not exported there
/** Structural equality; object key order does not matter, array order does. */
// re-derived from artifact-merge.ts, not exported there
// re-derived from artifact-merge.ts, not exported there
// re-derived from artifact-merge.ts, not exported there
/** A sheet cell's value: `v` or `f`, and the rich-text `runs` whose texts must join to `v`. */
const CELL_VALUE = ['v', 'f', 'runs'] as const

const clone = <T>(value: T): T => structuredClone(value)

function clip(text: string, max = TEXT_CAP): string {
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text
}

function oneLine(text: string, max: number): string {
  return clip(text.replace(/\s+/g, ' ').trim(), max)
}

/** A value as short text: strings as they are, everything else as compact JSON. */
function show(value: unknown): string {
  if (value === undefined) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}

const quoted = (text: string | undefined, max = 40) => (text ? ` “${oneLine(text, max)}”` : '')

/** The changed fields of `o`, one per line (`field: value`), or the bare value for one field. */
function renderFields(o: Obj | undefined, fields: readonly string[], render: (key: string, value: unknown) => string = (_k, v) => show(v)): string | undefined {
  if (!o) return undefined
  const present = fields.filter((f) => has(o, f))
  if (present.length === 0) return fields.length === 1 ? '' : undefined
  if (fields.length === 1) return clip(render(fields[0], o[fields[0]]))
  return clip(present.map((f) => `${f}: ${render(f, o[f])}`).join('\n'))
}

const TEXT_FIELDS = ['title', 'name', 'subtitle', 'label', 'text', 'body', 'markdown', 'notes', 'alt', 'url'] as const

/** An added or removed item as text: its text-ish fields, else its JSON. */
function renderItem(o: Obj | undefined): string | undefined {
  if (!o) return undefined
  const lines = TEXT_FIELDS.filter((f) => typeof o[f] === 'string' && o[f] !== '').map((f) => `${f}: ${String(o[f])}`)
  return clip(lines.length > 0 ? lines.join('\n') : show(o))
}

/** Restore through a parsed copy of the current body; `apply` mutates it or names a refusal. */
function jsonRestorer(apply: (root: Obj) => string | null): Restorer {
  return (current) => {
    const root = parseObject(current)
    if (!root) return fail('The current version is not valid JSON')
    const copy = clone(root)
    const refusal = apply(copy)
    if (refusal !== null) return fail(refusal)
    if (deepEqual(copy, root)) return fail('Nothing to restore: the current version already has the old value')
    return { ok: true, body: JSON.stringify(copy) }
  }
}

class Collector {
  readonly entries: Entry[] = []
  private readonly ids = new Set<string>()
  add(input: ChangeInput, restore?: Restorer, reason?: string) {
    let id = input.id
    for (let n = 2; this.ids.has(id); n += 1) id = `${input.id}#${n}`
    this.ids.add(id)
    const change: ArtifactDiffChange = { ...stripUndefined(input), id, restorable: restore !== undefined }
    const entry: Entry = { change }
    if (restore) entry.restore = restore
    if (reason) entry.reason = reason
    this.entries.push(entry)
  }
}

function stripUndefined<T extends object>(o: T): T {
  const out: Obj = {}
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v
  return out as T
}

/** before/after and, when both are text, the word diff. */
function textual(before: string | undefined, after: string | undefined): Pick<ChangeInput, 'before' | 'after' | 'words'> {
  const out: Pick<ChangeInput, 'before' | 'after' | 'words'> = {}
  if (before !== undefined) out.before = clip(before)
  if (after !== undefined) out.after = clip(after)
  if (before !== undefined && after !== undefined && (before !== '' || after !== '')) out.words = wordDiff(clip(before), clip(after))
  return out
}

function compute(kind: ArtifactKind, before: string, after: string, ctx: Ctx): Computed {
  try {
    const c = new Collector()
    if (kind === 'doc') {
      diffDoc(before, after, c)
      return { ok: true, entries: c.entries }
    }
    const b = parseObject(before)
    const a = parseObject(after)
    if (!b || !a) return wholeBody(before, after, 'one version is not valid JSON')
    if (before === after || deepEqual(b, a)) return { ok: true, entries: [] }
    JSON_DIFFS[kind](b, a, c, ctx)
    return { ok: true, entries: c.entries }
  } catch {
    return wholeBody(before, after, 'the versions could not be compared')
  }
}

function wholeBody(before: string, after: string, why: string): Computed {
  if (before === after) return { ok: false, entries: [] }
  return {
    ok: false,
    entries: [
      {
        change: { id: 'body', unit: 'body', op: 'changed', label: 'Whole body', before: clip(before), after: clip(after), restorable: false },
        reason: `Not comparable: ${why}`,
      },
    ],
  }
}

const OPS: ArtifactDiffOp[] = ['changed', 'added', 'removed', 'moved', 'renamed']

function plural(unit: string, n: number): string {
  if (n === 1) return unit
  if (unit === 'body') return 'bodies'
  if (/[^aeiou]y$/.test(unit)) return `${unit.slice(0, -1)}ies`
  if (/(s|x|ch|sh)$/.test(unit)) return `${unit}es`
  return `${unit}s`
}

function finish(kind: ArtifactKind, computed: Computed, cap: number): ArtifactDiff {
  // Value changes first; format-only cell changes after them (stable otherwise).
  const all = computed.entries.map((e) => e.change)
  const ordered = [...all.filter((c) => !c.formatOnly), ...all.filter((c) => c.formatOnly)]
  const counts: ArtifactDiff['counts'] = []
  const byUnit = new Map<string, ArtifactDiff['counts'][number]>()
  for (const change of ordered) {
    let row = byUnit.get(change.unit)
    if (!row) {
      row = { unit: change.unit, added: 0, removed: 0, changed: 0, moved: 0, renamed: 0 }
      byUnit.set(change.unit, row)
      counts.push(row)
    }
    row[change.op] += 1
  }
  const formatOnlyCount = ordered.filter((c) => c.formatOnly).length
  let summary: string
  if (!computed.ok && ordered.length > 0) summary = 'The whole body changed (the versions could not be compared structurally)'
  else if (ordered.length === 0) summary = 'No changes'
  else {
    summary = counts
      .map((row) => {
        const parts = OPS.filter((op) => row[op] > 0).map((op, i) => (i === 0 ? `${row[op]} ${plural(row.unit, row[op])} ${op}` : `${row[op]} ${op}`))
        const fmt = row.unit === 'cell' && formatOnlyCount > 0 ? ` (${formatOnlyCount} format only)` : ''
        return parts.join(', ') + fmt
      })
      .join('; ')
  }
  return {
    kind,
    ok: computed.ok,
    changes: ordered.slice(0, cap),
    omitted: Math.max(0, ordered.length - cap),
    counts,
    formatOnlyCount,
    summary,
  }
}

function bulletOf(change: ArtifactDiffChange): string {
  let line = `- ${change.op} ${change.label}`
  if (change.group && !change.label.includes(change.group)) line += ` (${oneLine(change.group, 60)})`
  if (change.fields && change.fields.length > 0) line += `: ${change.fields.join(', ')}`
  const b = change.before !== undefined ? oneLine(change.before, 80) : undefined
  const a = change.after !== undefined ? oneLine(change.after, 80) : undefined
  if (change.op === 'changed' || change.op === 'renamed') {
    if (b !== undefined && a !== undefined && (b || a)) line += ` — “${b}” → “${a}”`
  } else if (change.op === 'added' && a) line += ` — “${a}”`
  else if (change.op === 'removed' && b) line += ` — was “${b}”`
  return line
}

// ---------------------------------------------------------------------------------------------
// Alignment: LCS, hunks, longest increasing subsequence
// ---------------------------------------------------------------------------------------------

/** Index pairs of a longest common subsequence of `a` and `b`, or null above `maxCells`. */
function lcsPairs(a: readonly string[], b: readonly string[], maxCells: number): Array<[number, number]> | null {
  let prefix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1
  let suffix = 0
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix += 1
  const x = a.slice(prefix, a.length - suffix)
  const y = b.slice(prefix, b.length - suffix)
  const pairs: Array<[number, number]> = []
  for (let i = 0; i < prefix; i += 1) pairs.push([i, i])
  if (x.length > 0 && y.length > 0) {
    if ((x.length + 1) * (y.length + 1) > maxCells) return null
    const width = y.length + 1
    const table = new Uint32Array((x.length + 1) * width)
    for (let i = x.length - 1; i >= 0; i -= 1) {
      for (let j = y.length - 1; j >= 0; j -= 1) {
        table[i * width + j] = x[i] === y[j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1])
      }
    }
    let i = 0
    let j = 0
    while (i < x.length && j < y.length) {
      if (x[i] === y[j]) {
        pairs.push([prefix + i, prefix + j])
        i += 1
        j += 1
      } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) i += 1
      else j += 1
    }
  }
  for (let k = 0; k < suffix; k += 1) pairs.push([a.length - suffix + k, b.length - suffix + k])
  return pairs
}

/** The unmatched stretches between matched pairs: a[aStart..aEnd) became b[bStart..bEnd). */
type Hunk = { aStart: number; aEnd: number; bStart: number; bEnd: number }

function hunksOf(pairs: Array<[number, number]>, aLength: number, bLength: number): Hunk[] {
  const out: Hunk[] = []
  let pa = 0
  let pb = 0
  for (const [ia, ib] of [...pairs, [aLength, bLength] as [number, number]]) {
    if (ia > pa || ib > pb) out.push({ aStart: pa, aEnd: ia, bStart: pb, bEnd: ib })
    pa = ia + 1
    pb = ib + 1
  }
  return out
}

/** Indices (into `seq`) of one longest strictly increasing subsequence. O(n log n). */
function lisIndices(seq: readonly number[]): Set<number> {
  const tails: number[] = []
  const prev: number[] = new Array<number>(seq.length).fill(-1)
  for (let i = 0; i < seq.length; i += 1) {
    let lo = 0
    let hi = tails.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (seq[tails[mid]] < seq[i]) lo = mid + 1
      else hi = mid
    }
    if (lo > 0) prev[i] = tails[lo - 1]
    tails[lo] = i
  }
  const out = new Set<number>()
  let k = tails.length > 0 ? tails[tails.length - 1] : -1
  while (k >= 0) {
    out.add(k)
    k = prev[k]
  }
  return out
}

/** Ids present on both sides whose relative order changed (not in a longest kept order). */
function reorderedIds(beforeIds: readonly string[], afterIds: readonly string[]): Set<string> {
  const beforeIndex = new Map(beforeIds.map((id, i) => [id, i]))
  const common = afterIds.filter((id) => beforeIndex.has(id))
  const keep = lisIndices(common.map((id) => beforeIndex.get(id) ?? 0))
  return new Set(common.filter((_id, i) => !keep.has(i)))
}

// ---------------------------------------------------------------------------------------------
// Word diff
// ---------------------------------------------------------------------------------------------

export function wordDiff(before: string, after: string): DiffSegment[] {
  if (before === after) return before ? [{ op: 'same', text: before }] : []
  const a = before.match(/\s+|[^\s]+/g) ?? []
  const b = after.match(/\s+|[^\s]+/g) ?? []
  const pairs = lcsPairs(a, b, WORD_LCS_CELLS)
  const out: DiffSegment[] = []
  const push = (op: DiffSegment['op'], text: string) => {
    if (!text) return
    const last = out[out.length - 1]
    if (last && last.op === op) last.text += text
    else out.push({ op, text })
  }
  if (!pairs) {
    // Too big to align word by word: the common prefix and suffix, the middle replaced whole.
    let prefix = 0
    while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1
    let suffix = 0
    while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix += 1
    push('same', a.slice(0, prefix).join(''))
    push('del', a.slice(prefix, a.length - suffix).join(''))
    push('add', b.slice(prefix, b.length - suffix).join(''))
    push('same', a.slice(a.length - suffix).join(''))
    return out
  }
  let i = 0
  let j = 0
  for (const [pi, pj] of [...pairs, [a.length, b.length] as [number, number]]) {
    push('del', a.slice(i, pi).join(''))
    push('add', b.slice(j, pj).join(''))
    if (pi < a.length) push('same', a[pi])
    i = pi + 1
    j = pj + 1
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Keyed lists (slides, elements, data lists, boards, styles…)
// ---------------------------------------------------------------------------------------------

type ItemOp = 'added' | 'removed' | 'changed' | 'moved'
type ItemDiff = {
  id: string
  op: ItemOp
  before?: Obj
  after?: Obj
  beforeIndex: number
  afterIndex: number
  /** Changed keys; 'order' when its position among the kept items changed. */
  fields: string[]
}

/** Items in `before`/`after` (lists of objects keyed by `id`), in display order. Null when not keyable. */
function diffKeyed(before: unknown, after: unknown, options: { skip?: readonly string[]; geometry?: readonly string[] } = {}): ItemDiff[] | null {
  const bl = before === undefined ? [] : before
  const al = after === undefined ? [] : after
  if (!Array.isArray(bl) || !Array.isArray(al)) return null
  const bm = keyed(bl)
  const am = keyed(al)
  if (!bm || !am) return null
  const skip = new Set(options.skip ?? [])
  const geometry = new Set(options.geometry ?? [])
  const beforeIds = [...bm.keys()]
  const afterIds = [...am.keys()]
  const beforeAt = new Map(beforeIds.map((id, i) => [id, i]))
  const afterAt = new Map(afterIds.map((id, i) => [id, i]))
  const moved = reorderedIds(beforeIds, afterIds)
  const positioned: Array<{ pos: number; diff: ItemDiff }> = []
  afterIds.forEach((id, afterIndex) => {
    const a = am.get(id) as Obj
    const beforeIndex = beforeAt.get(id) ?? -1
    if (beforeIndex < 0) {
      positioned.push({ pos: afterIndex, diff: { id, op: 'added', after: a, beforeIndex: -1, afterIndex, fields: [] } })
      return
    }
    const b = bm.get(id) as Obj
    const fields = [...new Set([...Object.keys(b), ...Object.keys(a)])].filter((k) => !skip.has(k) && !deepEqual(b[k], a[k]))
    const reordered = moved.has(id)
    if (fields.length === 0 && !reordered) return
    const op: ItemOp = fields.every((f) => geometry.has(f)) ? 'moved' : 'changed'
    positioned.push({ pos: afterIndex, diff: { id, op, before: b, after: a, beforeIndex, afterIndex, fields: reordered ? [...fields, 'order'] : fields } })
  })
  beforeIds.forEach((id, beforeIndex) => {
    if (am.has(id)) return
    let pos = -0.5
    for (let k = beforeIndex - 1; k >= 0; k -= 1) {
      const at = afterAt.get(beforeIds[k])
      if (at !== undefined) {
        pos = at + 0.5
        break
      }
    }
    positioned.push({ pos, diff: { id, op: 'removed', before: bm.get(id) as Obj, beforeIndex, afterIndex: -1, fields: [] } })
  })
  return positioned.sort((x, y) => x.pos - y.pos).map((p) => p.diff)
}

/** Where an item goes back: after the nearest item that preceded it in `beforeIds` and `list` still holds. */
function placeIndex(list: readonly unknown[], beforeIds: readonly string[], id: string): number {
  const at = beforeIds.indexOf(id)
  for (let k = at - 1; k >= 0; k -= 1) {
    const found = list.findIndex((item) => idOf(item) === beforeIds[k])
    if (found >= 0) return found + 1
  }
  return 0
}

type ListAt = {
  /** The list in the current root, or why it cannot be reached. */
  get: (root: Obj, create: boolean) => unknown[] | string
  noun: string
}

type KeyedRestoreOptions = {
  /** The fewest items the list may keep (a deck's one slide). */
  min?: number
  /** A refusal for putting `item` (the old version) back into `root`. */
  checkPut?: (root: Obj, item: Obj) => string | null
  /** A refusal for taking item `id` out of `root`. */
  checkRemove?: (root: Obj, id: string) => string | null
  /** After taking item `id` out: the list's follow-up (a whiteboard drops arrows bound to it). */
  afterRemove?: (list: unknown[], id: string) => unknown[]
}

/** Restore one keyed item's old state: fields back, position back, re-inserted or taken out. */
function restoreKeyed(root: Obj, at: ListAt, d: ItemDiff, beforeIds: readonly string[], options: KeyedRestoreOptions = {}): string | null {
  const got = at.get(root, d.op === 'removed')
  if (typeof got === 'string') return got
  const list = got
  const index = list.findIndex((item) => idOf(item) === d.id)
  if (d.op === 'removed') {
    if (index >= 0) return `${at.noun} "${d.id}" is already in the current version`
    if (!d.before) return 'Nothing to put back'
    const refusal = options.checkPut?.(root, d.before) ?? null
    if (refusal) return refusal
    list.splice(placeIndex(list, beforeIds, d.id), 0, clone(d.before))
    return null
  }
  if (index < 0) return `${at.noun} "${d.id}" is no longer in the current version`
  if (d.op === 'added') {
    if (options.min !== undefined && list.length <= options.min) return `The last ${at.noun.toLowerCase()} cannot be removed`
    const refusal = options.checkRemove?.(root, d.id) ?? null
    if (refusal) return refusal
    list.splice(index, 1)
    if (options.afterRemove) {
      const next = options.afterRemove(list, d.id)
      list.splice(0, list.length, ...next)
    }
    return null
  }
  // changed / moved: the changed fields back, then the position.
  const item = list[index]
  if (!isObj(item) || !d.before) return `${at.noun} "${d.id}" is not an object`
  for (const field of d.fields) {
    if (field === 'order') continue
    if (has(d.before, field)) item[field] = clone(d.before[field])
    else delete item[field]
  }
  const refusal = options.checkPut?.(root, item) ?? null
  if (refusal) return refusal
  if (d.fields.includes('order')) {
    list.splice(index, 1)
    list.splice(placeIndex(list, beforeIds, d.id), 0, item)
  }
  return null
}

const idsOf = (list: unknown): string[] => (Array.isArray(list) ? list.map(idOf).filter((id): id is string => id !== null) : [])

/** A list field on the root (`root[key]`). */
const rootList = (key: string, noun: string): ListAt => ({
  noun,
  get: (root, create) => {
    if (root[key] === undefined && create) root[key] = []
    const list = root[key]
    return Array.isArray(list) ? list : `The current version has no ${key}`
  },
})

const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

/** Top-level fields outside the kind's units: the title, then any other setting. */
function topLevel(b: Obj, a: Obj, skip: readonly string[], c: Collector) {
  const skipped = new Set(skip)
  for (const key of [...new Set([...Object.keys(b), ...Object.keys(a)])]) {
    if (skipped.has(key) || deepEqual(b[key], a[key])) continue
    const op: ArtifactDiffOp = !has(b, key) ? 'added' : !has(a, key) ? 'removed' : 'changed'
    const restore = jsonRestorer((root) => {
      if (has(b, key)) root[key] = clone(b[key])
      else delete root[key]
      return null
    })
    const isTitle = key === 'title'
    c.add(
      {
        id: isTitle ? 'title' : `setting:${key}`,
        unit: isTitle ? 'title' : 'setting',
        op,
        label: isTitle ? 'Title' : capitalise(key.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()),
        ...textual(has(b, key) ? show(b[key]) : op === 'added' ? undefined : '', has(a, key) ? show(a[key]) : op === 'removed' ? undefined : ''),
      },
      restore,
    )
  }
}

/** The change texts of one keyed item. */
function itemText(d: ItemDiff, render?: (key: string, value: unknown) => string) {
  if (d.op === 'added') return textual(undefined, renderItem(d.after))
  if (d.op === 'removed') return textual(renderItem(d.before), undefined)
  const fields = d.fields.filter((f) => f !== 'order')
  if (fields.length === 0) return {}
  return textual(renderFields(d.before, fields, render) ?? '', renderFields(d.after, fields, render) ?? '')
}

const itemFields = (d: ItemDiff) => (d.op === 'changed' || d.op === 'moved' ? { fields: d.fields } : {})

// ---------------------------------------------------------------------------------------------
// Doc
// ---------------------------------------------------------------------------------------------

function blockLabel(source: string, index: number): string {
  const first = source.split('\n')[0] ?? ''
  const heading = /^ {0,3}#{1,6}\s+(.*)$/.exec(first)
  if (heading) return `Heading${quoted(heading[1].replace(/#+\s*$/, ''))}`
  const n = index + 1
  if (/^\s*(```|~~~)/.test(first)) return `Code block ${n}`
  if (/^\s*\|/.test(first)) return `Table ${n}`
  if (/^\s*([-*+]|\d+[.)])\s/.test(first)) return `List ${n}`
  if (/^\s*>/.test(first)) return `Quote ${n}`
  if (/^\s*!\[/.test(first)) return `Image ${n}`
  return `Paragraph ${n}`
}

function docRestorer(plan: (blocks: readonly string[]) => DocBlockEdit | string): Restorer {
  return (current) => {
    const { content, suggestions } = splitDocSuggestions(current)
    const edit = plan(splitBlocks(content))
    if (typeof edit === 'string') return fail(edit)
    const next = applyDocBodyEdit(content, edit)
    if (next === null) return fail('The block changed again and cannot be restored')
    if (next === content) return fail('Nothing to restore: the current version already has the old text')
    const records = carryDocBlockIds(content, suggestions, edit, next)
    if (records === null) return fail('Restoring this block would change the surrounding blocks')
    return { ok: true, body: joinDocSuggestions(next, records) }
  }
}

const occurrences = (blocks: readonly string[], source: string) =>
  blocks.reduce<number[]>((out, block, i) => (block === source ? [...out, i] : out), [])

/** The one index of `source` in `blocks`, or a refusal. */
function uniqueBlock(blocks: readonly string[], source: string, what: string): number | string {
  const found = occurrences(blocks, source)
  if (found.length === 0) return `${what} is no longer in the current version`
  if (found.length > 1) return `${what} appears more than once in the current version`
  return found[0]
}

function diffDoc(before: string, after: string, c: Collector) {
  const bb = splitBlocks(splitDocSuggestions(before).content)
  const ab = splitBlocks(splitDocSuggestions(after).content)
  const pairs = lcsPairs(bb, ab, ALIGN_LCS_CELLS)
  if (!pairs) {
    c.add(
      { id: 'body', unit: 'body', op: 'changed', label: 'Whole document', ...textual(clip(before), clip(after)) },
      (current) => (current === after ? { ok: true, body: before } : fail('The document changed again since; it is too long to restore block by block')),
    )
    return
  }
  const bTabs = docTabs(bb)
  const aTabs = docTabs(ab)
  const groupOf = (tabs: DocTab[], index: number) => {
    const tab = tabs.length > 1 ? tabOfBlock(tabs, index) : undefined
    return tab ? { group: tab.name } : {}
  }
  const tabIdAt = (tabs: DocTab[], marker: number) => tabs.find((t) => t.marker === marker)?.id ?? String(marker + 1)

  const removedRestore = (bi: number) =>
    docRestorer((blocks) => {
      const source = bb[bi]
      if (bi === 0) {
        if (blocks[0] === source) return 'That block is already back'
        return { index: 0, span: 0, before: '', after: source }
      }
      const anchor = occurrences(blocks, bb[bi - 1])
      if (anchor.length === 1) {
        if (blocks[anchor[0] + 1] === source) return 'That block is already back'
        return { index: anchor[0] + 1, span: 0, before: '', after: source }
      }
      const following = bi + 1 < bb.length ? occurrences(blocks, bb[bi + 1]) : []
      if (following.length === 1) {
        if (blocks[following[0] - 1] === source) return 'That block is already back'
        return { index: following[0], span: 0, before: '', after: source }
      }
      return 'The blocks around it changed since; it cannot be placed back'
    })
  const addedRestore = (ai: number, what: string) =>
    docRestorer((blocks) => {
      const at = uniqueBlock(blocks, ab[ai], what)
      if (typeof at === 'string') return at
      return { index: at, before: blocks[at], after: '' }
    })
  const changedRestore = (bi: number, ai: number, what: string) =>
    docRestorer((blocks) => {
      const at = uniqueBlock(blocks, ab[ai], what)
      if (typeof at === 'string') return at
      return { index: at, before: blocks[at], after: bb[bi] }
    })

  for (const h of hunksOf(pairs, bb.length, ab.length)) {
    const removed: number[] = []
    const added: number[] = []
    const removedTabs: number[] = []
    const addedTabs: number[] = []
    for (let i = h.aStart; i < h.aEnd; i += 1) (parseTabMarker(bb[i]) !== null ? removedTabs : removed).push(i)
    for (let j = h.bStart; j < h.bEnd; j += 1) (parseTabMarker(ab[j]) !== null ? addedTabs : added).push(j)
    // Tab markers: paired by position within the hunk (a renamed tab's marker changed text).
    const tabPairs = Math.min(removedTabs.length, addedTabs.length)
    for (let k = 0; k < Math.max(removedTabs.length, addedTabs.length); k += 1) {
      const bi = removedTabs[k]
      const ai = addedTabs[k]
      const oldName = bi !== undefined ? parseTabMarker(bb[bi]) ?? '' : ''
      const newName = ai !== undefined ? parseTabMarker(ab[ai]) ?? '' : ''
      if (k < tabPairs) {
        c.add(
          { id: `tab:${tabIdAt(aTabs, ai)}`, unit: 'tab', op: 'renamed', label: `Tab${quoted(newName)}`, ...textual(oldName, newName) },
          changedRestore(bi, ai, `Tab “${newName}”`),
        )
      } else if (ai !== undefined) {
        c.add({ id: `tab:${tabIdAt(aTabs, ai)}`, unit: 'tab', op: 'added', label: `Tab${quoted(newName)}`, ...textual(undefined, newName) }, addedRestore(ai, `Tab “${newName}”`))
      } else if (bi !== undefined) {
        c.add({ id: `tab:${tabIdAt(bTabs, bi)}-removed`, unit: 'tab', op: 'removed', label: `Tab${quoted(oldName)}`, ...textual(oldName, undefined) }, removedRestore(bi))
      }
    }
    const blockPairs = Math.min(removed.length, added.length)
    for (let k = 0; k < Math.max(removed.length, added.length); k += 1) {
      const bi = removed[k]
      const ai = added[k]
      if (k < blockPairs) {
        const label = blockLabel(ab[ai], ai)
        c.add(
          { id: `block:${ai + 1}`, unit: 'block', op: 'changed', label, ...textual(bb[bi], ab[ai]), ...groupOf(aTabs, ai) },
          changedRestore(bi, ai, label),
        )
      } else if (ai !== undefined) {
        const label = blockLabel(ab[ai], ai)
        c.add({ id: `block:${ai + 1}`, unit: 'block', op: 'added', label, ...textual(undefined, ab[ai]), ...groupOf(aTabs, ai) }, addedRestore(ai, label))
      } else if (bi !== undefined) {
        c.add(
          { id: `block:${bi + 1}-removed`, unit: 'block', op: 'removed', label: blockLabel(bb[bi], bi), ...textual(bb[bi], undefined), ...groupOf(bTabs, bi) },
          removedRestore(bi),
        )
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Slides
// ---------------------------------------------------------------------------------------------

type JsonDiff = (b: Obj, a: Obj, c: Collector, ctx: Ctx) => void

function slideLabel(slide: Obj | undefined, index: number): string {
  const title = slide && typeof slide.title === 'string' ? slide.title : undefined
  return `Slide ${index + 1}${quoted(title)}`
}

const SLIDE_ELEMENT_NAMES: Record<string, string> = { text: 'Text box', rect: 'Rectangle', ellipse: 'Ellipse', line: 'Line', arrow: 'Arrow', image: 'Image' }

function slideElementLabel(el: Obj | undefined): string {
  const type = el && typeof el.type === 'string' ? el.type : 'element'
  const text = el && typeof el.text === 'string' ? el.text : el && typeof el.alt === 'string' ? el.alt : undefined
  return `${SLIDE_ELEMENT_NAMES[type] ?? capitalise(type)}${quoted(text)}`
}

const slidesAt = rootList('slides', 'Slide')

const elementsOf = (slideId: string): ListAt => ({
  noun: 'Element',
  get: (root, create) => {
    const slides = root.slides
    if (!Array.isArray(slides)) return 'The current version has no slides'
    const slide = slides.find((s) => idOf(s) === slideId)
    if (!isObj(slide)) return `Slide "${slideId}" is no longer in the current version`
    if (slide.elements === undefined && create) slide.elements = []
    return Array.isArray(slide.elements) ? slide.elements : `Slide "${slideId}" has no elements`
  },
})

const diffSlides: JsonDiff = (b, a, c) => {
  topLevel(b, a, ['slides'], c)
  const items = diffKeyed(b.slides, a.slides, { skip: ['elements'] })
  if (!items) throw new NotComparable()
  const beforeIds = idsOf(b.slides)
  const labelOf = (d: ItemDiff) => slideLabel(d.after ?? d.before, d.op === 'removed' ? d.beforeIndex : d.afterIndex)
  for (const d of items) {
    c.add(
      { id: `slide:${d.id}`, unit: 'slide', op: d.op, label: labelOf(d), ...itemFields(d), ...itemText(d) },
      jsonRestorer((root) => restoreKeyed(root, slidesAt, d, beforeIds, { min: 1 })),
    )
  }
  // Elements of the slides both versions hold.
  const bSlides = keyed(Array.isArray(b.slides) ? b.slides : [])
  const aSlides = Array.isArray(a.slides) ? a.slides : []
  aSlides.forEach((slide, index) => {
    const id = idOf(slide)
    if (!id || !isObj(slide)) return
    const old = bSlides?.get(id)
    if (!isObj(old)) return
    const elements = diffKeyed(old.elements, slide.elements, { geometry: ['x', 'y'] })
    if (!elements) throw new NotComparable()
    const group = slideLabel(slide, index)
    const elementIds = idsOf(old.elements)
    for (const d of elements) {
      c.add(
        { id: `element:${id}/${d.id}`, unit: 'element', op: d.op, label: slideElementLabel(d.after ?? d.before), group, ...itemFields(d), ...itemText(d) },
        jsonRestorer((root) => restoreKeyed(root, elementsOf(id), d, elementIds)),
      )
    }
  })
}

// ---------------------------------------------------------------------------------------------
// Sheet
// ---------------------------------------------------------------------------------------------

/** A formula with its A1 references blanked, so a row insert's reference shifts still match. */
const normalizeFormula = (f: string) => f.replace(/\$?\b[A-Z]{1,3}\$?\d+\b/g, '#')

const cellValueKey = (cell: unknown): string => {
  if (!isObj(cell)) return ''
  if (typeof cell.f === 'string') return `f${normalizeFormula(cell.f)}`
  if (cell.v === undefined || cell.v === '') return ''
  return `v${typeof cell.v}:${String(cell.v)}`
}

const cellText = (cell: unknown): string => {
  if (!isObj(cell)) return ''
  if (typeof cell.f === 'string') return cell.f
  return cell.v === undefined ? '' : String(cell.v)
}

/** v/f/runs equal; in a shifted tab, formulas equal up to their references. */
function sameCellValue(b: Obj | undefined, a: Obj | undefined, shifted: boolean): boolean {
  const pick = (cell: Obj | undefined) => {
    const out: Obj = {}
    if (cell) for (const k of CELL_VALUE) if (has(cell, k)) out[k] = cell[k]
    return out
  }
  const [pb, pa] = [pick(b), pick(a)]
  if (deepEqual(pb, pa)) return true
  if (!shifted || typeof pb.f !== 'string' || typeof pa.f !== 'string') return false
  return normalizeFormula(pb.f) === normalizeFormula(pa.f) && deepEqual({ ...pb, f: '' }, { ...pa, f: '' })
}

type Grid = { cells: Map<string, Obj>; at: Map<number, Map<number, Obj>>; rows: number; cols: number }

function gridOf(cells: unknown): Grid {
  const out: Grid = { cells: new Map(), at: new Map(), rows: 0, cols: 0 }
  if (!isObj(cells)) return out
  for (const [address, cell] of Object.entries(cells)) {
    const pos = parseAddress(address)
    if (!pos || !isObj(cell)) continue
    out.cells.set(address, cell)
    let row = out.at.get(pos.row)
    if (!row) out.at.set(pos.row, (row = new Map()))
    row.set(pos.col, cell)
    out.rows = Math.max(out.rows, pos.row + 1)
    out.cols = Math.max(out.cols, pos.col + 1)
  }
  return out
}

type LineAlign = { map: Map<number, number>; inserted: number[]; deleted: number[] }

/** Align two signature lists (rows or columns), padded to one length; blank extras are dropped. */
function alignLines(bSigs: string[], aSigs: string[]): LineAlign {
  const n = Math.max(bSigs.length, aSigs.length)
  const pad = (sigs: string[]) => [...sigs, ...new Array<string>(n - sigs.length).fill('')]
  const [bs, as] = [pad(bSigs), pad(aSigs)]
  const map = new Map<number, number>()
  const inserted: number[] = []
  const deleted: number[] = []
  const pairs = lcsPairs(bs, as, ALIGN_LCS_CELLS)
  if (!pairs) {
    for (let i = 0; i < n; i += 1) map.set(i, i)
    return { map, inserted, deleted }
  }
  for (const [i, j] of pairs) map.set(i, j)
  for (const h of hunksOf(pairs, n, n)) {
    const matched = pairWithin(bs, as, h)
    const left = new Set(matched.map(([i]) => i))
    const right = new Set(matched.map(([, j]) => j))
    for (const [i, j] of matched) map.set(i, j)
    for (let i = h.aStart; i < h.aEnd; i += 1) if (!left.has(i) && bs[i] !== '') deleted.push(i)
    for (let j = h.bStart; j < h.bEnd; j += 1) if (!right.has(j) && as[j] !== '') inserted.push(j)
  }
  return { map, inserted, deleted }
}

/**
 * Which lines of a hunk are the same line edited. As many on each side: by position (edits in
 * place). Otherwise the order-keeping pairing sharing the most cells, so deleting row 2 and
 * editing row 3 pairs the old row 3 with the new row 2, not row 2 with it.
 */
function pairWithin(bs: readonly string[], as: readonly string[], h: Hunk): Array<[number, number]> {
  const dels = h.aEnd - h.aStart
  const adds = h.bEnd - h.bStart
  const out: Array<[number, number]> = []
  if (dels === adds || dels * adds > WORD_LCS_CELLS) {
    for (let k = 0; k < Math.min(dels, adds); k += 1) out.push([h.aStart + k, h.bStart + k])
    return out
  }
  const parts = (sig: string) => new Set(sig ? sig.split('\u0001') : [])
  const bp = Array.from({ length: dels }, (_v, i) => parts(bs[h.aStart + i]))
  const ap = Array.from({ length: adds }, (_v, j) => parts(as[h.bStart + j]))
  const sim = (i: number, j: number) => {
    let n = 0
    for (const p of bp[i]) if (ap[j].has(p)) n += 1
    return n
  }
  const width = adds + 1
  const best = new Float64Array((dels + 1) * width)
  for (let i = dels - 1; i >= 0; i -= 1) {
    for (let j = adds - 1; j >= 0; j -= 1) {
      const s = sim(i, j)
      best[i * width + j] = Math.max(best[(i + 1) * width + j], best[i * width + j + 1], s > 0 ? best[(i + 1) * width + j + 1] + s : 0)
    }
  }
  let i = 0
  let j = 0
  while (i < dels && j < adds) {
    const s = sim(i, j)
    if (s > 0 && best[i * width + j] === best[(i + 1) * width + j + 1] + s) {
      out.push([h.aStart + i, h.bStart + j])
      i += 1
      j += 1
    } else if (best[(i + 1) * width + j] >= best[i * width + j + 1]) i += 1
    else j += 1
  }
  return out
}

type TabAlign = { rows: LineAlign; cols: LineAlign; shifted: boolean }

function alignTab(b: Grid, a: Grid): TabAlign {
  const rowSig = (g: Grid, r: number) => {
    const row = g.at.get(r)
    if (!row) return ''
    return [...row.entries()]
      .map(([col, cell]) => [col, cellValueKey(cell)] as const)
      .filter(([, key]) => key !== '')
      .sort((x, y) => x[0] - y[0])
      .map(([col, key]) => `${col}=${key}`)
      .join('\u0001')
  }
  const rows = alignLines(
    Array.from({ length: b.rows }, (_v, r) => rowSig(b, r)),
    Array.from({ length: a.rows }, (_v, r) => rowSig(a, r)),
  )
  // Columns by their content on the rows both sides hold (keyed by the after row).
  const colSig = (g: Grid, c: number, rowKey: (r: number) => number | undefined) => {
    const parts: string[] = []
    for (const [r, row] of g.at) {
      const key = rowKey(r)
      const cell = row.get(c)
      if (key === undefined || !cell) continue
      const value = cellValueKey(cell)
      if (value) parts.push(`${key}=${value}`)
    }
    return parts.sort().join('\u0001')
  }
  const mappedAfter = new Set(rows.map.values())
  const cols = alignLines(
    Array.from({ length: b.cols }, (_v, c) => colSig(b, c, (r) => rows.map.get(r))),
    Array.from({ length: a.cols }, (_v, c) => colSig(a, c, (r) => (mappedAfter.has(r) ? r : undefined))),
  )
  const moved = (line: LineAlign) => line.inserted.length > 0 || line.deleted.length > 0 || [...line.map].some(([i, j]) => i !== j)
  return { rows, cols, shifted: moved(rows) || moved(cols) }
}

const tabsAt = rootList('tabs', 'Tab')

function tabNameTaken(root: Obj, name: unknown, exceptId: string): boolean {
  if (typeof name !== 'string' || !Array.isArray(root.tabs)) return false
  return root.tabs.some((t) => isObj(t) && t.id !== exceptId && typeof t.name === 'string' && t.name.toLowerCase() === name.toLowerCase())
}

function rowText(g: Grid, r: number, colMap?: (c: number) => number): string {
  const row = g.at.get(r)
  if (!row) return ''
  return [...row.entries()]
    .sort((x, y) => x[0] - y[0])
    .map(([col, cell]) => `${toAddress({ row: r, col: colMap ? colMap(col) : col })}: ${cellText(cell)}`)
    .join(' | ')
}

function colText(g: Grid, col: number): string {
  const parts: string[] = []
  for (const r of [...g.at.keys()].sort((x, y) => x - y)) {
    const cell = g.at.get(r)?.get(col)
    if (cell) parts.push(`${toAddress({ row: r, col })}: ${cellText(cell)}`)
  }
  return parts.join(' | ')
}

const diffSheet: JsonDiff = (b, a, c) => {
  topLevel(b, a, ['tabs', 'revision', 'deletedTabs'], c)
  const items = diffKeyed(b.tabs, a.tabs, { skip: ['cells'] })
  if (!items) throw new NotComparable()
  const beforeIds = idsOf(b.tabs)
  const nameOf = (tab: Obj | undefined, id: string) => (tab && typeof tab.name === 'string' ? tab.name : id)
  const checkName = (root: Obj, item: Obj) =>
    tabNameTaken(root, item.name, String(item.id)) ? `Another tab is already named “${String(item.name)}”` : null

  for (const d of items) {
    const name = nameOf(d.after ?? d.before, d.id)
    if (d.op === 'added' || d.op === 'removed') {
      const count = (tab: Obj | undefined) => (tab && isObj(tab.cells) ? Object.keys(tab.cells).length : 0)
      const text = (tab: Obj | undefined) => `${nameOf(tab, d.id)} (${count(tab)} cells)`
      c.add(
        {
          id: `tab:${d.id}`,
          unit: 'tab',
          op: d.op,
          label: `Tab${quoted(name)}`,
          ...(d.op === 'added' ? textual(undefined, text(d.after)) : textual(text(d.before), undefined)),
        },
        jsonRestorer((root) =>
          restoreKeyed(root, tabsAt, d, beforeIds, {
            min: 1,
            checkPut: checkName,
            checkRemove: (r, id) =>
              Array.isArray(r.names) && r.names.some((n) => isObj(n) && n.tab === id) ? 'A defined name still points at that tab' : null,
          }),
        ),
      )
      continue
    }
    // A tab both hold: its name and place, then its other settings, then its cells.
    const renamed = d.fields.includes('name')
    const ordered = d.fields.includes('order')
    if (renamed || ordered) {
      const sub: ItemDiff = { ...d, fields: d.fields.filter((f) => f === 'name' || f === 'order') }
      c.add(
        {
          id: `tab:${d.id}`,
          unit: 'tab',
          op: renamed ? 'renamed' : 'moved',
          label: `Tab${quoted(name)}`,
          fields: sub.fields,
          ...(renamed ? textual(nameOf(d.before, d.id), name) : {}),
        },
        jsonRestorer((root) => restoreKeyed(root, tabsAt, sub, beforeIds, { checkPut: checkName })),
      )
    }
    const settings = d.fields.filter((f) => f !== 'name' && f !== 'order')
    if (settings.length > 0) {
      const sub: ItemDiff = { ...d, op: 'changed', fields: settings }
      c.add(
        { id: `format:${d.id}`, unit: 'format', op: 'changed', label: `Layout of tab${quoted(name)}`, group: name, fields: settings, ...itemText(sub) },
        jsonRestorer((root) => restoreKeyed(root, tabsAt, sub, beforeIds)),
      )
    }
  }

  const bTabs = keyed(Array.isArray(b.tabs) ? b.tabs : [])
  for (const tab of Array.isArray(a.tabs) ? a.tabs : []) {
    const id = idOf(tab)
    const old = id ? bTabs?.get(id) : undefined
    if (!id || !isObj(tab) || !isObj(old)) continue
    diffTabCells(id, nameOf(tab, id), old.cells, tab.cells, c)
  }
}

function diffTabCells(tabId: string, tabName: string, beforeCells: unknown, afterCells: unknown, c: Collector) {
  if (deepEqual(beforeCells, afterCells)) return
  const bg = gridOf(beforeCells)
  const ag = gridOf(afterCells)
  const align = alignTab(bg, ag)
  const group = tabName
  const notAlone = 'Rows or columns of this tab were inserted or deleted between the versions'

  for (const r of align.rows.inserted) {
    c.add({ id: `row:${tabId}:${r + 1}`, unit: 'row', op: 'added', label: `Row ${r + 1}`, group, ...textual(undefined, rowText(ag, r)) }, undefined, notAlone)
  }
  for (const r of align.rows.deleted) {
    c.add({ id: `row:${tabId}:${r + 1}-removed`, unit: 'row', op: 'removed', label: `Row ${r + 1}`, group, ...textual(rowText(bg, r), undefined) }, undefined, notAlone)
  }
  for (const col of align.cols.inserted) {
    c.add({ id: `column:${tabId}:${colName(col)}`, unit: 'column', op: 'added', label: `Column ${colName(col)}`, group, ...textual(undefined, colText(ag, col)) }, undefined, notAlone)
  }
  for (const col of align.cols.deleted) {
    c.add(
      { id: `column:${tabId}:${colName(col)}-removed`, unit: 'column', op: 'removed', label: `Column ${colName(col)}`, group, ...textual(colText(bg, col), undefined) },
      undefined,
      notAlone,
    )
  }

  // Cells on rows and columns both sides hold, before-address → after-address.
  const pairs: Array<{ from: string; to: string; b?: Obj; a?: Obj }> = []
  const seen = new Set<string>()
  for (const [address, cell] of bg.cells) {
    const pos = parseAddress(address)
    if (!pos) continue
    const row = align.rows.map.get(pos.row)
    const col = align.cols.map.get(pos.col)
    if (row === undefined || col === undefined) continue
    const to = toAddress({ row, col })
    seen.add(to)
    pairs.push({ from: address, to, b: cell, a: ag.cells.get(to) })
  }
  const rowsBack = new Map([...align.rows.map].map(([i, j]) => [j, i]))
  const colsBack = new Map([...align.cols.map].map(([i, j]) => [j, i]))
  for (const [address, cell] of ag.cells) {
    if (seen.has(address)) continue
    const pos = parseAddress(address)
    if (!pos) continue
    const row = rowsBack.get(pos.row)
    const col = colsBack.get(pos.col)
    if (row === undefined || col === undefined) continue
    pairs.push({ from: toAddress({ row, col }), to: address, a: cell })
  }
  pairs.sort((x, y) => {
    const [px, py] = [parseAddress(x.to), parseAddress(y.to)]
    return (px?.row ?? 0) - (py?.row ?? 0) || (px?.col ?? 0) - (py?.col ?? 0)
  })

  for (const p of pairs) {
    if (deepEqual(p.b, p.a)) continue
    const valueSame = sameCellValue(p.b, p.a, align.shifted)
    const formatKeys = [...new Set([...Object.keys(p.b ?? {}), ...Object.keys(p.a ?? {})])].filter(
      (k) => !(CELL_VALUE as readonly string[]).includes(k) && !deepEqual(p.b?.[k], p.a?.[k]),
    )
    if (valueSame && formatKeys.length === 0) continue
    // Formatting a blank cell (or clearing a blank cell's format) is format-only too.
    const formatOnly = valueSame
    const op: ArtifactDiffOp = formatOnly ? 'changed' : p.b === undefined ? 'added' : p.a === undefined ? 'removed' : 'changed'
    const label = `Cell ${tabName}!${p.to}`
    const texts = formatOnly
      ? textual(renderFields(p.b, formatKeys) ?? '', renderFields(p.a, formatKeys) ?? '')
      : {
          ...(p.b !== undefined ? { before: clip(cellText(p.b)) } : {}),
          ...(p.a !== undefined ? { after: clip(cellText(p.a)) } : {}),
          ...(typeof p.b?.v === 'string' && typeof p.a?.v === 'string' ? { words: wordDiff(clip(p.b.v), clip(p.a.v)) } : {}),
        }
    const input: ChangeInput = {
      id: `cell:${tabId}!${p.to}`,
      unit: 'cell',
      op,
      label,
      group,
      ...texts,
      ...(formatOnly ? { formatOnly: true, fields: formatKeys } : {}),
    }
    if (align.shifted) {
      c.add(input, undefined, notAlone)
      continue
    }
    const address = p.to
    const old = p.b
    const afterTab = afterCells
    c.add(
      input,
      jsonRestorer((root) => {
        const tabs = root.tabs
        const tab = Array.isArray(tabs) ? tabs.find((t) => idOf(t) === tabId) : undefined
        if (!isObj(tab)) return `Tab “${tabName}” is no longer in the current version`
        if (!isObj(tab.cells)) tab.cells = {}
        const cells = tab.cells as Obj
        if (alignTab(gridOf(afterTab), gridOf(cells)).shifted) return `Rows or columns of tab “${tabName}” moved since; restore by hand`
        if (old === undefined) delete cells[address]
        else cells[address] = clone(old)
        return null
      }),
    )
  }
}

// ---------------------------------------------------------------------------------------------
// Data (dashboards)
// ---------------------------------------------------------------------------------------------

const DATA_LISTS = [
  { key: 'sources', unit: 'source', noun: 'Source', min: 1 },
  { key: 'datasets', unit: 'dataset', noun: 'Dataset', min: 0 },
  { key: 'blocks', unit: 'block', noun: 'Block', min: 1 },
  { key: 'filters', unit: 'filter', noun: 'Filter', min: 0 },
  { key: 'params', unit: 'param', noun: 'Parameter', min: 0 },
] as const

const BLOCK_KIND_NAMES: Record<string, string> = { kpi: 'KPI', chart: 'Chart', table: 'Table', text: 'Text', section: 'Section' }

function dataLabel(unit: string, noun: string, item: Obj | undefined, id: string): string {
  const text = (['label', 'title', 'markdown'] as const).map((k) => item?.[k]).find((v): v is string => typeof v === 'string' && v !== '')
  if (unit === 'block') {
    const kind = item && typeof item.kind === 'string' ? item.kind : 'block'
    return `${BLOCK_KIND_NAMES[kind] ?? capitalise(kind)} block${quoted(text ?? id)}`
  }
  return `${noun}${quoted(text ?? id)}`
}

/** Ids a dashboard item points at: its source, its dataset(s). */
function dataRefs(item: Obj): Array<{ list: 'sources' | 'datasets'; id: string }> {
  const out: Array<{ list: 'sources' | 'datasets'; id: string }> = []
  if (typeof item.sourceId === 'string') out.push({ list: 'sources', id: item.sourceId })
  if (typeof item.datasetId === 'string') out.push({ list: 'datasets', id: item.datasetId })
  if (Array.isArray(item.datasetIds)) for (const id of item.datasetIds) if (typeof id === 'string') out.push({ list: 'datasets', id })
  return out
}

function dataCheckPut(root: Obj, item: Obj): string | null {
  for (const ref of dataRefs(item)) {
    if (!idsOf(root[ref.list]).includes(ref.id)) return `It needs ${ref.list === 'sources' ? 'source' : 'dataset'} "${ref.id}", which the current version does not have`
  }
  return null
}

function dataCheckRemove(listKey: string) {
  return (root: Obj, id: string): string | null => {
    if (listKey !== 'sources' && listKey !== 'datasets') return null
    for (const key of ['datasets', 'blocks', 'filters']) {
      const list = root[key]
      if (!Array.isArray(list)) continue
      for (const item of list) {
        if (isObj(item) && idOf(item) !== id && dataRefs(item).some((ref) => ref.list === listKey && ref.id === id)) {
          return `${capitalise(key.slice(0, -1))} "${String(item.id)}" still uses it`
        }
      }
    }
    return null
  }
}

/** A dataset's row-count delta and a few changed rows, matched by its key columns or `id`. */
function datasetDetail(b: Obj, a: Obj, samples: number): string[] {
  const bRows = Array.isArray(b.rows) ? b.rows : []
  const aRows = Array.isArray(a.rows) ? a.rows : []
  if (deepEqual(bRows, aRows)) return []
  const out = [`rows ${bRows.length} → ${aRows.length}`]
  if (samples <= 0) return out
  const keyCols = (Array.isArray(a.key) ? a.key : Array.isArray(b.key) ? b.key : null)?.filter((k): k is string => typeof k === 'string')
  const columns = Array.isArray(a.columns) ? a.columns : []
  const hasId = columns.some((col) => isObj(col) && col.key === 'id')
  const cols = keyCols && keyCols.length > 0 ? keyCols : hasId ? ['id'] : null
  const keyOf = (row: unknown, index: number) =>
    cols ? cols.map((k) => `${k}=${isObj(row) ? show(row[k]) : ''}`).join(', ') : `${index + 1}`
  const bm = new Map(bRows.map((row, i) => [keyOf(row, i), row]))
  const am = new Map(aRows.map((row, i) => [keyOf(row, i), row]))
  const lines: string[] = []
  for (const [key, row] of am) {
    if (lines.length >= samples) break
    const old = bm.get(key)
    if (old === undefined) {
      lines.push(`row ${key} added`)
      continue
    }
    if (deepEqual(old, row) || !isObj(old) || !isObj(row)) continue
    const diffs = [...new Set([...Object.keys(old), ...Object.keys(row)])]
      .filter((k) => !deepEqual(old[k], row[k]))
      .map((k) => `${k} ${show(old[k] ?? null)} → ${show(row[k] ?? null)}`)
    lines.push(`row ${key}: ${diffs.join(', ')}`)
  }
  for (const key of bm.keys()) {
    if (lines.length >= samples) break
    if (!am.has(key)) lines.push(`row ${key} removed`)
  }
  return [...out, ...lines.map((line) => clip(line, 300))]
}

const diffData: JsonDiff = (b, a, c, ctx) => {
  topLevel(b, a, DATA_LISTS.map((l) => l.key), c)
  for (const spec of DATA_LISTS) {
    const items = diffKeyed(b[spec.key], a[spec.key])
    if (!items) throw new NotComparable()
    const beforeIds = idsOf(b[spec.key])
    const at = rootList(spec.key, spec.noun)
    const render = (key: string, value: unknown) => (key === 'rows' && Array.isArray(value) ? `${value.length} rows` : show(value))
    for (const d of items) {
      const detail = spec.unit === 'dataset' && d.before && d.after ? datasetDetail(d.before, d.after, ctx.rowSamples) : []
      c.add(
        {
          id: `${spec.unit}:${d.id}`,
          unit: spec.unit,
          op: d.op,
          label: dataLabel(spec.unit, spec.noun, d.after ?? d.before, d.id),
          ...itemFields(d),
          ...(d.op === 'added' || d.op === 'removed' ? itemText(d) : itemText(d, render)),
          ...(detail.length > 0 ? { detail } : {}),
        },
        jsonRestorer((root) =>
          restoreKeyed(root, at, d, beforeIds, { min: spec.min, checkPut: dataCheckPut, checkRemove: dataCheckRemove(spec.key) }),
        ),
      )
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Whiteboard
// ---------------------------------------------------------------------------------------------

// re-derived from artifact-merge.ts, not exported there
/** `elements` with arrows bound to `gone` removed and stickers attached to `gone` detached. */
const WB_NAMES: Record<string, string> = {
  note: 'Note',
  shape: 'Shape',
  text: 'Text',
  section: 'Section',
  arrow: 'Connector',
  stroke: 'Drawing',
  image: 'Image',
  sticker: 'Sticker',
  table: 'Table',
  link: 'Link',
}

function whiteboardLabel(el: Obj | undefined, id: string): string {
  const type = el && typeof el.type === 'string' ? el.type : 'element'
  const name = WB_NAMES[type] ?? capitalise(type)
  if (type === 'arrow' && el) {
    if (typeof el.label === 'string' && el.label) return `${name}${quoted(el.label)}`
    const from = boundId(el.from)
    const to = boundId(el.to)
    return from || to ? `${name} ${from ?? 'point'} → ${to ?? 'point'}` : `${name} ${id}`
  }
  const text = (['text', 'title', 'alt', 'sticker'] as const).map((k) => el?.[k]).find((v): v is string => typeof v === 'string' && v !== '')
  return `${name}${quoted(text)}`
}

const elementsAt = rootList('elements', 'Element')

function arrowCheck(root: Obj, item: Obj): string | null {
  if (item.type !== 'arrow') return null
  const present = new Set(idsOf(root.elements))
  for (const end of [item.from, item.to]) {
    const bound = boundId(end)
    if (bound !== null && !present.has(bound)) return `The connector is bound to "${bound}", which the current version does not have`
  }
  return null
}

const diffWhiteboard: JsonDiff = (b, a, c) => {
  topLevel(b, a, ['elements'], c)
  const items = diffKeyed(b.elements, a.elements, { geometry: ['x', 'y', 'w', 'h', 'points'] })
  if (!items) throw new NotComparable()
  const beforeIds = idsOf(b.elements)
  for (const d of items) {
    const el = d.after ?? d.before
    const isArrow = el?.type === 'arrow'
    c.add(
      {
        id: `${isArrow ? 'connector' : 'element'}:${d.id}`,
        unit: isArrow ? 'connector' : 'element',
        op: d.op,
        label: whiteboardLabel(el, d.id),
        ...itemFields(d),
        ...itemText(d),
      },
      jsonRestorer((root) =>
        restoreKeyed(root, elementsAt, d, beforeIds, {
          checkPut: arrowCheck,
          afterRemove: (list, id) => withoutBoundTo(list, (gone) => gone === id),
        }),
      ),
    )
  }
}

// ---------------------------------------------------------------------------------------------
// Design
// ---------------------------------------------------------------------------------------------

type FlatNode = { props: Obj; kids: string[] | null; parent: string; board: string }
type FlatDesign = { boards: Obj[]; nodes: Map<string, FlatNode>; originals: Map<string, Obj> }

const ROOT_PARENT = (boardId: string) => `board:${boardId}`

// re-derived from artifact-merge.ts (flattenDesign), not exported there; null instead of throwing
function flattenDesign(design: Obj): FlatDesign | null {
  const nodes = new Map<string, FlatNode>()
  const originals = new Map<string, Obj>()
  if (design.boards !== undefined && !Array.isArray(design.boards)) return null
  const boards: Obj[] = []
  for (const board of (design.boards as unknown[] | undefined) ?? []) {
    if (!isObj(board) || typeof board.id !== 'string' || !isObj(board.root)) return null
    const boardId = board.id
    let bad = false
    const visit = (node: unknown, parent: string): string => {
      const id = idOf(node)
      if (id === null || nodes.has(id)) {
        bad = true
        return ''
      }
      const { children, ...props } = node as Obj
      const flat: FlatNode = { props, kids: null, parent, board: boardId }
      nodes.set(id, flat)
      originals.set(id, node as Obj)
      if (children !== undefined) {
        if (!Array.isArray(children)) {
          bad = true
          return id
        }
        flat.kids = children.map((child) => visit(child, id))
      }
      return id
    }
    const { root, ...rest } = board
    const rootId = visit(root, ROOT_PARENT(boardId))
    if (bad) return null
    boards.push({ ...rest, root: rootId })
  }
  return { boards, nodes, originals }
}

const NODE_NAMES: Record<string, string> = {
  frame: 'Frame',
  text: 'Text',
  image: 'Image',
  icon: 'Icon',
  button: 'Button',
  input: 'Input',
  divider: 'Divider',
  shape: 'Shape',
  instance: 'Instance',
}

function nodeLabel(props: Obj | undefined, id: string): string {
  const type = props && typeof props.type === 'string' ? props.type : 'node'
  const text = (['name', 'text', 'label', 'placeholder', 'alt'] as const).map((k) => props?.[k]).find((v): v is string => typeof v === 'string' && v !== '')
  return `${NODE_NAMES[type] ?? capitalise(type)}${quoted(text ?? id)}`
}

type Found = { node: Obj; parent: Obj | null; board: Obj }

/** Every node of the current design's trees by id (first seen wins). */
function indexTree(root: Obj): Map<string, Found> {
  const out = new Map<string, Found>()
  const boards = Array.isArray(root.boards) ? root.boards : []
  for (const board of boards) {
    if (!isObj(board) || !isObj(board.root)) continue
    const visit = (node: unknown, parent: Obj | null) => {
      const id = idOf(node)
      if (id === null || out.has(id)) return
      out.set(id, { node: node as Obj, parent, board })
      const kids = (node as Obj).children
      if (Array.isArray(kids)) for (const kid of kids) visit(kid, node as Obj)
    }
    visit(board.root, null)
  }
  return out
}

/** Ids of a subtree (the node and everything in it). */
function subtreeIds(node: unknown, out: Set<string> = new Set()): Set<string> {
  const id = idOf(node)
  if (id !== null) out.add(id)
  if (isObj(node) && Array.isArray(node.children)) for (const kid of node.children) subtreeIds(kid, out)
  return out
}

/** `node` without any descendant whose id `taken` holds. */
function pruned(node: Obj, taken: Set<string>): Obj {
  if (!Array.isArray(node.children)) return clone(node)
  const children = node.children.filter((kid) => !taken.has(idOf(kid) ?? '')).map((kid) => (isObj(kid) ? pruned(kid, taken) : kid))
  return { ...clone(node), children }
}

/** Where a node goes back among `siblings`: after the nearest before-sibling still there. */
function placeAmong(siblings: unknown[], beforeSiblings: readonly string[], id: string): number {
  return placeIndex(siblings, beforeSiblings, id)
}

function allStrings(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (typeof value === 'string') out.add(value)
  else if (Array.isArray(value)) for (const v of value) allStrings(v, out)
  else if (isObj(value)) for (const v of Object.values(value)) allStrings(v, out)
  return out
}

const diffDesign: JsonDiff = (b, a, c) => {
  const fb = flattenDesign(b)
  const fa = flattenDesign(a)
  if (!fb || !fa) throw new NotComparable()
  topLevel(b, a, ['boards', 'tokens', 'styles', 'pages', 'notes'], c)

  // Tokens: each colour by name, every other token key whole.
  const bt = isObj(b.tokens) ? b.tokens : {}
  const at = isObj(a.tokens) ? a.tokens : {}
  const bColors = isObj(bt.colors) ? bt.colors : {}
  const aColors = isObj(at.colors) ? at.colors : {}
  const tokenChange = (id: string, label: string, bv: unknown, av: unknown, set: (root: Obj, tokens: Obj) => string | null) => {
    const op: ArtifactDiffOp = bv === undefined ? 'added' : av === undefined ? 'removed' : 'changed'
    c.add(
      { id, unit: 'token', op, label, ...textual(bv === undefined ? undefined : show(bv), av === undefined ? undefined : show(av)) },
      jsonRestorer((root) => {
        if (!isObj(root.tokens)) root.tokens = { colors: {} }
        return set(root, root.tokens as Obj)
      }),
    )
  }
  for (const name of [...new Set([...Object.keys(bColors), ...Object.keys(aColors)])]) {
    if (deepEqual(bColors[name], aColors[name])) continue
    tokenChange(`token:colors.${name}`, `Colour token${quoted(name)}`, bColors[name], aColors[name], (root, tokens) => {
      if (!isObj(tokens.colors)) tokens.colors = {}
      const colors = tokens.colors as Obj
      if (bColors[name] === undefined) {
        // Taking a colour out must not leave a board, node or style naming it.
        if (allStrings([root.boards, root.styles]).has(name)) return `Colour token “${name}” is still used`
        delete colors[name]
      } else colors[name] = clone(bColors[name])
      return null
    })
  }
  for (const key of [...new Set([...Object.keys(bt), ...Object.keys(at)])]) {
    if (key === 'colors' || deepEqual(bt[key], at[key])) continue
    tokenChange(`token:${key}`, `Token${quoted(key)}`, bt[key], at[key], (_root, tokens) => {
      if (bt[key] === undefined) delete tokens[key]
      else tokens[key] = clone(bt[key])
      return null
    })
  }

  // Shared styles, pages and notes: keyed lists.
  const bStyles = isObj(b.styles) ? b.styles : {}
  const aStyles = isObj(a.styles) ? a.styles : {}
  for (const kind of ['text', 'fills'] as const) {
    const items = diffKeyed(bStyles[kind], aStyles[kind])
    if (!items) throw new NotComparable()
    const beforeIds = idsOf(bStyles[kind])
    const ref = kind === 'text' ? 'textStyle' : 'fillStyle'
    const listAt: ListAt = {
      noun: kind === 'text' ? 'Text style' : 'Fill style',
      get: (root, create) => {
        if (!isObj(root.styles)) {
          if (!create) return 'The current version has no styles'
          root.styles = {}
        }
        const styles = root.styles as Obj
        if (styles[kind] === undefined && create) styles[kind] = []
        return Array.isArray(styles[kind]) ? (styles[kind] as unknown[]) : `The current version has no ${kind} styles`
      },
    }
    for (const d of items) {
      const item = d.after ?? d.before
      const name = item && typeof item.name === 'string' ? item.name : d.id
      c.add(
        { id: `style:${kind}/${d.id}`, unit: 'style', op: d.op, label: `${listAt.noun}${quoted(name)}`, ...itemFields(d), ...itemText(d) },
        jsonRestorer((root) =>
          restoreKeyed(root, listAt, d, beforeIds, {
            checkRemove: (r, id) => ([...indexTree(r).values()].some((f) => f.node[ref] === id) ? `A node still uses ${listAt.noun.toLowerCase()} "${id}"` : null),
          }),
        ),
      )
    }
  }
  for (const spec of [
    { key: 'pages', unit: 'page', noun: 'Page' },
    { key: 'notes', unit: 'note', noun: 'Note' },
  ] as const) {
    const items = diffKeyed(b[spec.key], a[spec.key])
    if (!items) throw new NotComparable()
    const beforeIds = idsOf(b[spec.key])
    for (const d of items) {
      const item = d.after ?? d.before
      const text = item && typeof item.title === 'string' ? item.title : item && typeof item.text === 'string' ? item.text : d.id
      c.add(
        { id: `${spec.unit}:${d.id}`, unit: spec.unit, op: d.op, label: `${spec.noun}${quoted(text)}`, ...itemFields(d), ...itemText(d) },
        jsonRestorer((root) =>
          restoreKeyed(root, rootList(spec.key, spec.noun), d, beforeIds, {
            checkPut: (r, put) => (spec.key === 'notes' && typeof put.page === 'string' && !idsOf(r.pages).includes(put.page) ? `Page "${put.page}" is gone` : null),
            checkRemove: (r, id) =>
              spec.key === 'pages' && Array.isArray(r.boards) && r.boards.some((board) => isObj(board) && board.page === id) ? 'Boards still sit on that page' : null,
          }),
        ),
      )
    }
  }

  // Boards (their own settings; their nodes below).
  // A board's `root` (flattened to its id) differs only when the root was replaced by a new tree;
  // the nodes under a replaced root are then this board change, not node changes.
  const boardItems = diffKeyed(fb.boards, fa.boards, { geometry: ['x', 'y'] })
  if (!boardItems) throw new NotComparable()
  const boardIds = fb.boards.map((board) => String(board.id))
  const bOriginalBoards = keyed(Array.isArray(b.boards) ? b.boards : []) ?? new Map<string, unknown>()
  const titleOf = (board: Obj | undefined, id: string) => (board && typeof board.title === 'string' ? board.title : id)
  const boardTitle = (id: string) => titleOf(fa.boards.find((x) => x.id === id) ?? fb.boards.find((x) => x.id === id), id)
  for (const d of boardItems) {
    const original = bOriginalBoards.get(d.id)
    // Put a removed board (or a replaced root) back with its whole tree; take an added one out whole.
    const full: ItemDiff = d.op !== 'added' && isObj(original) ? { ...d, before: original } : d
    c.add(
      { id: `board:${d.id}`, unit: 'board', op: d.op, label: `Board${quoted(titleOf(d.after ?? d.before, d.id))}`, ...itemFields(d), ...itemText(d) },
      jsonRestorer((root) =>
        restoreKeyed(root, rootList('boards', 'Board'), full, boardIds, {
          checkPut: (r, put) => {
            if (d.op !== 'removed' && !d.fields.includes('root')) return null
            // Ids are unique design-wide: the old tree must not collide with nodes now elsewhere.
            const seen = new Set<string>()
            // A removed board is checked before it goes back in; a changed one is already in place.
            const roots = [...(d.op === 'removed' ? [put.root] : []), ...(Array.isArray(r.boards) ? r.boards : []).map((x) => (isObj(x) ? x.root : undefined))]
            for (const tree of roots) {
              for (const id of subtreeIds(tree)) {
                if (seen.has(id)) return `Node "${id}" of that board is now elsewhere in the design`
                seen.add(id)
              }
            }
            if (typeof put.page === 'string' && !idsOf(r.pages).includes(put.page)) return `Page "${put.page}" is gone`
            return null
          },
          checkRemove: (r, id) => (r.startBoard === id ? 'The prototype starts on that board' : null),
        }),
      ),
    )
  }

  // Nodes, design-wide. Reordered children of a frame both hold are moves.
  const reordered = new Set<string>()
  for (const [id, node] of fa.nodes) {
    const old = fb.nodes.get(id)
    if (!old || !node.kids || !old.kids) continue
    for (const kid of reorderedIds(old.kids, node.kids)) reordered.add(kid)
  }
  const restoreNode = (id: string, op: ItemOp, fields: string[]) =>
    jsonRestorer((root) => {
      const present = indexTree(root)
      const old = fb.nodes.get(id)
      const oldOriginal = fb.originals.get(id)
      if (op === 'added') {
        const found = present.get(id)
        if (!found) return `Node "${id}" is no longer in the current version`
        if (!found.parent || !Array.isArray(found.parent.children)) return 'A board’s root node cannot be removed'
        found.parent.children.splice(found.parent.children.indexOf(found.node), 1)
        return null
      }
      if (!old || !oldOriginal) return 'Nothing to put back'
      const parent = old.parent.startsWith('board:') ? null : present.get(old.parent)
      const siblings = old.parent.startsWith('board:') ? [] : fb.nodes.get(old.parent)?.kids ?? []
      if (op === 'removed') {
        if (present.has(id)) return `Node "${id}" is already in the current version`
        if (!parent) return 'Its parent is no longer in the current version'
        if (!Array.isArray(parent.node.children)) return 'Its parent no longer holds children'
        const taken = new Set(present.keys())
        parent.node.children.splice(placeAmong(parent.node.children, siblings, id), 0, pruned(oldOriginal, taken))
        return null
      }
      const found = present.get(id)
      if (!found) return `Node "${id}" is no longer in the current version`
      for (const field of fields) {
        if (field === 'parent' || field === 'order') continue
        if (has(old.props, field)) found.node[field] = clone(old.props[field])
        else delete found.node[field]
      }
      if (fields.includes('parent') || fields.includes('order')) {
        if (!parent) return 'Its old parent is no longer in the current version'
        if (!found.parent || !Array.isArray(found.parent.children)) return 'A board’s root node cannot move'
        if (subtreeIds(found.node).has(idOf(parent.node) ?? '')) return 'Its old parent is now inside it'
        if (!Array.isArray(parent.node.children)) return 'Its old parent no longer holds children'
        found.parent.children.splice(found.parent.children.indexOf(found.node), 1)
        parent.node.children.splice(placeAmong(parent.node.children, siblings, id), 0, found.node)
      }
      return null
    })

  const afterBoards = new Set(fa.boards.map((board) => String(board.id)))
  const beforeBoards = new Set(fb.boards.map((board) => String(board.id)))
  for (const [id, node] of fa.nodes) {
    const old = fb.nodes.get(id)
    const group = boardTitle(node.board)
    if (!old) {
      // Only the top of a new subtree, and not on a new board (the board's change covers it).
      if (!beforeBoards.has(node.board) || !fb.nodes.has(node.parent)) continue
      const count = subtreeIds(fa.originals.get(id)).size
      c.add(
        {
          id: `node:${id}`,
          unit: 'node',
          op: 'added',
          label: nodeLabel(node.props, id),
          group,
          ...textual(undefined, `${renderItem(node.props) ?? ''}${count > 1 ? `\n(${count - 1} nodes inside)` : ''}`),
        },
        restoreNode(id, 'added', []),
      )
      continue
    }
    const fields = [...new Set([...Object.keys(old.props), ...Object.keys(node.props)])].filter((k) => !deepEqual(old.props[k], node.props[k]))
    const moved = old.parent !== node.parent
    const order = !moved && reordered.has(id)
    if (fields.length === 0 && !moved && !order) continue
    const all = [...fields, ...(moved ? ['parent'] : []), ...(order ? ['order'] : [])]
    const geometryOnly = fields.every((f) => f === 'x' || f === 'y')
    const op: ArtifactDiffOp = geometryOnly ? 'moved' : 'changed'
    const sub: ItemDiff = { id, op: 'changed', before: old.props, after: node.props, beforeIndex: 0, afterIndex: 0, fields }
    c.add({ id: `node:${id}`, unit: 'node', op, label: nodeLabel(node.props, id), group, fields: all, ...itemText(sub) }, restoreNode(id, 'changed', all))
  }
  for (const [id, old] of fb.nodes) {
    if (fa.nodes.has(id)) continue
    // Only the top of a removed subtree, and not on a removed board.
    if (!afterBoards.has(old.board) || !fa.nodes.has(old.parent)) continue
    const count = subtreeIds(fb.originals.get(id)).size
    c.add(
      {
        id: `node:${id}`,
        unit: 'node',
        op: 'removed',
        label: nodeLabel(old.props, id),
        group: boardTitle(old.board),
        ...textual(`${renderItem(old.props) ?? ''}${count > 1 ? `\n(${count - 1} nodes inside)` : ''}`, undefined),
      },
      restoreNode(id, 'removed', []),
    )
  }
}

const JSON_DIFFS: Record<Exclude<ArtifactKind, 'doc'>, JsonDiff> = {
  sheet: diffSheet,
  slides: diffSlides,
  data: diffData,
  whiteboard: diffWhiteboard,
  design: diffDesign,
}
