import { joinDocSuggestions, splitDocSuggestions, type DocSuggestionRecord } from './artifact-kinds/doc-suggestions'
import { docBlockHash, docBodyLayout } from './artifact-kinds/doc-blocks'
import { docTabs, splitBlocks, tabOfBlock } from './artifact-kinds/doc-tabs'
import { SHEET_LIMITS, tabCols, tabRows, type SheetTab, type Workbook } from './artifact-kinds/sheet'
import { parseAddress, parseRange, toAddress, type CellRect } from './artifact-kinds/sheet-address'
import { applyRemap, deleteRemap, insertRemap, moveRemap, type Axis, type AxisRemap } from './artifact-kinds/sheet-structure'
import { protectionRefusal } from './artifact-kinds/sheet-guard'

import type { ArtifactKind } from './artifacts'

/**
 * Three-way merge of artifact bodies, for the workspace's polling sync: an open artifact tab
 * polls the server, and when the server's revision moved while the reader has unsaved changes,
 * the client merges the two instead of overwriting one with the other.
 *
 * `base` is the body at the revision the client last loaded, `mine` the client's unsaved body,
 * `theirs` the server's current body. Each kind is cut into units (a doc block, a sheet cell, a
 * slide, a whiteboard element, a design node's props or its child list, a dashboard block…). A
 * unit changed on one side takes that side; changed identically on both is fine; changed
 * differently on both, or deleted on one side and changed on the other, is a conflict. Any
 * conflict left unsettled fails the whole merge (nothing is half-merged), naming every unit that
 * collided, each with a `key` the caller can hand back in `resolve` to settle it.
 *
 * Every object the merge rebuilds (the root, a tab, a cell, a slide, an element, a board, a node,
 * a list item…) merges key by key: a key only one side changed takes that side, so a field this
 * file does not know (a newer client's) is never dropped. Coupled keys merge as one unit (a
 * cell's `v`/`f`/`runs`); a key both sides changed differently is a conflict named after its
 * object.
 *
 * A sheet whose rows or columns were inserted or deleted on one side is first REBASED: the same
 * axis remap (sheet-structure.ts `applyRemap`) is applied to base and to the other side, so the
 * other side's cell edits, and its formulas in every tab that point at the shifted tab, land on
 * the shifted addresses. An edit to a line the other side deleted is a conflict. Where the cells
 * leave the line edit's place open (a sparse tab), the side's settings (row heights, merges,
 * rules…) narrow it, and the other side changing a cell or a setting where it is still open is a
 * conflict rather than a guess; so is the other side changing a line a one-line move displaced.
 * A sheet's protections settle by who saves the merge (`mineIsOwner`), as the store checks it.
 *
 * Pure and total: it never throws. The merged body is NOT schema-validated here; the caller
 * validates it like any other save. A whiteboard never keeps an arrow bound to an element the
 * merge removed (it goes, as deleting the element in the editor removes it) nor a sticker
 * attached to one (it is detached). Other cross-unit references (a design node's `textStyle`
 * naming a style the other side removed, a `responsive` key naming a removed breakpoint) are left
 * to that validation.
 */

export type ArtifactMergeSide = 'mine' | 'theirs'

/** One unit both sides changed: `key` is stable for the same three bodies, `label` is for people. */
export type ArtifactMergeUnit = { key: string; label: string }

/**
 * How conflicts settle: one side for every unit ("Keep mine" is `'mine'`), or per unit by key
 * (from a failed merge's `units`). A unit the map leaves out stays a conflict.
 */
export type ArtifactMergeResolution = ArtifactMergeSide | Readonly<Record<string, ArtifactMergeSide>>

export type ArtifactMergeOptions = {
  resolve?: ArtifactMergeResolution
  /** Alias of `resolve: 'mine'` (Keep mine). */
  preferMine?: boolean
  /**
   * Sheets: the reader whose unsaved body is `mine` owns the artifact, so the store checks the
   * merged save as the owner's (who may add, remove, resize and move protections). Without it
   * `mine` is a non-owner's draft and `theirs` holds the protections that stand.
   */
  mineIsOwner?: boolean
}

export type ArtifactMergeResult =
  /** `resolved`: the conflicts `resolve` settled (absent when there were none). */
  | { ok: true; body: string; resolved?: ArtifactMergeUnit[] }
  /** `conflicts`: the unsettled units' labels (for a notice); `units`: the same with their keys. */
  | { ok: false; conflicts: string[]; units: ArtifactMergeUnit[] }

const WHOLE_BODY = 'the whole body'
const BODY: ArtifactMergeUnit = { key: 'body', label: WHOLE_BODY }

/**
 * Keep mine (`resolve: 'mine'` or `preferMine`): every unit changed on both sides takes mine, and
 * everything the other side changed elsewhere is kept. Delete against edit takes the chosen
 * side's version: its deletion, or its edit.
 */
export function mergeArtifactBodies(
  kind: ArtifactKind,
  base: string,
  mine: string,
  theirs: string,
  options: ArtifactMergeOptions = {},
): ArtifactMergeResult {
  const resolution = options.resolve ?? (options.preferMine ? 'mine' : undefined)
  const ctx = new MergeContext(resolution)
  try {
    if (kind === 'doc') return finish(ctx, mergeDoc(base, mine, theirs, ctx))
    const parsed = [base, mine, theirs].map(parseObject)
    const [b, m, t] = parsed
    if (!b || !m || !t) return finish(ctx, pickSide(ctx.conflict(BODY), mine, theirs))
    // Raw-string short cuts after the parse, so an unparseable side never slips through; they
    // keep the untouched side byte-for-byte (a re-stringify would not).
    if (mine === base || mine === theirs) return { ok: true, body: theirs }
    if (theirs === base) return { ok: true, body: mine }
    // A side differing from base only in spacing or key order changed nothing.
    if (deepEqual(b, m)) return { ok: true, body: theirs }
    if (deepEqual(b, t)) return { ok: true, body: mine }
    if (deepEqual(m, t)) return { ok: true, body: mine }
    if (kind === 'sheet') {
      const settled = mergeSheetBodies(b, m, t, resolution, options.mineIsOwner === true)
      return finish(settled.ctx, JSON.stringify(settled.workbook))
    }
    return finish(ctx, JSON.stringify(JSON_MERGERS[kind](b, m, t, ctx)))
  } catch {
    const fresh = new MergeContext(resolution)
    return finish(fresh, pickSide(fresh.conflict(BODY), mine, theirs))
  }
}

function finish(ctx: MergeContext, body: string): ArtifactMergeResult {
  if (ctx.unresolved.length > 0) {
    return { ok: false, conflicts: ctx.unresolved.map((u) => u.label), units: [...ctx.unresolved] }
  }
  return ctx.units.length > 0 ? { ok: true, body, resolved: [...ctx.units] } : { ok: true, body }
}

/** The chosen side's value; mine stands in while a conflict is unsettled (the merge fails anyway). */
function pickSide<T>(side: ArtifactMergeSide | null, mine: T, theirs: T): T {
  return side === 'theirs' ? theirs : mine
}

// ---------------------------------------------------------------------------------------------
// Shared machinery
// ---------------------------------------------------------------------------------------------

type Obj = Record<string, unknown>
type Unit = ArtifactMergeUnit

const unit = (key: string, label: string): Unit => ({ key, label })

/** A value missing on one side (a deleted key or list item). */
const ABSENT = Symbol('absent')
type Maybe<T = unknown> = T | typeof ABSENT

class MergeContext {
  /** Every conflict met, settled or not, in the order met. */
  readonly units: Unit[] = []
  /** The ones no resolution settled. */
  readonly unresolved: Unit[] = []
  private readonly seen = new Map<string, ArtifactMergeSide | null>()

  constructor(private readonly resolution?: ArtifactMergeResolution) {}

  /** Records a conflict on `u` (once per key) and says which side settles it, or null. */
  conflict(u: Unit): ArtifactMergeSide | null {
    if (this.seen.has(u.key)) return this.seen.get(u.key) ?? null
    const r = this.resolution
    const side = r === undefined ? null : typeof r === 'string' ? r : Object.prototype.hasOwnProperty.call(r, u.key) ? (r[u.key] ?? null) : null
    this.seen.set(u.key, side)
    this.units.push(u)
    if (side === null) this.unresolved.push(u)
    return side
  }

  /** A conflict no side choice can settle (two moves that nest two frames in each other). */
  unsettled(u: Unit) {
    if (this.unresolved.some((other) => other.key === u.key)) return
    if (!this.seen.has(u.key)) {
      this.seen.set(u.key, null)
      this.units.push(u)
    }
    this.unresolved.push(u)
  }

  /** How a conflict on `key` was settled: a side, null (unsettled), or undefined (no conflict). */
  decided(key: string): ArtifactMergeSide | null | undefined {
    return this.seen.get(key)
  }
}

export function parseObject(text: string): Obj | null {
  try {
    const value: unknown = JSON.parse(text)
    return isObj(value) ? value : null
  } catch {
    return null
  }
}

/** Unit-keying helpers, shared with artifact-diff.ts (the version compare keys units the same way). */
export const isObj = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Structural equality; object key order does not matter, array order does. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, i) => deepEqual(item, b[i]))
  }
  if (isObj(a)) {
    if (!isObj(b)) return false
    const keys = Object.keys(a).filter((k) => a[k] !== undefined)
    const other = Object.keys(b).filter((k) => b[k] !== undefined)
    if (keys.length !== other.length) return false
    return keys.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]))
  }
  return false
}

const same = (a: Maybe, b: Maybe) => (a === ABSENT || b === ABSENT ? a === b : deepEqual(a, b))

/** One unit, three ways. */
function mergeUnit(base: Maybe, mine: Maybe, theirs: Maybe, u: Unit, ctx: MergeContext): Maybe {
  if (same(mine, theirs)) return mine
  if (same(base, mine)) return theirs
  if (same(base, theirs)) return mine
  return pickSide(ctx.conflict(u), mine, theirs)
}

type Inner = (base: unknown, mine: unknown, theirs: unknown, ctx: MergeContext) => unknown

/**
 * An entity that can be added or deleted (a tab, a slide, a node): presence first, then `inner`
 * when all three sides hold it. Added on both sides must agree; deleted on one side needs the
 * other side unchanged, else it is a conflict whose chosen side gives the deletion or the edit.
 */
function mergeEntity(
  base: Maybe,
  mine: Maybe,
  theirs: Maybe,
  u: Unit,
  ctx: MergeContext,
  inner: Inner,
  changed: (base: unknown, side: unknown) => boolean = (b, s) => !deepEqual(b, s),
): Maybe {
  if (base === ABSENT) {
    if (mine === ABSENT) return theirs
    if (theirs === ABSENT) return mine
    if (deepEqual(mine, theirs)) return mine
    return pickSide(ctx.conflict(u), mine, theirs)
  }
  if (mine === ABSENT || theirs === ABSENT) {
    const kept = mine === ABSENT ? theirs : mine
    if (kept === ABSENT || !changed(base, kept)) return ABSENT
    const side = ctx.conflict(u)
    return side === 'theirs' ? theirs : side === 'mine' ? mine : kept
  }
  return inner(base, mine, theirs, ctx)
}

type FieldMerger = (base: Maybe, mine: Maybe, theirs: Maybe, ctx: MergeContext) => Maybe

export const has = (o: Obj, key: string) => Object.prototype.hasOwnProperty.call(o, key) && o[key] !== undefined

/**
 * An object's fields, each its own unit unless `custom` names a merger for it or `groups` puts it
 * in a set of keys that only make sense together (merged as one unit). Every other key, known or
 * not, is the per-key fallback: one side changed it, that side wins. Keys keep theirs' order,
 * then mine's new keys.
 */
function mergeFields(
  base: Obj,
  mine: Obj,
  theirs: Obj,
  ctx: MergeContext,
  unitOf: (key: string) => Unit,
  custom: Record<string, FieldMerger> = {},
  groups: readonly (readonly string[])[] = [],
): Obj {
  const out: Obj = {}
  const keys = [...new Set([...Object.keys(theirs), ...Object.keys(mine), ...Object.keys(base)])]
  const groupResults = new Map<readonly string[], Maybe>()
  for (const key of keys) {
    const get = (o: Obj): Maybe => (has(o, key) ? o[key] : ABSENT)
    const group = groups.find((g) => g.includes(key))
    if (group) {
      if (!groupResults.has(group)) {
        const part = (o: Obj): Maybe => {
          const picked: Obj = {}
          for (const k of group) if (has(o, k)) picked[k] = o[k]
          return Object.keys(picked).length > 0 ? picked : ABSENT
        }
        groupResults.set(group, mergeUnit(part(base), part(mine), part(theirs), unitOf(key), ctx))
      }
      const merged = groupResults.get(group)
      if (isObj(merged) && has(merged, key)) out[key] = merged[key]
      continue
    }
    const merger = Object.prototype.hasOwnProperty.call(custom, key) ? custom[key] : undefined
    const value = merger
      ? merger(get(base), get(mine), get(theirs), ctx)
      : mergeUnit(get(base), get(mine), get(theirs), unitOf(key), ctx)
    if (value !== ABSENT) out[key] = value
  }
  return out
}

/**
 * The inner merge of one object present on all three sides: key by key (see `mergeFields`), every
 * conflict named `u`. A side that is not an object is one unit.
 */
const objectInner =
  (u: Unit, custom: Record<string, FieldMerger> = {}, groups: readonly (readonly string[])[] = []): Inner =>
  (b, m, t, ctx) =>
    isObj(b) && isObj(m) && isObj(t) ? mergeFields(b, m, t, ctx, () => u, custom, groups) : mergeUnit(b, m, t, u, ctx)

/**
 * A field holding one object (design `constraints`, `guides`, `styles`): merged key by key while
 * both sides keep it; added on one side or removed on one side is one unit.
 */
const objectField =
  (u: Unit, custom: Record<string, FieldMerger> = {}): FieldMerger =>
  (b, m, t, ctx) => {
    if ([b, m, t].some((v) => v !== ABSENT && !isObj(v)) || m === ABSENT || t === ABSENT) return mergeUnit(b, m, t, u, ctx)
    return mergeFields(isObj(b) ? b : {}, m as Obj, t as Obj, ctx, () => u, custom)
  }

/**
 * A list of plain strings or numbers that is really a set (design guide positions): each side's
 * additions and removals both apply. Theirs' order, then mine's additions.
 */
const setListField =
  (u: Unit): FieldMerger =>
  (b, m, t, ctx) => {
    const plain = (v: Maybe) => v === ABSENT || (Array.isArray(v) && v.every((x) => typeof x === 'string' || typeof x === 'number'))
    if (![b, m, t].every(plain) || m === ABSENT || t === ABSENT) return mergeUnit(b, m, t, u, ctx)
    if (same(b, m) || same(m, t)) return t
    if (same(b, t)) return m
    const [bl, ml, tl] = [b === ABSENT ? [] : b, m, t] as unknown[][]
    const removed = new Set(bl.filter((x) => !ml.includes(x) || !tl.includes(x)))
    return [...new Set([...tl, ...ml])].filter((x) => !removed.has(x))
  }

/** Three objects (absent or malformed treated as `{}`), or null when none is an object. */
const asObjects = (b: Maybe, m: Maybe, t: Maybe): [Obj, Obj, Obj] | null => {
  if (!isObj(b) && !isObj(m) && !isObj(t)) return null
  const o = (v: Maybe) => (isObj(v) ? v : {})
  return [o(b), o(m), o(t)]
}

/**
 * A field holding a record whose every key is its own entity (sheet `cells`, a design node's
 * `responsive`): added, removed, or merged by `inner` (default: key by key) when all sides hold it.
 */
const recordField =
  (unitOf: (key: string) => Unit, inner: (key: string) => Inner = (key) => objectInner(unitOf(key))): FieldMerger =>
  (b, m, t, ctx) => {
    if (b !== ABSENT && !isObj(b)) return mergeUnit(b, m, t, unitOf('*'), ctx)
    if ((m !== ABSENT && !isObj(m)) || (t !== ABSENT && !isObj(t))) return mergeUnit(b, m, t, unitOf('*'), ctx)
    // A record deleted outright on one side is a change of the whole field.
    if (m === ABSENT || t === ABSENT) return mergeUnit(b, m, t, unitOf('*'), ctx)
    const objects = asObjects(b, m, t)
    if (!objects) return ABSENT
    const [bo, mo, to] = objects
    const out: Obj = {}
    for (const key of new Set([...Object.keys(to), ...Object.keys(mo), ...Object.keys(bo)])) {
      const get = (o: Obj): Maybe => (has(o, key) ? o[key] : ABSENT)
      const value = mergeEntity(get(bo), get(mo), get(to), unitOf(key), ctx, inner(key))
      if (value !== ABSENT) out[key] = value
    }
    return out
  }

type KeyedOptions = {
  /** The item's key (default its `id`). */
  key?: (item: unknown) => string | null
  /** The unit of one item. */
  item: (id: string, base: unknown, mine: unknown, theirs: unknown) => Unit
  /** The unit of the list's order. */
  order: Unit
  /** The unit of the whole list when it cannot be keyed (a missing or duplicate id). */
  whole: Unit
  /** The merge of one item present on all three sides (default: key by key, see `objectInner`). */
  inner?: (id: string) => Inner
}

export const idOf = (item: unknown): string | null => (isObj(item) && typeof item.id === 'string' ? item.id : null)

export function keyed(list: unknown[], keyOf: (item: unknown) => string | null = idOf): Map<string, unknown> | null {
  const map = new Map<string, unknown>()
  for (const item of list) {
    const id = keyOf(item)
    if (id === null || map.has(id)) return null
    map.set(id, item)
  }
  return map
}

/**
 * A list of objects keyed by `id`: each item merges as an entity, and the order merges on its
 * own (one side reordering is taken; both reordering differently is a conflict). Items added on
 * either side are kept, each before its nearest following surviving id (else at the end).
 */
function keyedListField(options: KeyedOptions): FieldMerger {
  return (b, m, t, ctx) => {
    const lists = [b, m, t].map((v) => (v === ABSENT ? [] : v))
    if (!lists.every(Array.isArray)) return mergeUnit(b, m, t, options.whole, ctx)
    const [bl, ml, tl] = lists as unknown[][]
    if (m === ABSENT || t === ABSENT) {
      if (b === ABSENT) return m === ABSENT ? t : m
      // The whole list deleted on one side: only fine when the other left it as it was.
      return mergeUnit(b, m, t, options.whole, ctx)
    }
    const maps = [bl, ml, tl].map((list) => keyed(list, options.key))
    const [bm, mm, tm] = maps
    if (!bm || !mm || !tm) return mergeUnit(b, m, t, options.whole, ctx)
    return mergeKeyedList(bm, mm, tm, ctx, options)
  }
}

function mergeKeyedList(
  bm: Map<string, unknown>,
  mm: Map<string, unknown>,
  tm: Map<string, unknown>,
  ctx: MergeContext,
  options: KeyedOptions,
): unknown[] {
  const merged = new Map<string, unknown>()
  for (const id of new Set([...tm.keys(), ...mm.keys(), ...bm.keys()])) {
    const get = (map: Map<string, unknown>): Maybe => (map.has(id) ? map.get(id) : ABSENT)
    const [b, m, t] = [get(bm), get(mm), get(tm)]
    const u = options.item(id, b === ABSENT ? undefined : b, m === ABSENT ? undefined : m, t === ABSENT ? undefined : t)
    const inner = options.inner?.(id) ?? objectInner(u)
    const value = mergeEntity(b, m, t, u, ctx, inner)
    if (value !== ABSENT) merged.set(id, value)
  }
  const order = mergeOrder([...bm.keys()], [...mm.keys()], [...tm.keys()], new Set(merged.keys()), options.order, ctx)
  return order.map((id) => merged.get(id))
}

/** The relative order of the ids on `side` that `base` also holds. */
const surviving = (side: string[], base: Set<string>) => side.filter((id) => base.has(id))

function mergeOrder(
  base: string[],
  mine: string[],
  theirs: string[],
  keep: Set<string>,
  u: Unit,
  ctx: MergeContext,
  prefer: ArtifactMergeSide | null = null,
): string[] {
  const baseSet = new Set(base)
  const mineSet = new Set(mine)
  const theirSet = new Set(theirs)
  const restrict = (ids: string[], to: Set<string>) => ids.filter((id) => to.has(id))
  // A side reordered when the ids it kept from base no longer sit in base's order.
  const mineMoved = !arraysEqual(surviving(mine, baseSet), restrict(base, mineSet))
  const theirsMoved = !arraysEqual(surviving(theirs, baseSet), restrict(base, theirSet))
  let primaryMine = prefer ? prefer === 'mine' : mineMoved && !theirsMoved
  if (mineMoved && theirsMoved) {
    const common = new Set(base.filter((id) => mineSet.has(id) && theirSet.has(id)))
    if (!arraysEqual(restrict(mine, common), restrict(theirs, common))) primaryMine = ctx.conflict(u) !== 'theirs'
  }
  const [primary, secondary] = primaryMine ? [mine, theirs] : [theirs, mine]
  const out = primary.filter((id) => keep.has(id))
  const placed = new Set(out)
  // The other side's additions go before their nearest following id the primary order holds,
  // or at the end when none follows (an append stays an append, on top of a z-order).
  secondary.forEach((id, index) => {
    if (placed.has(id) || !keep.has(id)) return
    let at = out.length
    for (let i = index + 1; i < secondary.length; i += 1) {
      if (!placed.has(secondary[i])) continue
      at = out.indexOf(secondary[i])
      break
    }
    out.splice(at, 0, id)
    placed.add(id)
  })
  // Anything kept that neither list placed goes last, in base's order.
  for (const id of [...base, ...keep]) if (keep.has(id) && !placed.has(id)) {
    out.push(id)
    placed.add(id)
  }
  return out
}

const arraysEqual = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((v, i) => v === b[i])

const quote = (text: string) => `"${text}"`
const pick = (...values: unknown[]): Obj => (values.find(isObj) as Obj | undefined) ?? {}
const nameOf = (field: string, ...values: unknown[]) => {
  const value = pick(...values)[field]
  return typeof value === 'string' && value ? value : undefined
}

/** A field whose numeric value only ever grows (sheet `revision`): the larger side wins. */
const maxField: FieldMerger = (b, m, t, ctx) => {
  if (typeof m === 'number' && typeof t === 'number') return Math.max(m, t)
  return mergeUnit(b, m, t, unit('revision', 'revision'), ctx)
}

// ---------------------------------------------------------------------------------------------
// JSON kinds
// ---------------------------------------------------------------------------------------------

type JsonMerger = (base: Obj, mine: Obj, theirs: Obj, ctx: MergeContext) => Obj

const topUnit = (key: string) => unit(key, key)

/**
 * Whether `side` looks like `base` with rows or columns shifted: at least two base cells whose
 * content left its address and turns up at another address that held something else. One edited
 * cell, or a value typed twice, never looks like this. Only a guard now: a shift the rebase below
 * could not explain (a move, a sort, both axes at once).
 */
function looksShifted(base: Obj, side: Obj): boolean {
  const key = (cell: unknown) => JSON.stringify(cell)
  const at = new Map<string, string[]>()
  for (const [address, cell] of Object.entries(side)) {
    const list = at.get(key(cell)) ?? []
    list.push(address)
    at.set(key(cell), list)
  }
  let moved = 0
  for (const [address, cell] of Object.entries(base)) {
    if (deepEqual(side[address], cell)) continue
    const elsewhere = at.get(key(cell))?.some((other) => other !== address && !deepEqual(base[other], cell))
    if (elsewhere && ++moved >= 2) return true
  }
  return false
}

/** A sheet cell's value: `v` or `f`, and the rich-text `runs` whose texts must join to `v`. */
// A cell's content: its value, formula, rich-text runs (which describe `v`'s text) and the
// people a person cell names (whose names `v` shows): changed together or not at all.
const CELL_VALUE = ['v', 'f', 'runs', 'people'] as const

/** A row (1-based number) or column (letters) group edge as a number, for the overlap check. */
const edgeIndex = (edge: unknown): number | null => {
  if (typeof edge === 'number') return edge
  if (typeof edge !== 'string' || !/^[A-Z]{1,3}$/.test(edge)) return null
  let index = 0
  for (const ch of edge) index = index * 26 + (ch.charCodeAt(0) - 64)
  return index
}

/**
 * A tab's `rowGroups` / `colGroups`: keyed by their span (groups have no id), so a group added on
 * one side and another folded on the other both survive. Groups never overlap: two sides adding
 * overlapping groups is a conflict of the field (settled by taking one side's list).
 */
const lineGroupsField = (u: Unit): FieldMerger => {
  const merge = keyedListField({
    key: (item) => (isObj(item) && edgeIndex(item.from) !== null && edgeIndex(item.to) !== null ? `${String(item.from)}:${String(item.to)}` : null),
    item: () => u,
    order: u,
    whole: u,
  })
  return (b, m, t, ctx) => {
    const value = merge(b, m, t, ctx)
    if (!Array.isArray(value)) return value
    const spans = value.map((g) => [edgeIndex((g as Obj).from), edgeIndex((g as Obj).to)] as [number, number])
    if (spans.some(([from, to], i) => spans.some(([f2, t2], j) => j !== i && f2 <= to && from <= t2))) {
      const side = ctx.conflict(u)
      if (side) return side === 'mine' ? m : t
    }
    return value
  }
}

/**
 * The trash of deleted tabs, keyed by the deleted tab's id; newest last. Deletes on both sides
 * all land, trimmed from the oldest to the op's caps (`deleteTab` in sheet-ops.ts).
 */
const deletedTabsField: FieldMerger = (b, m, t, ctx) => {
  const value = keyedListField({
    key: (entry) => (isObj(entry) ? idOf(entry.tab) : null),
    item: (id) => unit(`deletedTabs/${id}`, `deleted tab ${quote(id)}`),
    order: unit('deletedTabs:order', 'deletedTabs order'),
    whole: unit('deletedTabs', 'deletedTabs'),
  })(b, m, t, ctx)
  if (!Array.isArray(value)) return value
  const size = (entry: unknown) => (isObj(entry) && isObj(entry.tab) && isObj(entry.tab.cells) ? Object.keys(entry.tab.cells).length : 0)
  const trash = [...value]
  while (trash.length > SHEET_LIMITS.deletedTabs || trash.reduce((n, e) => n + size(e), 0) > SHEET_LIMITS.deletedCells) trash.shift()
  return trash
}

// ---- Sheet rebase: one side inserted or deleted rows or columns

/** What one side did to one tab's lines, inferred from its cells (and, when they leave it open, its settings). */
type LineEdit = {
  remap: AxisRemap
  axis: Axis
  kind: 'insert' | 'delete'
  at: number
  /** The last place the edit could have been at, as far as this side's body tells (`at` when pinned). */
  atMax: number
  count: number
  /** Base line indices whose fate the inference cannot pin down, or that the edit deleted. */
  band: [number, number]
}

const cellsOf = (tab: unknown): Obj => (isObj(tab) && isObj(tab.cells) ? tab.cells : {})

/** A cell's content for matching moved cells; a formula's references are blanked (they shift). */
function cellKey(cell: unknown): string {
  if (!isObj(cell)) return JSON.stringify(cell)
  const keys = Object.keys(cell).filter((k) => cell[k] !== undefined).sort()
  return JSON.stringify(
    keys.map((k) => [k, k === 'f' && typeof cell.f === 'string' ? cell.f.replace(/\$?[A-Za-z]{1,3}\$?\d+/g, 'R') : cell[k]]),
  )
}

// ---- A tab's positional settings: everything besides its cells that names a row or column

/** Tab fields that sit on rows or columns, so a line edit moves them (sheet-structure.ts `remapTabSettings`). */
const POSITIONAL = [
  'rowMeta',
  'columns',
  'merges',
  'rules',
  'tables',
  'validations',
  'protected',
  'filter',
  'rowGroups',
  'colGroups',
  'charts',
  'frozenRows',
  'frozenCols',
] as const

/** Whether `side` changed any positional setting of `base`'s tab. */
const settingsChanged = (base: unknown, side: unknown): boolean =>
  isObj(base) && isObj(side) ? POSITIONAL.some((key) => !deepEqual(base[key], side[key])) : false

/**
 * The positional settings `side` changed against `base`, as two settings-only tabs (no cells):
 * what `side` holds there and what `base` held. A remap that treats these differently from
 * another remap moves what the other side changed differently, so a merge would guess.
 */
function settingsDiff(base: Obj, side: Obj): [Obj, Obj] {
  const pieces = (from: Obj, other: Obj): Obj => {
    const out: Obj = { id: base.id, name: base.name, cells: {}, ...(has(base, 'rows') ? { rows: base.rows } : {}), ...(has(base, 'cols') ? { cols: base.cols } : {}) }
    for (const key of POSITIONAL) {
      const [a, b] = [from[key], other[key]]
      if (deepEqual(a, b) || a === undefined) continue
      if (key === 'rowMeta' && isObj(a)) {
        const bo = isObj(b) ? b : {}
        const picked = Object.fromEntries(Object.entries(a).filter(([k, v]) => !deepEqual(v, bo[k])))
        if (Object.keys(picked).length) out[key] = picked
      } else if (key === 'columns' && Array.isArray(a)) {
        const bl = Array.isArray(b) ? b : []
        const picked = a.map((v, i) => (deepEqual(v, bl[i]) ? {} : isObj(v) && Object.keys(v).length ? v : { changed: true }))
        if (picked.some((v) => Object.keys(v).length)) out[key] = picked
      } else if (Array.isArray(a)) {
        const others = new Set((Array.isArray(b) ? b : []).map((v) => JSON.stringify(v)))
        const picked = a.filter((v) => !others.has(JSON.stringify(v)))
        if (picked.length) out[key] = picked
      } else out[key] = a
    }
    return out
  }
  return [pieces(side, base), pieces(base, side)]
}

/** Whether two remaps of one tab put the settings in `pieces` in different places. */
function remapsDiffer(tabId: string, pieces: Obj[], a: AxisRemap, b: AxisRemap): boolean {
  return pieces.some((tab) => {
    if (!POSITIONAL.some((key) => has(tab, key))) return false
    const workbook = { version: 1, title: '', tabs: [{ ...tab, id: tabId }] } as unknown as Workbook
    return !deepEqual(applyRemap(workbook, tabId, a).tabs[0], applyRemap(workbook, tabId, b).tabs[0])
  })
}

/** A tab's positional settings as a multiset of strings, for matching one side against a remapped base. */
function settingItems(tab: Obj): string[] {
  const items: string[] = []
  for (const key of POSITIONAL) {
    const value = tab[key]
    if (value === undefined) continue
    if (key === 'rowMeta' && isObj(value)) for (const [k, v] of Object.entries(value)) items.push(`rowMeta:${k}:${JSON.stringify(v)}`)
    else if (Array.isArray(value)) value.forEach((v, i) => items.push(key === 'columns' ? `columns:${i}:${JSON.stringify(v)}` : `${key}:${JSON.stringify(v)}`))
    else items.push(`${key}:${JSON.stringify(value)}`)
  }
  return items
}

/** Every line index (on `axis`) a tab's settings name, generously: a remap only changes them across these. */
function settingIndices(tab: Obj, axis: Axis): number[] {
  const out = new Set<number>()
  const settings: Obj = {}
  for (const key of POSITIONAL) if (has(tab, key)) settings[key] = tab[key]
  const text = JSON.stringify(settings)
  for (const match of text.matchAll(/([A-Z]{1,3})\$?(\d+)/g)) {
    if (axis === 'row') out.add(Number(match[2]) - 1)
    else out.add(edgeIndex(match[1]!)! - 1)
  }
  if (axis === 'row') {
    if (isObj(tab.rowMeta)) for (const key of Object.keys(tab.rowMeta)) out.add(Number(key) - 1)
    for (const group of Array.isArray(tab.rowGroups) ? tab.rowGroups : []) if (isObj(group)) for (const edge of [group.from, group.to]) if (typeof edge === 'number') out.add(edge - 1)
    if (typeof tab.frozenRows === 'number') out.add(tab.frozenRows - 1)
  } else {
    if (Array.isArray(tab.columns)) tab.columns.forEach((_, i) => out.add(i))
    for (const group of Array.isArray(tab.colGroups) ? tab.colGroups : []) if (isObj(group)) for (const edge of [group.from, group.to]) {
      const index = edgeIndex(edge)
      if (index !== null) out.add(index - 1)
    }
    if (typeof tab.frozenCols === 'number') out.add(tab.frozenCols - 1)
  }
  return [...out].filter((i) => Number.isFinite(i) && i >= 0)
}

/**
 * Of the places `[atMin, atMax]` the cells leave open for a line edit, the ones whose remap of
 * base's settings matches the most of `sideTab`'s settings (a row height or merge that stayed
 * put says the insert went in below it). The score only changes where a remap crosses a line
 * the settings name, so only those places are tried.
 */
function narrowBySettings(tabId: string, baseTab: Obj, sideTab: Obj, make: (at: number) => AxisRemap, axis: Axis, count: number, atMin: number, atMax: number): [number, number] {
  const settingsOnly = (tab: Obj): Obj => {
    const out: Obj = { id: tabId, name: baseTab.name, cells: {}, ...(has(baseTab, 'rows') ? { rows: baseTab.rows } : {}), ...(has(baseTab, 'cols') ? { cols: baseTab.cols } : {}) }
    for (const key of POSITIONAL) if (has(tab, key)) out[key] = tab[key]
    return out
  }
  const baseSettings = settingsOnly(baseTab)
  if (!POSITIONAL.some((key) => has(baseSettings, key))) return [atMin, atMax]
  const wanted = new Map<string, number>()
  for (const item of settingItems(sideTab)) wanted.set(item, (wanted.get(item) ?? 0) + 1)
  const candidates = new Set([atMin, atMax])
  for (const e of settingIndices(baseSettings, axis))
    for (const at of [e - count, e - count + 1, e, e + 1]) if (at >= atMin && at <= atMax) candidates.add(at)
  const sorted = [...candidates].sort((a, b) => a - b)
  const workbook = { version: 1, title: '', tabs: [baseSettings] } as unknown as Workbook
  const scores = sorted.map((at) => {
    const left = new Map(wanted)
    let score = 0
    for (const item of settingItems(applyRemap(workbook, tabId, make(at)).tabs[0] as unknown as Obj)) {
      const n = left.get(item) ?? 0
      if (n > 0) {
        score += 1
        left.set(item, n - 1)
      }
    }
    return score
  })
  const best = Math.max(...scores)
  // Each candidate stands for the places up to the next one.
  let lo = Infinity
  let hi = -Infinity
  sorted.forEach((at, i) => {
    if (scores[i] !== best) return
    lo = Math.min(lo, at)
    hi = Math.max(hi, i + 1 < sorted.length ? sorted[i + 1]! - 1 : atMax)
  })
  return [lo, hi]
}

/**
 * Whether `sideTab` is `baseTab` after one insert or delete of rows or columns (plus cell edits),
 * and which: the line count tells the axis and how many; the cells that stayed and the cells that
 * shifted tell where, and where they leave it open (a sparse tab), the settings that stayed or
 * shifted (row heights, merges, rules…) narrow it. `unknown`: both axes changed, or the cells
 * still look moved after the inferred remap (a move, a sort, two inserts).
 */
function inferLineEdit(workbook: Obj, tabId: string, baseTab: Obj, sideTab: Obj): LineEdit | 'none' | 'unknown' {
  const [rowsB, rowsS, colsB, colsS] = [tabRows(baseTab as SheetTab), tabRows(sideTab as SheetTab), tabCols(baseTab as SheetTab), tabCols(sideTab as SheetTab)]
  if (rowsB === rowsS && colsB === colsS) return 'none'
  if (rowsB !== rowsS && colsB !== colsS) return 'unknown'
  const axis: Axis = rowsB !== rowsS ? 'row' : 'col'
  const length = axis === 'row' ? rowsB : colsB
  const delta = (axis === 'row' ? rowsS : colsS) - length
  const count = Math.abs(delta)
  if (delta < 0 && count >= length) return 'unknown'
  const baseCells = cellsOf(baseTab)
  const sideCells = cellsOf(sideTab)
  // stay[i] / shift[i]: base cells on line i that sit unchanged at their address / shifted by delta.
  const stay = new Float64Array(length + 1)
  const shift = new Float64Array(length + 1)
  for (const [address, cell] of Object.entries(baseCells)) {
    const pos = parseAddress(address)
    if (!pos) continue
    const index = axis === 'row' ? pos.row : pos.col
    if (index >= length) continue
    const key = cellKey(cell)
    if (has(sideCells, address) && cellKey(sideCells[address]) === key) stay[index] += 1
    const moved = index + delta
    if (moved >= 0) {
      const target = toAddress(axis === 'row' ? { row: moved, col: pos.col } : { row: pos.row, col: moved })
      if (has(sideCells, target) && cellKey(sideCells[target]) === key) shift[index] += 1
    }
  }
  const prefixStay = new Float64Array(length + 2)
  for (let i = 0; i <= length; i += 1) prefixStay[i + 1] = prefixStay[i] + stay[i]
  const suffixShift = new Float64Array(length + 2)
  for (let i = length; i >= 0; i -= 1) suffixShift[i] = suffixShift[i + 1] + shift[i]
  const last = delta > 0 ? length : length - count
  let best = -1
  let atMin = 0
  let atMax = 0
  for (let at = 0; at <= last; at += 1) {
    const score = prefixStay[at] + suffixShift[delta > 0 ? at : at + count]
    if (score > best) {
      best = score
      atMin = at
      atMax = at
    } else if (score === best) atMax = at
  }
  const make = (at: number) => (delta > 0 ? insertRemap(axis, at, count, length) : deleteRemap(axis, at, count, length))
  if (atMin < atMax) [atMin, atMax] = narrowBySettings(tabId, baseTab, sideTab, make, axis, count, atMin, atMax)
  const remap = make(atMin)
  const band: [number, number] = delta > 0 ? [atMin, atMax] : [atMin, atMax + count]
  // The inferred edit must explain the move: what is left is plain cell edits.
  const shifted = applyRemap(workbook as Workbook, tabId, remap)
  const shiftedTab = shifted.tabs.find((tab) => tab.id === tabId)
  if (!shiftedTab || looksShifted(cellsOf(shiftedTab), sideCells)) return 'unknown'
  return { remap, axis, kind: delta > 0 ? 'insert' : 'delete', at: atMin, atMax, count, band }
}

const sameLineEdit = (a: LineEdit, b: LineEdit) => a.axis === b.axis && a.kind === b.kind && a.at === b.at && a.count === b.count

/**
 * Whether `other` changed anything of `baseTab` on a line in `band` (where the line edit could
 * have gone either way): a cell, or a setting placed on those lines (a row height, a merge, a
 * rule…) that the edit's possible places would move differently.
 */
function touchesBand(tabId: string, baseTab: Obj, otherTab: Obj, edit: LineEdit): boolean {
  if (edit.band[0] >= edit.band[1]) return false
  const [bc, oc] = [cellsOf(baseTab), cellsOf(otherTab)]
  for (const address of new Set([...Object.keys(bc), ...Object.keys(oc)])) {
    if (deepEqual(bc[address], oc[address])) continue
    const pos = parseAddress(address)
    if (!pos) continue
    const index = edit.axis === 'row' ? pos.row : pos.col
    if (index >= edit.band[0] && index < edit.band[1]) return true
  }
  if (edit.atMax === edit.at || !settingsChanged(baseTab, otherTab)) return false
  const length = edit.remap.length + (edit.kind === 'insert' ? -edit.count : edit.count)
  const make = (at: number) => (edit.kind === 'insert' ? insertRemap(edit.axis, at, edit.count, length) : deleteRemap(edit.axis, at, edit.count, length))
  return remapsDiffer(tabId, settingsDiff(baseTab, otherTab), make(edit.at), make(edit.atMax))
}

/**
 * `side` with its own line edit of `tabId` taken back (the other side won that tab's lines), and
 * nothing else of it: the inverse remap carries its other edits on the tab back to base's lines
 * (cells on lines it inserted go with them; lines it deleted come back as base had them), and
 * every cell or setting the line edit alone rewrote (a formula elsewhere pointing at the tab, a
 * defined name, the tab's own settings) is put back as base had it.
 */
function revertLineEdit(base: Obj, side: Obj, tabId: string, edit: LineEdit): Obj {
  const shifted = applyRemap(base as Workbook, tabId, edit.remap) as unknown as Obj
  const length = edit.remap.length + (edit.kind === 'insert' ? -edit.count : edit.count)
  const inverse =
    edit.kind === 'insert'
      ? deleteRemap(edit.axis, edit.at, edit.count, edit.remap.length)
      : insertRemap(edit.axis, edit.at, edit.count, edit.remap.length)
  const undone = applyRemap(side as Workbook, tabId, inverse) as unknown as Obj
  const tabsById = (o: Obj) => new Map((Array.isArray(o.tabs) ? o.tabs : []).filter(isObj).map((tab) => [String(tab.id), tab]))
  const [baseTabs, shiftedTabs, sideTabs] = [tabsById(base), tabsById(shifted), tabsById(side)]
  /** A line index after the edit → the base line it came from. */
  const back = (address: string): string | null => {
    const pos = parseAddress(address)
    if (!pos) return null
    const index = inverse.map(edit.axis === 'row' ? pos.row : pos.col)
    if (index === null || index >= length) return null
    return toAddress(edit.axis === 'row' ? { row: index, col: pos.col } : { row: pos.row, col: index })
  }
  const tabs = (undone.tabs as unknown[]).map((tab) => {
    if (!isObj(tab)) return tab
    const id = String(tab.id)
    const [baseTab, shiftedTab, sideTab] = [baseTabs.get(id), shiftedTabs.get(id), sideTabs.get(id)]
    if (!baseTab || !shiftedTab || !sideTab) return tab
    const own = id === tabId
    const [bc, shc, sc] = [cellsOf(baseTab), cellsOf(shiftedTab), cellsOf(sideTab)]
    const cells: Obj = { ...cellsOf(tab) }
    // What the line edit alone made of a base cell, which this side left alone: base's cell.
    for (const [address, cell] of Object.entries(shc)) {
      if (!deepEqual(sc[address], cell)) continue
      const from = own ? back(address) : address
      if (from !== null && has(bc, from)) cells[from] = bc[from]
    }
    if (own && edit.kind === 'delete') {
      // The deleted lines, as base had them.
      for (const [address, cell] of Object.entries(bc)) {
        const pos = parseAddress(address)
        const index = pos && (edit.axis === 'row' ? pos.row : pos.col)
        if (index !== null && index >= edit.at && index < edit.at + edit.count) cells[address] = cell
      }
    }
    const out: Obj = { ...tab, cells }
    if (own) {
      // The tab's settings the line edit rewrote (and this side left alone) as base had them.
      for (const key of new Set([...Object.keys(shiftedTab), ...Object.keys(baseTab)])) {
        if (key === 'cells' || !deepEqual(sideTab[key], shiftedTab[key])) continue
        if (has(baseTab, key)) out[key] = baseTab[key]
        else delete out[key]
      }
    }
    return out
  })
  const out: Obj = { ...undone, tabs }
  if (deepEqual(side.names, shifted.names)) {
    if (base.names === undefined) delete out.names
    else out.names = base.names
  }
  return out
}

type Rebased = {
  base: Obj
  mine: Obj
  theirs: Obj
  whole: Map<string, ArtifactMergeSide | null>
  /** Tabs whose lines mine's edit moved in the result (theirs was rebased onto it, or mine's tab taken whole). */
  mineShifted: Set<string>
}

/**
 * Rows or columns inserted or deleted on one side: base and the other side are put through the
 * same remap first, so a merge by address lands every edit where it now belongs (formulas in
 * other tabs pointing at the shifted tab included). An edit on a line the remap deleted (or on a
 * line whose fate is ambiguous), or both sides editing the lines of one tab differently, is a
 * conflict of `rows or columns of tab …`: settled toward the line edit, the other side's edits on
 * those lines go; settled the other way, the line edit (and its rewrites of other tabs) is undone.
 * `whole`: tabs that stay one unit (an edit the rebase cannot explain, or an unsettled conflict).
 *
 * `undoMine`: tabs on which mine's line edit cannot stand whatever the resolution says (a
 * non-owner's insert that would move a range the owner protected meanwhile): it is undone, as a
 * lines conflict settled toward theirs would undo it, and mine's other edits there are kept.
 */
function rebaseSheet(base: Obj, mine: Obj, theirs: Obj, ctx: MergeContext, undoMine: ReadonlySet<string> = new Set()): Rebased {
  const whole = new Map<string, ArtifactMergeSide | null>()
  const mineShifted = new Set<string>()
  const out: Rebased = { base, mine, theirs, whole, mineShifted }
  const lists = [base.tabs, mine.tabs, theirs.tabs]
  if (!lists.every((list) => Array.isArray(list) && list.every((tab) => isObj(tab) && typeof tab.id === 'string' && isObj(tab.cells)))) return out
  const [bm, mm, tm] = (lists as Obj[][]).map((list) => new Map(list.map((tab) => [tab.id as string, tab])))
  const reverts: Array<{ side: ArtifactMergeSide; tabId: string; edit: LineEdit }> = []
  const rebases: Array<{ tabId: string; edit: LineEdit; onto: ArtifactMergeSide[] }> = []
  for (const [tabId, baseTab] of bm) {
    const mineTab = mm.get(tabId)
    const theirTab = tm.get(tabId)
    if (!mineTab || !theirTab) continue
    const name = nameOf('name', theirTab, mineTab, baseTab) ?? tabId
    const lines = unit(`tabs/${tabId}:lines`, `rows or columns of tab ${quote(name)}`)
    const em = inferLineEdit(base, tabId, baseTab, mineTab)
    const et = inferLineEdit(base, tabId, baseTab, theirTab)
    if (em === 'none' && et === 'none') continue
    if (deepEqual(mineTab, theirTab)) {
      if (em !== 'none' && em !== 'unknown') rebases.push({ tabId, edit: em, onto: [] })
      continue
    }
    const undo = undoMine.has(tabId)
    if (em === 'unknown' || et === 'unknown') {
      // A shift the rebase cannot explain: the tab is one unit unless the other side left it alone.
      const other = em === 'unknown' ? theirTab : mineTab
      if ((et !== 'none' && em !== 'none') || !deepEqual(cellsOf(baseTab), cellsOf(other)) || settingsChanged(baseTab, other)) {
        const side = undo && em !== 'none' ? 'theirs' : ctx.conflict(lines)
        whole.set(tabId, side)
        if (side === 'mine' && em !== 'none') mineShifted.add(tabId)
      } else if (em === 'unknown') mineShifted.add(tabId)
      continue
    }
    if (em !== 'none' && et !== 'none') {
      if (sameLineEdit(em, et)) {
        rebases.push({ tabId, edit: em, onto: [] })
        continue
      }
      const side = undo ? 'theirs' : ctx.conflict(lines)
      if (side === null) {
        whole.set(tabId, null)
        continue
      }
      const [keep, drop, loser] = side === 'mine' ? [em, et, 'theirs' as const] : [et, em, 'mine' as const]
      reverts.push({ side: loser, tabId, edit: drop })
      rebases.push({ tabId, edit: keep, onto: [loser] })
      if (side === 'mine') mineShifted.add(tabId)
      continue
    }
    const [structural, edit, other, otherTab] =
      em !== 'none' ? (['mine', em, 'theirs', theirTab] as const) : (['theirs', et as LineEdit, 'mine', mineTab] as const)
    if (undo && structural === 'mine') {
      reverts.push({ side: 'mine', tabId, edit })
      continue
    }
    if (touchesBand(tabId, baseTab, otherTab, edit)) {
      const side = ctx.conflict(lines)
      if (side === null) {
        whole.set(tabId, null)
        continue
      }
      if (side === other) {
        reverts.push({ side: structural, tabId, edit })
        continue
      }
    }
    rebases.push({ tabId, edit, onto: [other] })
    if (structural === 'mine') mineShifted.add(tabId)
  }
  if (reverts.length === 0 && rebases.length === 0) return out
  let [b, m, t] = [base, mine, theirs]
  for (const { side, tabId, edit } of reverts) {
    if (side === 'mine') m = revertLineEdit(base, m, tabId, edit)
    else t = revertLineEdit(base, t, tabId, edit)
  }
  for (const { tabId, edit, onto } of rebases) {
    b = applyRemap(b as Workbook, tabId, edit.remap) as unknown as Obj
    if (onto.includes('mine')) m = applyRemap(m as Workbook, tabId, edit.remap) as unknown as Obj
    if (onto.includes('theirs')) t = applyRemap(t as Workbook, tabId, edit.remap) as unknown as Obj
  }
  return { base: b, mine: m, theirs: t, whole, mineShifted }
}

/**
 * The lines a one-line move on `side` displaced, per axis: a base cell whose address `side`
 * emptied and whose content turns up on another line of the same column (a row move or sort) or
 * row (a column move), at an address base left empty. A move of one filled line looks like nothing else, but
 * every line between where it was and where it went shifted by one.
 */
function movedSpans(base: Obj, side: Obj): Array<{ axis: Axis; lo: number; hi: number }> {
  const at = new Map<string, string[]>()
  for (const [address, cell] of Object.entries(side)) {
    const key = cellKey(cell)
    const list = at.get(key) ?? []
    list.push(address)
    at.set(key, list)
  }
  const spans: Array<{ axis: Axis; lo: number; hi: number }> = []
  for (const [address, cell] of Object.entries(base)) {
    // A move of one filled line empties where it was and fills where nothing was (anything more
    // moves two cells, which `looksShifted` sees); an edit in place does neither.
    if (has(side, address)) continue
    const key = cellKey(cell)
    const from = parseAddress(address)
    if (!from) continue
    for (const other of at.get(key) ?? []) {
      if (has(base, other)) continue
      const to = parseAddress(other)
      if (!to) continue
      if (to.col === from.col && to.row !== from.row) spans.push({ axis: 'row', lo: Math.min(from.row, to.row), hi: Math.max(from.row, to.row) })
      else if (to.row === from.row && to.col !== from.col) spans.push({ axis: 'col', lo: Math.min(from.col, to.col), hi: Math.max(from.col, to.col) })
    }
  }
  return spans
}

/** Whether `other` changed a cell or a setting of `baseTab` on a line `mover` displaced by a move. */
function touchesMoved(tabId: string, baseTab: Obj, mover: Obj, other: Obj): boolean {
  const spans = movedSpans(cellsOf(baseTab), cellsOf(mover))
  if (!spans.length) return false
  const [bc, oc] = [cellsOf(baseTab), cellsOf(other)]
  const changed = [...new Set([...Object.keys(bc), ...Object.keys(oc)])].filter((address) => !deepEqual(bc[address], oc[address]))
  const pieces = settingsChanged(baseTab, other) ? settingsDiff(baseTab, other) : []
  return spans.some(({ axis, lo, hi }) => {
    const hit = changed.some((address) => {
      const pos = parseAddress(address)
      const index = pos && (axis === 'row' ? pos.row : pos.col)
      return index !== null && index >= lo && index <= hi
    })
    if (hit) return true
    if (!pieces.length) return false
    const length = Math.max(hi + 1, axis === 'row' ? tabRows(baseTab as SheetTab) : tabCols(baseTab as SheetTab))
    const identity = insertRemap(axis, length, 0, length)
    return remapsDiffer(tabId, pieces, identity, moveRemap(axis, lo, 1, hi, length)) || remapsDiffer(tabId, pieces, identity, moveRemap(axis, hi, 1, lo, length))
  })
}

type SheetMerge = { merged: Obj; mineShifted: Set<string> }

function mergeSheet(base0: Obj, mine0: Obj, theirs0: Obj, ctx: MergeContext, undoMine: ReadonlySet<string> = new Set()): SheetMerge {
  const { base, mine, theirs, whole, mineShifted } = rebaseSheet(base0, mine0, theirs0, ctx, undoMine)
  const merged = mergeFields(base, mine, theirs, ctx, topUnit, {
    revision: maxField,
    deletedTabs: deletedTabsField,
    tabs: keyedListField({
      item: (id, ...tabs) => unit(`tabs/${id}`, `tab ${quote(nameOf('name', ...tabs) ?? id)}`),
      order: unit('tabs:order', 'tab order'),
      whole: unit('tabs', 'tabs'),
      inner: (id) => (b, m, t, c) => {
        const tabName = nameOf('name', t, m, b) ?? id
        if (whole.has(id)) return pickSide(whole.get(id) ?? null, m, t)
        // Lines moved in a way the rebase did not explain (a move, a sort): merged by address
        // with the other side's cell edits, a value would land in the wrong cell. Both sides
        // editing the cells of such a tab is a conflict of the whole tab.
        // A move of one filled line is caught by the lines it displaced, and only when the other
        // side changed something there. Settings count too: a row height lands on a row as a
        // value does.
        const bc = cellsOf(b)
        const changed = (side: unknown) => !deepEqual(bc, cellsOf(side)) || settingsChanged(b, side)
        const moved = (side: Obj, other: Obj) =>
          !deepEqual(bc, cellsOf(side)) && changed(other) && (looksShifted(bc, cellsOf(side)) || (isObj(b) && touchesMoved(id, b, side, other)))
        const mineMoved = isObj(m) && isObj(t) && moved(m, t)
        const theirsMoved = isObj(m) && isObj(t) && moved(t, m)
        if (mineMoved || theirsMoved) {
          // Mine's move cannot stand on this tab (see `rebaseSheet`'s `undoMine`): theirs' tab.
          if (mineMoved && undoMine.has(id)) return t
          const side = c.conflict(unit(`tabs/${id}:lines`, `rows or columns of tab ${quote(tabName)}`))
          if (side === 'mine' && mineMoved) mineShifted.add(id)
          return pickSide(side, m, t)
        }
        if (!isObj(b) || !isObj(m) || !isObj(t)) return mergeUnit(b, m, t, unit(`tabs/${id}`, `tab ${quote(tabName)}`), c)
        const cellUnit = (address: string) =>
          address === '*' ? unit(`tabs/${id}/cells`, `cells of tab ${quote(tabName)}`) : unit(`tabs/${id}/cells/${address}`, `cell ${tabName}!${address}`)
        return mergeFields(b, m, t, c, (key) => unit(`tabs/${id}/${key}`, `${key} of tab ${quote(tabName)}`), {
          cells: recordField(cellUnit, (address) => objectInner(cellUnit(address), {}, [CELL_VALUE])),
          rowGroups: lineGroupsField(unit(`tabs/${id}/rowGroups`, `rowGroups of tab ${quote(tabName)}`)),
          colGroups: lineGroupsField(unit(`tabs/${id}/colGroups`, `colGroups of tab ${quote(tabName)}`)),
          // Tables, conditional-format rules and charts: each keyed by id, merged key by key.
          ...Object.fromEntries(
            (
              [
                ['tables', 'table'],
                ['rules', 'rule'],
                ['charts', 'chart'],
              ] as const
            ).map(([field, noun]) => [
              field,
              keyedListField({
                item: (itemId) => unit(`tabs/${id}/${field}/${itemId}`, `${noun} ${quote(itemId)} of tab ${quote(tabName)}`),
                order: unit(`tabs/${id}/${field}:order`, `${noun} order of tab ${quote(tabName)}`),
                whole: unit(`tabs/${id}/${field}`, `${field} of tab ${quote(tabName)}`),
              }),
            ]),
          ),
        })
      },
    }),
  })
  return { merged, mineShifted }
}

const tokensUnit = unit('tokens', 'design tokens')
const mergeSlides: JsonMerger = (base, mine, theirs, ctx) => {
  const deck = mergeFields(base, mine, theirs, ctx, topUnit, {
    // A design-system token set: each colour role, the spacing and the name its own unit.
    tokens: objectField(tokensUnit, { colors: objectField(tokensUnit) }),
    slides: keyedListField({
      item: (id) => unit(`slides/${id}`, `slide ${quote(id)}`),
      order: unit('slides:order', 'slide order'),
      whole: unit('slides', 'slides'),
      inner: (id) =>
        objectInner(unit(`slides/${id}`, `slide ${quote(id)}`), {
          // Free-position elements: each its own entity, merged key by key; their order is the
          // stacking order (back to front).
          elements: keyedListField({
            item: (elementId) => unit(`slides/${id}/elements/${elementId}`, `element ${quote(elementId)} on slide ${quote(id)}`),
            order: unit(`slides/${id}/elements:order`, `element order on slide ${quote(id)}`),
            whole: unit(`slides/${id}/elements`, `elements of slide ${quote(id)}`),
          }),
        }),
    }),
  })
  // A concurrent deletion can remove the slide the other editor chose as the thumbnail.
  if (typeof deck.thumbnailSlideId === 'string' && Array.isArray(deck.slides)
    && !deck.slides.some((slide) => isObj(slide) && slide.id === deck.thumbnailSlideId)) {
    delete deck.thumbnailSlideId
  }
  return deck
}

// Whiteboard: elements keyed by id, each merged key by key (a move on one side and a text edit on
// the other both land); the list order is the layer order. Deleting an element removes the arrows
// bound to it and detaches its stickers (`deleteElements` in whiteboard-ops.ts), so before merging
// each side's clean deletions are replayed onto the other side's elements, and after merging a
// sweep drops any arrow still bound to a missing element and detaches any orphaned sticker.

export const boundId = (end: unknown): string | null => (isObj(end) && typeof end.elementId === 'string' ? end.elementId : null)

/** `elements` with arrows bound to `gone` removed and stickers attached to `gone` detached. */
export function withoutBoundTo(elements: unknown[], gone: (id: string) => boolean): unknown[] {
  const out: unknown[] = []
  for (const element of elements) {
    if (!isObj(element)) {
      out.push(element)
      continue
    }
    if (element.type === 'arrow') {
      const [from, to] = [boundId(element.from), boundId(element.to)]
      if ((from !== null && gone(from)) || (to !== null && gone(to))) continue
    }
    if (element.type === 'sticker' && typeof element.attachedTo === 'string' && gone(element.attachedTo)) {
      const { attachedTo: _gone, ...rest } = element
      out.push(rest)
      continue
    }
    out.push(element)
  }
  return out
}

/** Ids `side` deleted from `base` that `other` left as they were (the delete stands). */
function cleanDeletes(base: Map<string, unknown>, side: Map<string, unknown>, other: Map<string, unknown>): Set<string> {
  const gone = new Set<string>()
  for (const [id, element] of base) {
    if (side.has(id)) continue
    if (!other.has(id) || deepEqual(other.get(id), element)) gone.add(id)
  }
  return gone
}

/** A note's dot-vote tally: both sides' votes count (base + each side's change). */
const votesField =
  (u: Unit): FieldMerger =>
  (b, m, t, ctx) => {
    if (same(m, t) || same(b, m) || same(b, t)) return mergeUnit(b, m, t, u, ctx)
    const n = (v: Maybe) => (v === ABSENT ? 0 : v)
    const [bn, mn, tn] = [n(b), n(m), n(t)]
    if (typeof bn !== 'number' || typeof mn !== 'number' || typeof tn !== 'number') return mergeUnit(b, m, t, u, ctx)
    const total = Math.max(0, bn + (mn - bn) + (tn - bn))
    return total === 0 && m !== 0 && t !== 0 ? ABSENT : total
  }

const mergeWhiteboard: JsonMerger = (base, mine, theirs, ctx) => {
  const lists = [base.elements, mine.elements, theirs.elements]
  if (lists.every(Array.isArray)) {
    const maps = (lists as unknown[][]).map((list) => keyed(list))
    const [bm, mm, tm] = maps
    if (bm && mm && tm) {
      const goneMine = cleanDeletes(bm, mm, tm)
      const goneTheirs = cleanDeletes(bm, tm, mm)
      mine = { ...mine, elements: withoutBoundTo(mine.elements as unknown[], (id) => goneTheirs.has(id)) }
      theirs = { ...theirs, elements: withoutBoundTo(theirs.elements as unknown[], (id) => goneMine.has(id)) }
    }
  }
  const out = mergeFields(base, mine, theirs, ctx, topUnit, {
    elements: keyedListField({
      item: (id) => unit(`elements/${id}`, `element ${quote(id)}`),
      order: unit('elements:order', 'element order'),
      whole: unit('elements', 'elements'),
      // Key by key; a table's cells, merged cells and column / row weights only make sense
      // together (a merge or a weight names a row or column), so they are one unit.
      inner: (id) =>
        objectInner(unit(`elements/${id}`, `element ${quote(id)}`), { votes: votesField(unit(`elements/${id}`, `element ${quote(id)}`)) }, [
          ['rows', 'merges', 'colWidths', 'rowHeights'],
        ]),
    }),
  })
  if (Array.isArray(out.elements)) {
    const present = new Set(out.elements.map(idOf).filter((id): id is string => id !== null))
    out.elements = withoutBoundTo(out.elements, (id) => !present.has(id))
  }
  return out
}

const dataList = (field: string, noun: string) =>
  keyedListField({
    item: (id) => unit(`${field}/${id}`, `${noun} ${quote(id)}`),
    order: unit(`${field}:order`, `${noun} order`),
    whole: unit(field, field),
  })

const dataAppearance: FieldMerger = (base, mine, theirs, ctx) => {
  const sides = asObjects(base, mine, theirs)
  if (!sides) return ABSENT
  const merged = mergeFields(...sides, ctx, (key) => unit(`appearance/${key}`, `dashboard design ${key}`))
  return Object.keys(merged).length ? merged : ABSENT
}

const mergeData: JsonMerger = (base, mine, theirs, ctx) =>
  mergeFields(base, mine, theirs, ctx, topUnit, {
    appearance: dataAppearance,
    sources: dataList('sources', 'source'),
    datasets: dataList('datasets', 'dataset'),
    blocks: dataList('blocks', 'block'),
    filters: dataList('filters', 'filter'),
    params: dataList('params', 'parameter'),
  })

// Design: boards keyed by id; their nodes merged as ONE map across the whole design (ids are
// unique design-wide, so a node may move between boards). Each node is its own props (everything
// but `children`), where it sits (its parent: a frame, or a board for a root), and, for a frame,
// the order of its children. A node is placed under its merged parent, so a move on one side and
// an edit on the other both land; the trees are rebuilt from the merged map. A node no tree
// reaches any more (two moves forming a cycle) is a conflict rather than a silent loss.

type FlatNode = { props: Obj; kids: string[] | null; parent: string }
type FlatDesign = { boards: Obj[]; nodes: Map<string, FlatNode>; boardOf: Map<string, string> }

class NotFlat extends Error {}

const boardParent = (boardId: string) => `board:${boardId}`

function flattenDesign(design: Obj): FlatDesign {
  const nodes = new Map<string, FlatNode>()
  const boardOf = new Map<string, string>()
  if (design.boards !== undefined && !Array.isArray(design.boards)) throw new NotFlat()
  const boards = ((design.boards as unknown[] | undefined) ?? []).map((board) => {
    if (!isObj(board) || typeof board.id !== 'string' || !isObj(board.root)) throw new NotFlat()
    const boardId = board.id
    const visit = (node: unknown, parent: string): string => {
      const id = idOf(node)
      if (id === null || nodes.has(id) || id.startsWith('board:')) throw new NotFlat()
      const { children, ...props } = node as Obj
      const flat: FlatNode = { props, kids: null, parent }
      nodes.set(id, flat)
      boardOf.set(id, boardId)
      if (children !== undefined) {
        if (!Array.isArray(children)) throw new NotFlat()
        flat.kids = children.map((child) => visit(child, id))
      }
      return id
    }
    const { root, ...rest } = board
    return { ...rest, root: visit(root, boardParent(boardId)) }
  })
  return { boards, nodes, boardOf }
}

/** A frame's child list changed: a child added or moved in, or the kept ones reordered (not a child leaving). */
function kidsChanged(base: string[] | null, side: string[] | null): boolean {
  if (base === null || side === null) return base !== side
  const before = new Set(base)
  if (side.some((id) => !before.has(id))) return true
  const after = new Set(side)
  return !arraysEqual(base.filter((id) => after.has(id)), side)
}

const nodeChanged = (base: unknown, side: unknown) => {
  const [b, s] = [base as FlatNode, side as FlatNode]
  return !deepEqual(b.props, s.props) || b.parent !== s.parent || kidsChanged(b.kids, s.kids)
}

const mergeDesign: JsonMerger = (base, mine, theirs, ctx) => {
  let flat: FlatDesign[]
  try {
    flat = [base, mine, theirs].map(flattenDesign)
  } catch (error) {
    if (!(error instanceof NotFlat)) throw error
    return pickSide(ctx.conflict(BODY), mine, theirs)
  }
  const [fb, fm, ft] = flat
  const boardTitle = (id: string) => {
    const find = (f: FlatDesign) => f.boards.find((board) => idOf(board) === id)
    return nameOf('title', find(ft), find(fm), find(fb)) ?? id
  }
  const boardUnit = (id: string) => unit(`boards/${id}`, `board ${quote(boardTitle(id))}`)
  const boardList = keyedListField({
    item: (id) => boardUnit(id),
    order: unit('boards:order', 'board order'),
    whole: unit('boards', 'boards'),
    inner: (id) => (b, m, t, c) => {
      const of = (key: string) => unit(`boards/${id}/${key}`, `${key} of board ${quote(boardTitle(id))}`)
      return mergeFields(b as Obj, m as Obj, t as Obj, c, of, {
        // More widths the board designs for, keyed by id (a node's `responsive` keys name them).
        breakpoints: keyedListField({
          item: (breakpointId) => unit(`boards/${id}/breakpoints/${breakpointId}`, `breakpoint ${quote(breakpointId)} of board ${quote(boardTitle(id))}`),
          order: of('breakpoint order'),
          whole: of('breakpoints'),
        }),
        // Ruler guides: positions on each axis, each side's added and removed guides both land.
        guides: objectField(of('guides'), { x: setListField(of('guides')), y: setListField(of('guides')) }),
      })
    },
  })
  const styleUnit = unit('styles', 'styles')
  const top = mergeFields({ ...base, boards: fb.boards }, { ...mine, boards: fm.boards }, { ...theirs, boards: ft.boards }, ctx, topUnit, {
    boards: boardList,
    pages: keyedListField({ item: (id) => unit(`pages/${id}`, `page ${quote(id)}`), order: unit('pages:order', 'page order'), whole: unit('pages', 'pages') }),
    notes: keyedListField({ item: (id) => unit(`notes/${id}`, `note ${quote(id)}`), order: unit('notes:order', 'note order'), whole: unit('notes', 'notes') }),
    // Round 5: variables, data lists, installed systems and link cards, each keyed by id.
    ...Object.fromEntries(
      (
        [
          ['variables', 'variable'],
          ['data', 'data list'],
          ['installedSystems', 'installed system'],
          ['links', 'link card'],
        ] as const
      ).map(([field, noun]) => [
        field,
        keyedListField({ item: (id) => unit(`${field}/${id}`, `${noun} ${quote(id)}`), order: unit(`${field}:order`, `${noun} order`), whole: unit(field, field) }),
      ]),
    ),
    // Shared text and fill styles, each keyed by id (nodes name them in `textStyle` / `fillStyle`).
    styles: objectField(styleUnit, {
      text: keyedListField({ item: (id) => unit(`styles/text/${id}`, `text style ${quote(id)}`), order: unit('styles/text:order', 'text style order'), whole: styleUnit }),
      fills: keyedListField({ item: (id) => unit(`styles/fills/${id}`, `fill style ${quote(id)}`), order: unit('styles/fills:order', 'fill style order'), whole: styleUnit }),
    }),
  })

  const nodeLabel = (id: string) => {
    const boardId = ft.boardOf.get(id) ?? fm.boardOf.get(id) ?? fb.boardOf.get(id)
    return boardId === undefined ? `node ${quote(id)}` : `node ${quote(id)} on board ${quote(boardTitle(boardId))}`
  }
  const nodeUnit = (id: string) => unit(`nodes/${id}`, nodeLabel(id))
  const kidsOf = (f: FlatDesign, id: string) => f.nodes.get(id)?.kids ?? []
  const nodes = new Map<string, FlatNode>()
  /** Nodes a settled conflict deleted: what sat in them goes with them. */
  const settledGone = new Set<string>()
  /** Frames whose child order a settled conflict gave to one side. */
  const orderSide = new Map<string, ArtifactMergeSide | null>()
  for (const id of new Set([...ft.nodes.keys(), ...fm.nodes.keys(), ...fb.nodes.keys()])) {
    const get = (f: FlatDesign): Maybe => f.nodes.get(id) ?? ABSENT
    const u = nodeUnit(id)
    const inner: Inner = (b, m, t, c) => {
      const [bn, mn, tn] = [b, m, t] as FlatNode[]
      // A node's props key by key; its per-breakpoint overrides each by breakpoint, then key by key.
      const props = mergeFields(bn.props, mn.props, tn.props, c, () => u, {
        responsive: recordField(() => u),
        constraints: objectField(u),
      })
      const parent = mergeUnit(bn.parent, mn.parent, tn.parent, unit(`nodes/${id}:parent`, `where ${u.label} sits`), c) as string
      // The same frame's children changed differently on both sides: their order is one unit
      // (children added on either side are kept wherever the order comes from).
      const [bk, mk, tk] = [bn.kids, mn.kids, tn.kids]
      if (bk && mk && tk && !arraysEqual(bk, mk) && !arraysEqual(bk, tk) && !arraysEqual(mk, tk)) {
        orderSide.set(id, c.conflict(unit(`nodes/${id}:children`, `children of ${u.label}`)))
      }
      return { props, kids: bk !== null || mk !== null || tk !== null ? [] : null, parent }
    }
    const value = mergeEntity(get(fb), get(fm), get(ft), u, ctx, inner, nodeChanged)
    if (value === ABSENT) {
      if (ctx.decided(u.key)) settledGone.add(id)
      continue
    }
    const node = value as FlatNode
    nodes.set(id, { props: node.props, kids: node.kids === null ? null : [], parent: node.parent })
  }
  if (ctx.unresolved.length > 0) return mine

  // A kept node needs its container: one deleted on the other side comes back (only a settled
  // conflict gets here: keeping a node the other side deleted along with its frame or board).
  const boards = (Array.isArray(top.boards) ? top.boards : []).filter(isObj)
  const boardIds = new Set(boards.map((board) => String(board.id)))
  const restore = (parent: string) => {
    for (let at = parent, guard = 0; guard < 10_000; guard += 1) {
      if (at.startsWith('board:')) {
        const boardId = at.slice('board:'.length)
        if (boardIds.has(boardId) || ctx.decided(`boards/${boardId}`)) return
        const board = [fm, ft].map((f) => f.boards.find((b) => b.id === boardId)).find(isObj)
        if (board) {
          boards.push(board)
          boardIds.add(boardId)
        }
        return
      }
      if (nodes.has(at) || settledGone.has(at)) return
      const side = [fm, ft].find((f) => f.nodes.has(at))
      if (!side) return
      const source = side.nodes.get(at)!
      nodes.set(at, { props: source.props, kids: source.kids === null ? null : [], parent: source.parent })
      // The container comes back whole: the delete that took it is undone, not half-kept.
      const fill = (id: string) => {
        for (const kid of side.nodes.get(id)?.kids ?? []) {
          const node = side.nodes.get(kid)
          if (!node || nodes.has(kid) || settledGone.has(kid)) continue
          nodes.set(kid, { props: node.props, kids: node.kids === null ? null : [], parent: node.parent })
          fill(kid)
        }
      }
      fill(at)
      at = source.parent
    }
  }
  for (const node of [...nodes.values()]) restore(node.parent)

  const build = () => {
    const placed = new Map<string, string[]>()
    for (const [id, node] of nodes) {
      const list = placed.get(node.parent) ?? []
      list.push(id)
      placed.set(node.parent, list)
    }
    const used = new Set<string>()
    const tree = (id: string): Obj => {
      used.add(id)
      const node = nodes.get(id)!
      const keep = new Set(placed.get(id) ?? [])
      if (node.kids === null && keep.size === 0) return { ...node.props }
      const order = mergeOrder(kidsOf(fb, id), kidsOf(fm, id), kidsOf(ft, id), keep, unit(`nodes/${id}:children`, `children of ${nodeLabel(id)}`), ctx, orderSide.get(id) ?? null)
      return { ...node.props, children: order.filter((kid) => !used.has(kid)).map(tree) }
    }
    const built = boards.map((board) => {
      const rootId = String(board.root)
      const root = nodes.get(rootId)
      if (!root || root.parent !== boardParent(String(board.id))) {
        ctx.unsettled(unit(`boards/${String(board.id)}:root`, `${boardUnit(String(board.id)).label}: node ${quote(rootId)} is gone`))
        return board
      }
      return { ...board, root: tree(rootId) }
    })
    return { built, used }
  }
  let { built, used } = build()
  // Unreached: under a node a settled conflict deleted (it goes too), or a cycle of two moves.
  const gone = (id: string) => {
    for (let at: string | undefined = id, guard = 0; at !== undefined && guard < 10_000; guard += 1) {
      if (settledGone.has(at)) return true
      at = nodes.get(at)?.parent
    }
    return false
  }
  let retried = false
  for (const id of [...nodes.keys()]) {
    if (used.has(id)) continue
    if (gone(id)) {
      nodes.delete(id)
      continue
    }
    const side = ctx.conflict(unit(`nodes/${id}:parent`, `${nodeLabel(id)} is no longer on any board`))
    const placedOn = side && (side === 'mine' ? fm : ft).nodes.get(id)
    if (placedOn) {
      nodes.get(id)!.parent = placedOn.parent
      retried = true
    }
  }
  if (retried) ({ built, used } = build())
  // Still unreached after taking a side's placement: no choice settles it.
  for (const id of nodes.keys()) {
    if (!used.has(id) && ctx.decided(`nodes/${id}:parent`)) ctx.unsettled(unit(`nodes/${id}:cycle`, `${nodeLabel(id)} is no longer on any board`))
  }
  return { ...top, boards: built }
}

const JSON_MERGERS: Record<Exclude<ArtifactKind, 'doc'>, JsonMerger> = {
  sheet: (b, m, t, ctx) => mergeSheet(b, m, t, ctx).merged,
  slides: mergeSlides,
  whiteboard: mergeWhiteboard,
  data: mergeData,
  design: mergeDesign,
}

// ---------------------------------------------------------------------------------------------
// Doc (Markdown)
// ---------------------------------------------------------------------------------------------

/** Above this many cells of the LCS table the doc is merged as one unit. */
const MAX_LCS_CELLS = 4_000_000

/**
 * A doc's top-level blocks (`splitBlocks`: blank lines, fences kept whole) merged diff3-style.
 * Each side's changes are hunks over base's blocks; hunks that touch different base blocks
 * merge, overlapping hunks (or two insertions at one spot) conflict unless identical, one
 * conflict per run of overlapping hunks, settled by taking one side's hunks for that run. The
 * merge is rejoined with one blank line between blocks, as the doc view's block edits join them,
 * and keeps the trailing newline and CRLF line endings `theirs` had.
 */
function mergeDoc(base: string, mine: string, theirs: string, ctx: MergeContext): string {
  if (mine === base || mine === theirs) return theirs
  if (theirs === base) return mine
  const [b, m, t] = [base, mine, theirs].map(splitDocSuggestions)
  if (!b.suggestions.length && !m.suggestions.length && !t.suggestions.length) return mergeDocBlocks(base, mine, theirs, ctx)
  // The suggestions sidecar (doc-suggestions.ts) is not a block of the doc: the text merges by
  // block, the suggestions by id, and the one sidecar is re-attached at the end, so a merge
  // never duplicates or drops it, nor reports its raw lines as a clashing block.
  const content = mergeDocBlocks(b.content, m.content, t.content, ctx)
  const records = mergeSuggestions(b.suggestions, m.suggestions, t.suggestions, ctx)
  const hashes = docBodyLayout(content).map((block) => docBlockHash(block.source))
  const rebased = records.map((record) => {
    if (record.kind !== 'id') return record
    const matches = hashes.filter((hash) => hash === record.hash).length
    if (matches === 0) return null
    // A changed duplicate count can shift the recorded occurrence. Keep it only when the
    // selected side already saw that count. Otherwise ask for a side rather than retarget an id.
    const key = JSON.stringify(record)
    const sources = [m, t].filter((side) => side.suggestions.some((item) => JSON.stringify(item) === key))
    const safe = sources.every((side) => {
      const count = docBodyLayout(side.content).filter((block) => docBlockHash(block.source) === record.hash).length
      return Math.max(count, matches) <= 1 || count === matches
    })
    if (!safe) return null
    if (matches !== 1) return record
    const { occurrence: _occurrence, ...unique } = record
    return unique
  })
  if (rebased.some((record) => record === null))
    return pickSide(ctx.conflict(unit('block-identities', 'paragraph identities after duplicate edits')), mine, theirs)
  return joinDocSuggestions(content, rebased as DocSuggestionRecord[])
}

/** Suggestions keyed by id, three-way: added on either side kept, removed on either side gone. */
function mergeSuggestions(
  base: DocSuggestionRecord[],
  mine: DocSuggestionRecord[],
  theirs: DocSuggestionRecord[],
  ctx: MergeContext,
): DocSuggestionRecord[] {
  const key = (record: DocSuggestionRecord | undefined) => (record ? JSON.stringify(record) : null)
  const byId = (list: DocSuggestionRecord[]) => new Map(list.map((record) => [record.id, record]))
  const [b, m, t] = [byId(base), byId(mine), byId(theirs)]
  const ids = [...new Set([...theirs.map((r) => r.id), ...mine.map((r) => r.id)])]
  const records: DocSuggestionRecord[] = []
  for (const id of ids) {
    const [bk, mk, tk] = [key(b.get(id)), key(m.get(id)), key(t.get(id))]
    let chosen: DocSuggestionRecord | undefined
    if (mk === tk || mk === bk) chosen = t.get(id)
    else if (tk === bk) chosen = m.get(id)
    else {
      // Changed differently on both sides, or changed on one and resolved on the other.
      chosen = pickSide(ctx.conflict(unit(`suggestions/${id}`, `suggestion ${quote(id)}`)), m.get(id), t.get(id))
    }
    if (chosen) records.push(chosen)
  }
  return records
}

type SidedHunk = Hunk & { side: ArtifactMergeSide }

function mergeDocBlocks(base: string, mine: string, theirs: string, ctx: MergeContext): string {
  if (mine === base || mine === theirs) return theirs
  if (theirs === base) return mine
  const b = splitBlocks(base)
  const m = splitBlocks(mine)
  const t = splitBlocks(theirs)
  // Only blank-line differences on a side: that side changed no block.
  if (arraysEqual(b, m) || arraysEqual(m, t)) return theirs
  if (arraysEqual(b, t)) return mine
  const mineHunks = hunks(b, m)
  const theirHunks = hunks(b, t)
  if (!mineHunks || !theirHunks) return pickSide(ctx.conflict(BODY), mine, theirs)

  // Runs of hunks that overlap (transitively); a run with both sides' hunks is one conflict.
  const all: SidedHunk[] = [...mineHunks.map((h) => ({ ...h, side: 'mine' as const })), ...theirHunks.map((h) => ({ ...h, side: 'theirs' as const }))]
  all.sort((x, y) => x.start - y.start || (x.end - x.start) - (y.end - y.start) || (x.side === 'mine' ? -1 : 1))
  const runs: SidedHunk[][] = []
  for (const h of all) {
    const run = runs[runs.length - 1]
    if (run && run.some((other) => overlaps(h, other))) run.push(h)
    else runs.push([h])
  }
  const chosen: Hunk[] = []
  for (const run of runs) {
    const mineRun = run.filter((h) => h.side === 'mine')
    const theirRun = run.filter((h) => h.side === 'theirs')
    if (mineRun.length === 0 || theirRun.length === 0) {
      chosen.push(...run)
      continue
    }
    if (mineRun.length === theirRun.length && mineRun.every((h, i) => sameHunk(h, theirRun[i]))) {
      chosen.push(...mineRun)
      continue
    }
    // Named after its first hunk (mine's on a tie, as the run is sorted).
    const start = Math.min(...run.map((h) => h.start))
    const end = Math.max(...run.map((h) => h.end))
    const side = ctx.conflict(unit(`blocks/${start}-${end}`, hunkLabel(b, run[0])))
    chosen.push(...(side === 'theirs' ? theirRun : mineRun))
  }

  // Insertions before replacements that start at the same block.
  chosen.sort((x, y) => x.start - y.start || (x.end - x.start) - (y.end - y.start))
  const out: string[] = []
  let pos = 0
  for (const h of chosen) {
    out.push(...b.slice(pos, h.start), ...h.blocks)
    pos = Math.max(pos, h.end)
  }
  out.push(...b.slice(pos))
  const normalized = theirs.replace(/\r\n?/g, '\n')
  const trailing = /\n*$/.exec(normalized)?.[0] ?? ''
  let body = out.join('\n\n') + (out.length > 0 ? trailing : '')
  if (theirs.includes('\r\n')) body = body.replace(/\n/g, '\r\n')
  return body
}

/** Base blocks `start`..`end` replaced by `blocks` (an insertion when start === end). */
type Hunk = { start: number; end: number; blocks: string[] }

const sameHunk = (a: Hunk, b: Hunk) => a.start === b.start && a.end === b.end && arraysEqual(a.blocks, b.blocks)

function overlaps(a: Hunk, b: Hunk): boolean {
  if (a.start === a.end && b.start === b.end) return a.start === b.start
  return a.start < b.end && b.start < a.end
}

function hunkLabel(base: string[], h: Hunk): string {
  const snippet = (text: string) => {
    const line = text.split('\n')[0].trim()
    return line.length > 40 ? `${line.slice(0, 40)}…` : line
  }
  // In a doc with tabs, which tab: an insertion at a tab's marker ends the tab before it.
  const tabs = docTabs(base)
  const tab = tabs.length > 1 ? tabOfBlock(tabs, Math.max(0, h.start < h.end ? h.start : h.start - 1)) : undefined
  const where = tab ? ` in tab ${quote(tab.name)}` : ''
  if (h.start < h.end) return `block ${h.start + 1} (${quote(snippet(base[h.start]))})${where}`
  if (h.start === 0) return 'the start of the doc'
  return `after block ${h.start} (${quote(snippet(base[h.start - 1]))})${where}`
}

/** The hunks turning `base` into `side`, from a longest-common-subsequence alignment. */
function hunks(base: string[], side: string[]): Hunk[] | null {
  let prefix = 0
  while (prefix < base.length && prefix < side.length && base[prefix] === side[prefix]) prefix += 1
  let suffix = 0
  while (
    suffix < base.length - prefix &&
    suffix < side.length - prefix &&
    base[base.length - 1 - suffix] === side[side.length - 1 - suffix]
  )
    suffix += 1
  const a = base.slice(prefix, base.length - suffix)
  const c = side.slice(prefix, side.length - suffix)
  if ((a.length + 1) * (c.length + 1) > MAX_LCS_CELLS) return null
  // lcs[i][j]: the LCS length of a[i..] and c[j..].
  const width = c.length + 1
  const lcs = new Uint32Array((a.length + 1) * width)
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = c.length - 1; j >= 0; j -= 1) {
      lcs[i * width + j] = a[i] === c[j] ? lcs[(i + 1) * width + j + 1] + 1 : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1])
    }
  }
  const pairs: Array<[number, number]> = []
  let i = 0
  let j = 0
  while (i < a.length && j < c.length) {
    if (a[i] === c[j]) {
      pairs.push([i, j])
      i += 1
      j += 1
    } else if (lcs[(i + 1) * width + j] >= lcs[i * width + j + 1]) i += 1
    else j += 1
  }
  pairs.push([a.length, c.length])
  const out: Hunk[] = []
  let pi = 0
  let pj = 0
  for (const [bi, si] of pairs) {
    if (bi > pi || si > pj) out.push({ start: prefix + pi, end: prefix + bi, blocks: c.slice(pj, si) })
    pi = bi + 1
    pj = si + 1
  }
  return out
}


// ---- sheet protection across a merge

const PROTECTION: ArtifactMergeUnit = { key: 'protection', label: 'a range the owner protected meanwhile' }
const OWNER_PROTECTION: ArtifactMergeUnit = { key: 'protection', label: 'a protected range changed on both sides' }

/**
 * A sheet's merge, then its protections. The store checks the save of this merge against what
 * it holds (theirs): as the owner's when `mineIsOwner`, else as a non-owner's.
 */
function mergeSheetBodies(b: Obj, m: Obj, t: Obj, resolution: ArtifactMergeResolution | undefined, mineIsOwner: boolean): { ctx: MergeContext; workbook: Workbook } {
  const [base, mine, theirs] = [b, m, t] as unknown as Workbook[]
  const ctx = new MergeContext(resolution)
  const first = mergeSheet(b, m, t, ctx)
  const merged = first.merged as unknown as Workbook
  if (mineIsOwner) return { ctx, workbook: ownerProtection(theirs, merged, ctx) }
  if (!theirs.tabs.some((tab) => tab.protected?.length)) return { ctx, workbook: merged }
  const result = withTheirProtection(base, mine, theirs, merged)
  const ownerChanged = theirs.tabs.some((tab) => protectionKey(tab) !== protectionKey(base.tabs.find((other) => other.id === tab.id)))
  // The plain merge already respects theirs' protections: nothing of mine is overwritten.
  if (!ownerChanged || protectionRefusal(theirs, merged, { owner: false }) === null) return { ctx, workbook: result }
  // These edits reach into (or shift) a range the owner protected meanwhile: never settled
  // silently. Theirs: their body. Mine: the merge with the protected cells as the owner left them.
  const side = ctx.conflict(PROTECTION)
  if (side !== 'mine') return { ctx, workbook: side === 'theirs' ? theirs : result }
  // Mine's rows or columns moved on a tab the owner protects: theirs' protected cells would land
  // on shifted lines (a row lost, another doubled). A non-owner cannot move a protection, so the
  // shift goes there (mine's other edits stay) and the merge runs again with it undone.
  // Only where the merge moved or resized one of theirs' protections: a line edit clear of them stands.
  const undo = new Set(
    [...first.mineShifted].filter((id) => {
      const held = theirs.tabs.find((tab) => tab.id === id)
      return Boolean(held?.protected?.length) && protectionKey(held) !== protectionKey(merged.tabs.find((tab) => tab.id === id))
    }),
  )
  if (!undo.size) return { ctx, workbook: result }
  const again = new MergeContext(resolution)
  const second = mergeSheet(b, m, t, again, undo).merged as unknown as Workbook
  again.conflict(PROTECTION)
  return { ctx: again, workbook: withTheirProtection(base, mine, theirs, second) }
}

const protectionKey = (tab: SheetTab | undefined) => JSON.stringify(tab?.protected ?? [])

/** The filled addresses of `rect` in any of `maps` (a whole-tab protection is millions of addresses; the maps are sparse). */
function filledIn(rect: CellRect, ...maps: Array<Record<string, unknown>>): string[] {
  const keys = new Set<string>()
  for (const cells of maps)
    for (const key of Object.keys(cells)) {
      const pos = parseAddress(key)
      if (pos && pos.row >= rect.top && pos.row <= rect.bottom && pos.col >= rect.left && pos.col <= rect.right) keys.add(key)
    }
  return [...keys]
}

/** `tab`'s cells with those under `rects` as `held` has them. */
function heldCells(tab: SheetTab, held: SheetTab, rects: CellRect[]): SheetTab['cells'] {
  const cells = { ...tab.cells }
  for (const rect of rects)
    for (const address of filledIn(rect, tab.cells, held.cells)) {
      const cell = held.cells[address]
      if (cell === undefined) delete cells[address]
      else cells[address] = cell
    }
  return cells
}

/**
 * The owner's save: they may add, remove, resize and move protections, so the protections are
 * the merge's (theirs' changes and mine's both apply), never theirs' list over mine. The store
 * still refuses a protected cell changed while its protection stands (one the owner's other
 * session protected meanwhile): that is a conflict, settled toward theirs as their body, toward
 * mine with the cells under every protection standing on both sides as theirs has them.
 */
function ownerProtection(theirs: Workbook, merged: Workbook, ctx: MergeContext): Workbook {
  if (protectionRefusal(theirs, merged, { owner: true }) === null) return merged
  const side = ctx.conflict(OWNER_PROTECTION)
  if (side !== 'mine') return side === 'theirs' ? theirs : merged
  return {
    ...merged,
    tabs: merged.tabs.map((tab) => {
      const held = theirs.tabs.find((other) => other.id === tab.id)
      const standing = (held?.protected ?? []).filter((p) => tab.protected?.some((q) => q.id === p.id && q.range === p.range))
      const rects = standing.flatMap((p) => {
        const rect = parseRange(p.range)
        return rect ? [rect] : []
      })
      return held && rects.length ? { ...tab, cells: heldCells(tab, held, rects) } : tab
    }),
  }
}

/**
 * A non-owner's merge must never produce a body the protection check (sheet-guard.ts) would
 * refuse when the store holds `theirs`. Protected cells cannot change while a protection stands,
 * so on every protection that both sides still have (same id and range), or that the owner added
 * meanwhile, the cells are theirs', and so are the rules, tables and validations over it (its
 * cells' format, sheet-guard.ts `overlayRefusal`); the protections are theirs' list.
 */
function withTheirProtection(base: Workbook, mine: Workbook, theirs: Workbook, merged: Workbook): Workbook {
  return {
    ...merged,
    tabs: merged.tabs.map((tab) => {
      const held = theirs.tabs.find((t) => t.id === tab.id)
      const kept = mine.tabs.find((t) => t.id === tab.id)
      if (!held?.protected?.length || !kept) return tab
      const was = base.tabs.find((t) => t.id === tab.id)
      const same = (list: SheetTab['protected'], p: { id: string; range: string }) => Boolean(list?.some((q) => q.id === p.id && q.range === p.range))
      // Still in mine, or new in theirs (the owner protected it meanwhile); not one mine removed.
      const shared = held.protected.filter((p) => same(kept.protected, p) || !same(was?.protected, p))
      if (!shared.length) return tab
      const rects = shared.flatMap((item) => {
        const rect = parseRange(item.range)
        return rect ? [rect] : []
      })
      const cells = heldCells(tab, held, rects)
      const touches = (entry: { range: string }) => {
        const r = parseRange(entry.range)
        return !r || rects.some((p) => r.left <= p.right && r.right >= p.left && r.top <= p.bottom && r.bottom >= p.top)
      }
      // Validations carry no id: matched by content.
      const keyOf = (entry: { id?: string; range: string }) => (typeof entry.id === 'string' ? `id:${entry.id}` : JSON.stringify(entry))
      const overlay = <K extends 'rules' | 'tables' | 'validations'>(key: K): Pick<SheetTab, K> => {
        const theirsOver = ((held[key] ?? []) as Array<{ id?: string; range: string }>).filter(touches)
        const ids = new Set(theirsOver.map(keyOf))
        const mineClear = ((tab[key] ?? []) as Array<{ id?: string; range: string }>).filter((entry) => !touches(entry) && !ids.has(keyOf(entry)))
        const list = [...mineClear, ...theirsOver]
        return (list.length ? { [key]: list } : {}) as Pick<SheetTab, K>
      }
      const { rules: _rules, tables: _tables, validations: _validations, ...rest } = tab
      return { ...rest, cells, protected: held.protected, ...overlay('rules'), ...overlay('tables'), ...overlay('validations') }
    }),
  }
}
