/**
 * Seeded generators for the artifact-merge property tests (artifact-merge.property.test.ts):
 * a random valid base per kind, two random edit scripts (ours and theirs), the bodies they make,
 * and what a correct three-way merge of them must hold. Test-only; no dependencies.
 *
 * Every value a script writes is unique, so a unit's survival (and where a shifted sheet cell
 * landed) can be told apart from any other unit. Expectations come from the scripts, never from
 * diffing merge outputs.
 */

import { deleteLines, insertLines, type Axis } from '../artifact-kinds/sheet-structure'
import { deleteTab, renameTab } from '../artifact-kinds/sheet-ops'
import { toAddress } from '../artifact-kinds/sheet-address'
import type { Workbook } from '../artifact-kinds/sheet'
import type { ArtifactKind } from '../artifacts'

// ---------------------------------------------------------------------------------------------
// PRNG

export type Rng = {
  next(): number
  int(n: number): number
  pick<T>(list: readonly T[]): T
  chance(p: number): boolean
  /** A fresh token, unique across the whole run of this generator. */
  token(prefix: string): string
}

/** mulberry32: deterministic, seedable, good enough for test case generation. */
export function rng(seed: number): Rng {
  let state = seed >>> 0
  let counter = 0
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    next,
    int: (n) => Math.floor(next() * n),
    pick: (list) => list[Math.floor(next() * list.length)]!,
    chance: (p) => next() < p,
    token: (prefix) => `${prefix}${(counter += 1)}`,
  }
}

export type Side = 'mine' | 'theirs'

// ---------------------------------------------------------------------------------------------
// Keyed kinds (slides, whiteboard, data, design): entities by id, each a record of fields.

export type Ent = Record<string, string | number | boolean>
export type KeyedModel = { order: string[]; ents: Record<string, Ent> }

export type KeyedSpec = {
  kind: Exclude<ArtifactKind, 'doc'>
  /** The test's name when one kind has several specs (a list per round-5 field). */
  name?: string
  /** Fields an edit may change (a design leaf's `parent` is a move). */
  fields: readonly string[]
  base(r: Rng): KeyedModel
  newEnt(r: Rng, model: KeyedModel): Ent
  value(r: Rng, field: string, model: KeyedModel): string | number | boolean
  render(model: KeyedModel): unknown
  extract(body: unknown): KeyedModel
  /** Ids no script deletes (a dashboard needs one block). */
  keep?: readonly string[]
  /** Whether a side may reorder (z-order, slide order); one side per case at most. */
  reorder: boolean
  /**
   * The kind's cap on the list. A case where a side, or the merge, would hold more is skipped:
   * the session refuses a merged body over the cap as a conflict (`acceptsBody`).
   */
  max?: number
}

export type KeyedScript = Array<
  | { op: 'edit'; id: string; field: string; value: string | number | boolean }
  | { op: 'delete'; id: string }
  | { op: 'add'; id: string; ent: Ent; at: number }
  | { op: 'move'; id: string; to: number }
>

const cloneModel = (m: KeyedModel): KeyedModel => ({ order: [...m.order], ents: Object.fromEntries(Object.entries(m.ents).map(([k, v]) => [k, { ...v }])) })

export function keyedScript(r: Rng, spec: KeyedSpec, base: KeyedModel, mayReorder: boolean): KeyedScript {
  const script: KeyedScript = []
  const model = cloneModel(base)
  const touched = new Set<string>()
  const steps = 1 + r.int(4)
  for (let i = 0; i < steps; i += 1) {
    const live = model.order.filter((id) => !touched.has(id) || r.chance(0.3))
    const roll = r.next()
    if (roll < 0.5 && live.length > 0) {
      const id = r.pick(live)
      const field = r.pick(spec.fields)
      const value = spec.value(r, field, model)
      script.push({ op: 'edit', id, field, value })
      model.ents[id]![field] = value
      touched.add(id)
    } else if (roll < 0.7 && live.length > 0) {
      const candidates = live.filter((id) => !spec.keep?.includes(id))
      if (candidates.length === 0) continue
      const id = r.pick(candidates)
      script.push({ op: 'delete', id })
      model.order = model.order.filter((x) => x !== id)
      delete model.ents[id]
      touched.add(id)
    } else if (roll < 0.9 || !mayReorder || !spec.reorder) {
      const id = r.token('n')
      const ent = spec.newEnt(r, model)
      const at = r.int(model.order.length + 1)
      script.push({ op: 'add', id, ent, at })
      model.order.splice(at, 0, id)
      model.ents[id] = ent
      touched.add(id)
    } else if (model.order.length > 1) {
      const id = r.pick(model.order)
      const rest = model.order.filter((x) => x !== id)
      const to = r.int(rest.length + 1)
      script.push({ op: 'move', id, to })
      rest.splice(to, 0, id)
      model.order = rest
    }
  }
  return script
}

export function applyKeyed(base: KeyedModel, script: KeyedScript): KeyedModel {
  const model = cloneModel(base)
  for (const step of script) {
    if (step.op === 'edit') {
      if (model.ents[step.id]) model.ents[step.id]![step.field] = step.value
    } else if (step.op === 'delete') {
      model.order = model.order.filter((x) => x !== step.id)
      delete model.ents[step.id]
    } else if (step.op === 'add') {
      model.order.splice(Math.min(step.at, model.order.length), 0, step.id)
      model.ents[step.id] = { ...step.ent }
    } else {
      const rest = model.order.filter((x) => x !== step.id)
      rest.splice(Math.min(step.to, rest.length), 0, step.id)
      model.order = rest
    }
  }
  return model
}

const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const sameEnt = (a: Ent | undefined, b: Ent | undefined) => {
  if (!a || !b) return a === b
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  return [...keys].every((k) => a[k] === b[k])
}

/**
 * What the merge of three keyed models must give: each entity three-way (presence, then field by
 * field); `conflicts` are the ids both sides changed differently (or deleted against an edit),
 * settled by `resolve` when given (mine stands in otherwise).
 */
export function expectKeyed(b: KeyedModel, m: KeyedModel, t: KeyedModel, resolve?: Side): { ents: Record<string, Ent>; conflicts: string[] } {
  const ents: Record<string, Ent> = {}
  const conflicts: string[] = []
  const ids = new Set([...Object.keys(b.ents), ...Object.keys(m.ents), ...Object.keys(t.ents)])
  for (const id of ids) {
    const [be, me, te] = [b.ents[id], m.ents[id], t.ents[id]]
    const chosen = (mine: Ent | undefined, theirs: Ent | undefined) => (resolve === 'theirs' ? theirs : mine)
    let out: Ent | undefined
    if (!be) {
      if (me && te && !sameEnt(me, te)) {
        conflicts.push(id)
        out = chosen(me, te)
      } else out = me ?? te
    } else if (!me || !te) {
      const kept = me ?? te
      if (!kept || sameEnt(kept, be)) out = undefined
      else {
        conflicts.push(id)
        out = chosen(me, te)
      }
    } else {
      out = {}
      let clash = false
      for (const field of new Set([...Object.keys(be), ...Object.keys(me), ...Object.keys(te)])) {
        const [bv, mv, tv] = [be[field], me[field], te[field]]
        const v = mv === tv ? mv : bv === mv ? tv : bv === tv ? mv : ((clash = true), resolve === 'theirs' ? tv : mv)
        if (v !== undefined) out[field] = v
      }
      if (clash) conflicts.push(id)
    }
    if (out) ents[id] = out
  }
  return { ents, conflicts }
}

/** The ids of `side`'s order that `base` held, in `side`'s order. */
export const relativeOrder = (side: string[], keep: Set<string>) => side.filter((id) => keep.has(id))

const word = (r: Rng, prefix: string) => `${prefix} ${r.token('')}`

export const SLIDES: KeyedSpec = {
  kind: 'slides',
  fields: ['title', 'subtitle'],
  reorder: true,
  base(r) {
    const order = Array.from({ length: 2 + r.int(5) }, () => r.token('s'))
    return { order, ents: Object.fromEntries(order.map((id) => [id, { title: word(r, 'Title'), subtitle: word(r, 'Sub') }])) }
  },
  newEnt: (r) => ({ title: word(r, 'New'), subtitle: word(r, 'Sub') }),
  value: (r, field) => word(r, field),
  render: (model) => ({ version: 1, title: 'Deck', aspect: '16:9', slides: model.order.map((id) => ({ id, layout: 'title', ...model.ents[id] })) }),
  extract: (body: any) => ({
    order: body.slides.map((s: any) => s.id),
    ents: Object.fromEntries(body.slides.map(({ id, layout: _l, ...rest }: any) => [id, rest])),
  }),
}

export const WHITEBOARD: KeyedSpec = {
  kind: 'whiteboard',
  fields: ['x', 'y', 'text'],
  reorder: true,
  base(r) {
    const order = Array.from({ length: 1 + r.int(6) }, () => r.token('e'))
    return { order, ents: Object.fromEntries(order.map((id) => [id, { x: r.int(1000), y: r.int(1000), text: word(r, 'Note') }])) }
  },
  newEnt: (r) => ({ x: r.int(1000), y: r.int(1000), text: word(r, 'New') }),
  // Positions are unique too, so a lost move is never hidden by a coincidence.
  value: (r, field) => (field === 'text' ? word(r, 'Text') : 1000 + Number(r.token(''))),
  render: (model) => ({
    version: 1,
    title: 'Board',
    elements: model.order.map((id) => ({ id, type: 'note', w: 160, h: 120, color: 'yellow', ...model.ents[id] })),
  }),
  extract: (body: any) => ({
    order: body.elements.map((e: any) => e.id),
    ents: Object.fromEntries(body.elements.map(({ id, type: _t, w: _w, h: _h, color: _c, ...rest }: any) => [id, rest])),
  }),
}

export const DATA: KeyedSpec = {
  kind: 'data',
  fields: ['markdown'],
  reorder: true,
  keep: ['anchor'],
  base(r) {
    const order = ['anchor', ...Array.from({ length: r.int(5) }, () => r.token('b'))]
    return { order, ents: Object.fromEntries(order.map((id) => [id, { markdown: word(r, 'Text') }])) }
  },
  newEnt: (r) => ({ markdown: word(r, 'New') }),
  value: (r) => word(r, 'Edit'),
  render: (model) => ({
    version: 1,
    title: 'Dash',
    layout: 'grid',
    sources: [{ id: 'none', label: 'No data yet' }],
    datasets: [],
    blocks: model.order.map((id) => ({ kind: 'text', id, ...model.ents[id] })),
  }),
  extract: (body: any) => ({
    order: body.blocks.map((b: any) => b.id),
    ents: Object.fromEntries(body.blocks.map(({ id, kind: _k, ...rest }: any) => [id, rest])),
  }),
}

/** Design: text leaves (`text`, and `parent`: which of the fixed frames holds them). */
const FRAMES = ['f0', 'f1', 'f2'] as const
export const DESIGN: KeyedSpec = {
  kind: 'design',
  fields: ['text', 'parent'],
  reorder: true,
  base(r) {
    const order = Array.from({ length: 1 + r.int(7) }, () => r.token('l'))
    return { order, ents: Object.fromEntries(order.map((id) => [id, { text: word(r, 'Text'), parent: r.pick(FRAMES) }])) }
  },
  newEnt: (r) => ({ text: word(r, 'New'), parent: r.pick(FRAMES) }),
  value: (r, field, _model) => (field === 'parent' ? r.pick(FRAMES) : word(r, 'Edit')),
  render: (model) => ({
    version: 1,
    title: 'Site',
    boards: [
      {
        id: 'home',
        title: 'Home',
        x: 0,
        y: 0,
        w: 1440,
        h: 900,
        root: {
          id: 'root',
          type: 'frame',
          layout: 'stack-v',
          children: FRAMES.map((frame) => ({
            id: frame,
            type: 'frame',
            layout: 'stack-v',
            children: model.order
              .filter((id) => model.ents[id]!.parent === frame)
              .map((id) => ({ id, type: 'text', style: 'body', text: model.ents[id]!.text })),
          })),
        },
      },
    ],
  }),
  extract: (body: any) => {
    const order: string[] = []
    const ents: Record<string, Ent> = {}
    for (const frame of body.boards[0].root.children) {
      for (const leaf of frame.children) {
        order.push(leaf.id)
        ents[leaf.id] = { text: leaf.text, parent: frame.id }
      }
    }
    return { order, ents }
  },
}

/** A design frame's child list on one side, for the "children of" order conflict. */
export const frameKids = (model: KeyedModel, frame: string) => model.order.filter((id) => model.ents[id]!.parent === frame)
export const DESIGN_FRAMES = FRAMES

// ---- Round 5 fields: each new keyed list (or new entity fields) as its own spec.

const ANIMATIONS = ['fade', 'rise', 'zoom'] as const
/** Slides: free elements on one slide with their build step, animation and reading order. */
export const SLIDE_ELEMENTS: KeyedSpec = {
  kind: 'slides',
  name: 'slides elements (build, animate, readOrder)',
  fields: ['x', 'build', 'animate', 'readOrder'],
  reorder: true,
  base(r) {
    const order = Array.from({ length: 1 + r.int(5) }, () => r.token('el'))
    return { order, ents: Object.fromEntries(order.map((id) => [id, { x: r.int(800), build: 1 + r.int(5) }])) }
  },
  newEnt: (r) => ({ x: r.int(800), animate: r.pick(ANIMATIONS) }),
  value: (r, field) => (field === 'x' ? 1 + Number(r.token('')) % 900 : field === 'animate' ? r.pick(ANIMATIONS) : 1 + r.int(20)),
  render: (model) => ({
    version: 1,
    title: 'Deck',
    aspect: '16:9',
    slides: [{ id: 's1', layout: 'title', title: 'One', elements: model.order.map((id) => ({ id, type: 'rect', y: 10, w: 40, h: 40, ...model.ents[id] })) }],
  }),
  extract: (body: any) => {
    const elements = body.slides[0].elements ?? []
    return { order: elements.map((e: any) => e.id), ents: Object.fromEntries(elements.map(({ id, type: _t, y: _y, w: _w, h: _h, ...rest }: any) => [id, rest])) }
  },
}

/** Whiteboard: round 5's `hidden` on every element and a note's `autoSize`. */
export const WHITEBOARD_R5: KeyedSpec = {
  kind: 'whiteboard',
  name: 'whiteboard hidden and autoSize',
  fields: ['text', 'hidden', 'autoSize'],
  reorder: true,
  base(r) {
    const order = Array.from({ length: 1 + r.int(6) }, () => r.token('e'))
    return { order, ents: Object.fromEntries(order.map((id) => [id, { text: word(r, 'Note'), hidden: r.chance(0.5) }])) }
  },
  newEnt: (r) => ({ text: word(r, 'New'), autoSize: true }),
  // Text is unique, so a lost edit is never hidden; booleans flip.
  value: (r, field, model) => (field === 'text' ? word(r, 'Text') : !Object.values(model.ents).some((ent) => ent[field] === true) || r.chance(0.5)),
  render: (model) => ({
    version: 1,
    title: 'Board',
    elements: model.order.map((id) => ({ id, type: 'note', x: 0, y: 0, w: 160, h: 120, color: 'yellow', ...model.ents[id] })),
  }),
  extract: (body: any) => ({
    order: body.elements.map((e: any) => e.id),
    ents: Object.fromEntries(body.elements.map(({ id, type: _t, x: _x, y: _y, w: _w, h: _h, color: _c, ...rest }: any) => [id, rest])),
  }),
}

const FILLS = ['blue', 'green', 'yellow', 'red'] as const
/** A sheet tab's tables (round 5) and conditional-format rules, keyed by id. */
const sheetList = (field: 'tables' | 'rules', name: string, fields: readonly string[], seed: (r: Rng) => Ent, value: KeyedSpec['value']): KeyedSpec => ({
  kind: 'sheet',
  name,
  fields,
  reorder: true,
  base(r) {
    const order = Array.from({ length: 1 + r.int(5) }, () => r.token('x'))
    return { order, ents: Object.fromEntries(order.map((id) => [id, seed(r)])) }
  },
  newEnt: (r) => seed(r),
  value,
  // Each table sits on its own rows (from its id's number), so no two overlap.
  render: (model) => ({
    version: 1,
    title: 'Sheet',
    tabs: [
      {
        id: 't',
        name: 'T',
        rows: SHEET_ROWS,
        cols: 4,
        cells: {},
        [field]: model.order.map((id) => {
          const n = Number(id.replace(/\D/g, ''))
          return { id, range: `A${3 * n + 1}:B${3 * n + 2}`, ...(field === 'rules' ? { type: 'gt' } : {}), ...model.ents[id] }
        }),
      },
    ],
  }),
  extract: (body: any) => {
    const list = body.tabs[0][field] ?? []
    return { order: list.map((e: any) => e.id), ents: Object.fromEntries(list.map(({ id, range: _r, type: _t, ...rest }: any) => [id, field === 'rules' ? { ...rest, type: _t } : rest])) }
  },
})
const SHEET_ROWS = 50_000
export const SHEET_TABLES = sheetList(
  'tables',
  'sheet tables',
  ['banded', 'header', 'color'],
  (r) => ({ header: true, color: r.pick(FILLS) }),
  (r, field) => (field === 'color' ? r.pick(FILLS) : r.chance(0.5)),
)
export const SHEET_RULES = sheetList(
  'rules',
  'sheet rules',
  ['value', 'type'],
  (r) => ({ value: r.int(100), type: 'gt' }),
  (r, field) => (field === 'type' ? r.pick(['gt', 'lt'] as const) : 1000 + Number(r.token(''))),
)

/** A design's round-5 top-level lists, keyed by id, on a one-board design. */
const designList = (field: string, name: string, fields: readonly string[], seed: (r: Rng) => Ent, fixed: Ent, max?: number): KeyedSpec => ({
  kind: 'design',
  name,
  ...(max ? { max } : {}),
  fields,
  reorder: true,
  base(r) {
    const order = Array.from({ length: 1 + r.int(max ? Math.min(5, max - 1) : 5) }, () => r.token('d'))
    return { order, ents: Object.fromEntries(order.map((id) => [id, seed(r)])) }
  },
  newEnt: (r) => seed(r),
  value: (r, f) => (typeof fixed[f] === 'number' || f === 'x' || f === 'revision' ? Number(r.token('')) : word(r, f)),
  render: (model) => ({
    version: 1,
    title: 'Site',
    boards: [{ id: 'home', title: 'Home', x: 0, y: 0, w: 400, h: 300, root: { id: 'root', type: 'frame', layout: 'stack-v', children: [] } }],
    [field]: model.order.map((id) => ({ id, ...fixed, ...(field === 'installedSystems' ? { artifactId: `sys-${id}` } : {}), ...model.ents[id] })),
  }),
  extract: (body: any) => ({
    order: (body[field] ?? []).map((e: any) => e.id),
    ents: Object.fromEntries((body[field] ?? []).map((e: any) => [e.id, Object.fromEntries(fields.filter((k) => k in e).map((k) => [k, e[k]]))])),
  }),
})
export const DESIGN_VARIABLES = designList('variables', 'design variables', ['name', 'value'], (r) => ({ name: word(r, 'Var'), value: word(r, 'v') }), { type: 'text' })
export const DESIGN_DATA = designList('data', 'design data lists', ['name'], (r) => ({ name: word(r, 'List') }), { fields: ['title'], rows: [] } as unknown as Ent, 8)
export const DESIGN_INSTALLED = designList(
  'installedSystems',
  'design installed systems',
  ['name', 'revision'],
  (r) => ({ name: word(r, 'System'), revision: r.int(50) }),
  { artifactId: 'sys-1', installedAt: '2026-11-16T00:00:00.000Z' },
  4,
)
export const DESIGN_LINKS = designList('links', 'design link cards', ['title', 'x'], (r) => ({ title: word(r, 'Link'), x: r.int(900) }), {
  artifactId: 'doc-1',
  kind: 'doc',
  y: 0,
})

export const KEYED_SPECS: readonly KeyedSpec[] = [
  SLIDES,
  WHITEBOARD,
  DATA,
  DESIGN,
  SLIDE_ELEMENTS,
  WHITEBOARD_R5,
  SHEET_TABLES,
  SHEET_RULES,
  DESIGN_VARIABLES,
  DESIGN_DATA,
  DESIGN_INSTALLED,
  DESIGN_LINKS,
]

// ---------------------------------------------------------------------------------------------
// Doc: blocks of unique text; edits, deletes and insertions at gaps.

export type DocScript = { edits: Map<number, string>; deletes: Set<number>; inserts: Map<number, string[]> }

export function docBase(r: Rng): string[] {
  return Array.from({ length: 2 + r.int(8) }, () => `Block ${r.token('')}.`)
}

export function docScript(r: Rng, base: string[]): DocScript {
  const script: DocScript = { edits: new Map(), deletes: new Set(), inserts: new Map() }
  const steps = 1 + r.int(3)
  for (let i = 0; i < steps; i += 1) {
    const roll = r.next()
    const at = r.int(base.length)
    if (script.edits.has(at) || script.deletes.has(at)) continue
    if (roll < 0.5) script.edits.set(at, `Edited ${r.token('')}.`)
    else if (roll < 0.7) script.deletes.add(at)
    else {
      const gap = r.int(base.length + 1)
      script.inserts.set(gap, [...(script.inserts.get(gap) ?? []), `Inserted ${r.token('')}.`])
    }
  }
  return script
}

export function applyDoc(base: string[], script: DocScript): string[] {
  const out: string[] = []
  for (let p = 0; p <= base.length; p += 1) {
    out.push(...(script.inserts.get(p) ?? []))
    if (p === base.length) break
    if (script.deletes.has(p)) continue
    out.push(script.edits.get(p) ?? base[p]!)
  }
  return out
}

/** Positions a script touches on one line: block i at 2i+1, the gap before block p at 2p. */
export function docTouches(script: DocScript): number[] {
  return [...script.edits.keys(), ...script.deletes].map((i) => 2 * i + 1).concat([...script.inserts.keys()].map((p) => 2 * p))
}

/** The merged blocks when the two scripts do not clash (both scripts applied at once). */
export function expectDoc(base: string[], mine: DocScript, theirs: DocScript): string[] {
  const merged: DocScript = {
    edits: new Map([...mine.edits, ...theirs.edits]),
    deletes: new Set([...mine.deletes, ...theirs.deletes]),
    inserts: new Map(),
  }
  for (let p = 0; p <= base.length; p += 1) {
    const list = [...(mine.inserts.get(p) ?? []), ...(theirs.inserts.get(p) ?? [])]
    if (list.length) merged.inserts.set(p, list)
  }
  return applyDoc(base, merged)
}

// ---------------------------------------------------------------------------------------------
// Sheet: a dense grid of unique values on `Data`, formulas on `Sum` pointing at it, and a plain
// `Extra` tab. A script is cell edits in BASE coordinates plus at most one line edit (applied
// first; the edits then land through its remap), and tab ops on `Extra`.

export const SHEET_TABS = { data: 'data', sum: 'sum', extra: 'extra' } as const

export type LineOp = { tab: string; axis: Axis; kind: 'insert' | 'delete'; at: number; count: number }

export type SheetScript = {
  /** Base address on a tab → the new value ({ v } or { f }). */
  edits: Array<{ tab: string; address: string; cell: { v: string } | { f: string } }>
  line?: LineOp
  renameExtra?: string
  deleteExtra?: boolean
  /** A new tab, appended. */
  addTab?: { id: string; name: string; cells: Record<string, { v: string }> }
}

export type SheetBase = { workbook: Workbook; rows: number; cols: number }

export function sheetBase(r: Rng): SheetBase {
  const rows = 3 + r.int(5)
  const cols = 3 + r.int(3)
  const data: Record<string, { v: string }> = {}
  for (let row = 0; row < rows; row += 1) for (let col = 0; col < cols; col += 1) data[toAddress({ row, col })] = { v: `d${r.token('')}` }
  const sum: Record<string, { f: string }> = {}
  for (let i = 0; i < 3; i += 1) sum[toAddress({ row: i, col: 0 })] = { f: `=Data!${toAddress({ row: r.int(rows), col: r.int(cols) })}` }
  const extra = { A1: { v: `x${r.token('')}` }, B2: { v: `x${r.token('')}` } }
  return {
    rows,
    cols,
    workbook: {
      version: 1,
      title: 'Book',
      tabs: [
        { id: SHEET_TABS.data, name: 'Data', cells: data },
        { id: SHEET_TABS.sum, name: 'Sum', cells: sum },
        { id: SHEET_TABS.extra, name: 'Extra', cells: extra },
      ],
    } as Workbook,
  }
}

export function sheetScript(r: Rng, base: SheetBase): SheetScript {
  const script: SheetScript = { edits: [] }
  if (r.chance(0.6)) {
    const axis: Axis = r.chance(0.6) ? 'row' : 'col'
    const length = axis === 'row' ? base.rows : base.cols
    const kind = r.chance(0.55) ? 'insert' : 'delete'
    // Inside the grid (an insert may go right after it); a delete leaves at least one line.
    const count = kind === 'insert' ? 1 + r.int(2) : 1 + r.int(Math.min(2, length - 1))
    const at = kind === 'insert' ? r.int(length + 1) : r.int(length - count + 1)
    script.line = { tab: SHEET_TABS.data, axis, kind, at, count }
  }
  const used = new Set<string>()
  const edits = r.int(3)
  for (let i = 0; i < edits; i += 1) {
    const roll = r.next()
    if (roll < 0.6) {
      const address = toAddress({ row: r.int(base.rows), col: r.int(base.cols) })
      if (used.has(`d${address}`) || deletedBy(script.line, address)) continue
      used.add(`d${address}`)
      script.edits.push({ tab: SHEET_TABS.data, address, cell: { v: `e${r.token('')}` } })
    } else if (roll < 0.85) {
      const address = toAddress({ row: 3 + r.int(3), col: r.int(2) })
      if (used.has(`s${address}`)) continue
      used.add(`s${address}`)
      script.edits.push({ tab: SHEET_TABS.sum, address, cell: { f: `=Data!${toAddress({ row: r.int(base.rows), col: r.int(base.cols) })}*2` } })
    } else {
      const address = toAddress({ row: r.int(3), col: r.int(3) })
      if (used.has(`x${address}`)) continue
      used.add(`x${address}`)
      script.edits.push({ tab: SHEET_TABS.extra, address, cell: { v: `e${r.token('')}` } })
    }
  }
  if (r.chance(0.2)) {
    const id = r.token('tab')
    script.addTab = { id, name: `New ${id}`, cells: { A1: { v: `a${r.token('')}` } } }
  }
  if (r.chance(0.15)) script.renameExtra = `Extra${r.token('')}`
  else if (r.chance(0.1) && !script.edits.some((e) => e.tab === SHEET_TABS.extra)) script.deleteExtra = true
  return script
}

/** Whether a line op deletes the line holding `address` on its tab. */
function deletedBy(line: LineOp | undefined, address: string): boolean {
  if (!line || line.kind !== 'delete') return false
  const match = /^([A-Z]+)(\d+)$/.exec(address)!
  const col = [...match[1]!].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1
  const index = line.axis === 'row' ? Number(match[2]) - 1 : col
  return index >= line.at && index < line.at + line.count
}

export const lineDeletes = (line: LineOp | undefined, tab: string, address: string) => line?.tab === tab && deletedBy(line, address)

function setCells(workbook: Workbook, edits: SheetScript['edits']): Workbook {
  return {
    ...workbook,
    tabs: workbook.tabs.map((tab) => {
      const mine = edits.filter((e) => e.tab === tab.id)
      if (mine.length === 0) return tab
      const cells = { ...tab.cells }
      for (const e of mine) cells[e.address] = e.cell as never
      return { ...tab, cells }
    }),
  }
}

const applyLine = (workbook: Workbook, line: LineOp) =>
  line.kind === 'insert' ? insertLines(workbook, line.tab, line.axis, line.at, line.count) : deleteLines(workbook, line.tab, line.axis, line.at, line.count)

/** One side's workbook: its cell edits in base coordinates, then its line edit and tab ops. */
export function applySheet(base: Workbook, script: SheetScript): Workbook {
  let book = setCells(base, script.edits)
  if (script.line) book = applyLine(book, script.line)
  if (script.renameExtra) book = renameTab(book, SHEET_TABS.extra, script.renameExtra)
  if (script.deleteExtra) book = deleteTab(book, SHEET_TABS.extra)
  if (script.addTab) book = { ...book, tabs: [...book.tabs, { ...script.addTab }] }
  return book
}

/**
 * The plain values (`v`) one side wrote that must survive a merge settled toward `winner`: all of
 * them, except where the other side's change clashed with it and won (the same cell, a line it
 * deleted, or deleting `Extra` under an edit).
 */
export function survivingValues(side: SheetScript, other: SheetScript, sideIs: Side, winner: Side): string[] {
  const out: string[] = []
  const lost = sideIs !== winner
  for (const e of side.edits) {
    if (!('v' in e.cell)) continue
    const clash = other.edits.find((o) => o.tab === e.tab && o.address === e.address && !eq(o.cell, e.cell))
    if (lost && (clash || lineDeletes(other.line, e.tab, e.address) || (e.tab === SHEET_TABS.extra && other.deleteExtra))) continue
    if (e.tab === SHEET_TABS.extra && side.deleteExtra) continue
    out.push(e.cell.v)
  }
  if (side.addTab) out.push(...Object.values(side.addTab.cells).map((c) => c.v))
  return out
}

/** Whether two line ops clash (both on the same tab and not the very same op). */
export const linesClash = (a?: LineOp, b?: LineOp) => Boolean(a && b && a.tab === b.tab && !eq(a, b))

/**
 * The expected sheet merge: `conflicts` (a cell both sides set differently, a cell set on a line
 * the other side deleted, two different line edits of one tab, an edit to `Extra` against its
 * deletion, two different renames) and, when there are none, the workbook: both sides' cell edits
 * in base coordinates, then the line edits (at most one distinct per tab), then the tab ops.
 */
export function expectSheet(base: Workbook, mine: SheetScript, theirs: SheetScript): { conflicts: string[]; workbook: Workbook | null } {
  const conflicts: string[] = []
  const key = (e: { tab: string; address: string }) => `${e.tab}!${e.address}`
  const theirEdits = new Map(theirs.edits.map((e) => [key(e), e]))
  for (const e of mine.edits) {
    const other = theirEdits.get(key(e))
    if (other && !eq(other.cell, e.cell)) conflicts.push(`cell ${key(e)}`)
  }
  for (const [side, other] of [[mine, theirs], [theirs, mine]] as const) {
    for (const e of side.edits) if (lineDeletes(other.line, e.tab, e.address)) conflicts.push(`deleted line ${key(e)}`)
    if (other.deleteExtra && (side.edits.some((e) => e.tab === SHEET_TABS.extra) || side.renameExtra)) conflicts.push('extra deleted vs edited')
  }
  if (linesClash(mine.line, theirs.line)) conflicts.push('line edits')
  if (mine.renameExtra && theirs.renameExtra && mine.renameExtra !== theirs.renameExtra) conflicts.push('rename')
  if (conflicts.length) return { conflicts, workbook: null }
  let book = setCells(base, [...mine.edits, ...theirs.edits])
  if (mine.line) book = applyLine(book, mine.line)
  if (theirs.line && !eq(theirs.line, mine.line)) book = applyLine(book, theirs.line)
  const rename = mine.renameExtra ?? theirs.renameExtra
  if (rename) book = renameTab(book, SHEET_TABS.extra, rename)
  if (mine.deleteExtra || theirs.deleteExtra) book = deleteTab(book, SHEET_TABS.extra)
  for (const added of [mine.addTab, theirs.addTab]) if (added) book = { ...book, tabs: [...book.tabs, { ...added }] }
  return { conflicts, workbook: book }
}
