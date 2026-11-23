/**
 * Tabs in a doc. A doc stays one Markdown body; a tab starts at a marker block of its own:
 *
 *   [//]: # "tab: Launch notes"
 *
 * That is a link reference definition (label `//`, title `tab: …`), the standard invisible
 * Markdown comment: GitHub, CommonMark renderers and our own drop it, so a plain reader sees
 * nothing odd. (An HTML comment is not used: react-markdown draws one as literal text.)
 *
 * The blocks before the first marker are an unnamed first tab, so a body with no marker is
 * exactly one tab holding everything. Every function here works on the body's top-level blocks
 * (split on blank lines, fences kept whole, as the doc view splits them), and the edits it
 * returns address those blocks by index and exact source, the shape of the doc view's
 * `DocEdit` `kind: 'block'`: applied one at a time, each to the body the previous one left.
 */

/** One edit of the body's top-level blocks (see `DocEdit` in the doc view's doc-edit.ts). */
export type DocBlockEdit = {
  index: number
  before: string
  after: string
  /** Blocks the edit covers from `index` (default 1); 0 inserts `after` before block `index`. */
  span?: number
  /** Moves the `span` blocks from `index` so the first lands at this index; `after === before`. */
  moveTo?: number
}

export type DocTab = {
  /** A slug of the name, unique in the doc: the tab's deep link is `#tab=<id>`. */
  id: string
  name: string
  /** The marker block's index; null for the unnamed first tab. */
  marker: number | null
  /** The tab's content blocks: `start` (inclusive) to `end` (exclusive). */
  start: number
  end: number
}

export const DOC_TAB_LIMITS = { name: 60, tabs: 50 } as const

/** What the unnamed first tab is called until it is renamed. */
export const FIRST_TAB_NAME = 'Tab 1'

const MARKER = /^ {0,3}\[\/\/\]:[ \t]*#[ \t]+(?:"tab:[ \t]*([^"\n]*?)[ \t]*"|\(tab:[ \t]*([^()\n]*?)[ \t]*\))[ \t]*$/

/** The tab name a block declares, or null when the block is not a tab marker. */
export function parseTabMarker(block: string): string | null {
  const match = MARKER.exec(block)
  if (!match) return null
  const name = cleanTabName(match[1] ?? match[2] ?? '')
  return name || null
}

export const isTabMarker = (block: string) => parseTabMarker(block) !== null

/** A name as a marker can hold it: one line, no quotes or backslashes, at most 60 characters. */
export function cleanTabName(input: string): string {
  return input
    .replace(/["\\()]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, DOC_TAB_LIMITS.name)
    .trim()
}

/** The marker block for a tab named `name` (already cleaned, non-empty). */
export const tabMarker = (name: string) => `[//]: # "tab: ${cleanTabName(name)}"`

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

/** The doc's tabs, in order. Always at least one. */
export function docTabs(blocks: readonly string[]): DocTab[] {
  const tabs: DocTab[] = []
  const used = new Set<string>()
  const id = (name: string) => {
    const base = slug(name) || 'tab'
    let next = base
    for (let n = 2; used.has(next); n++) next = `${base}-${n}`
    used.add(next)
    return next
  }
  const markers: Array<{ index: number; name: string }> = []
  blocks.forEach((block, index) => {
    const name = parseTabMarker(block)
    if (name !== null) markers.push({ index, name })
  })
  const first = markers[0]?.index ?? blocks.length
  if (first > 0 || markers.length === 0)
    tabs.push({ id: id(FIRST_TAB_NAME), name: FIRST_TAB_NAME, marker: null, start: 0, end: first })
  markers.forEach((marker, n) => {
    tabs.push({
      id: id(marker.name),
      name: marker.name,
      marker: marker.index,
      start: marker.index + 1,
      end: markers[n + 1]?.index ?? blocks.length,
    })
  })
  return tabs
}

/** The blocks a tab owns, marker included: what deleting or moving it takes. */
const ownBlocks = (tab: DocTab) => ({ from: tab.marker ?? tab.start, to: tab.end })

/** The blocks after one edit, for building the next edit of a sequence. Null when it does not apply. */
export function applyBlockEdit(blocks: readonly string[], edit: DocBlockEdit): string[] | null {
  const span = edit.span ?? 1
  const next = [...blocks]
  const split = (text: string) => (text.trim() ? splitBlocks(text) : [])
  if (span === 0) {
    if (edit.before !== '' || edit.index < 0 || edit.index > blocks.length) return null
    next.splice(edit.index, 0, ...split(edit.after))
    return next
  }
  const covered = blocks.slice(edit.index, edit.index + span)
  if (edit.index < 0 || covered.length !== span || covered.join('\n\n') !== edit.before) return null
  if (edit.moveTo !== undefined) {
    if (edit.after !== edit.before) return null
    next.splice(edit.index, span)
    const to = Math.max(0, Math.min(next.length, edit.moveTo))
    next.splice(to, 0, ...covered)
    return next
  }
  next.splice(edit.index, span, ...split(edit.after))
  return next
}

/** Text split into top-level blocks: on blank lines, fences kept whole. */
export function splitBlocks(markdown: string): string[] {
  const blocks: string[] = []
  let current: string[] = []
  let fenced = false
  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    if (line.trimStart().startsWith('```')) fenced = !fenced
    if (!fenced && line.trim() === '') {
      if (current.length) blocks.push(current.join('\n'))
      current = []
    } else current.push(line)
  }
  if (current.length) blocks.push(current.join('\n'))
  return blocks
}

export type TabChange = { edits: DocBlockEdit[]; /** The tab to show afterwards. */ select?: string } | { error: string }

/** The unnamed first tab, given a marker of its own (so it can move, and keeps its place). */
function nameFirst(tabs: DocTab[]): DocBlockEdit | null {
  if (tabs[0]?.marker !== null) return null
  return { index: 0, span: 0, before: '', after: tabMarker(tabs[0].name) }
}

/** The name `Tab N` for a new tab, unused in the doc. */
function freshName(tabs: DocTab[]) {
  const names = new Set(tabs.map((tab) => tab.name.toLowerCase()))
  for (let n = tabs.length + 1; ; n++) if (!names.has(`tab ${n}`)) return `Tab ${n}`
}

/** A sequence of edits, with the tab to select found in the result. */
function sequence(
  blocks: readonly string[],
  edits: Array<DocBlockEdit | ((current: string[]) => DocBlockEdit)>,
  select: (tabs: DocTab[]) => DocTab | undefined,
): TabChange {
  let current = [...blocks]
  const out: DocBlockEdit[] = []
  for (const step of edits) {
    const edit = typeof step === 'function' ? step(current) : step
    const next = applyBlockEdit(current, edit)
    if (!next) return { error: 'The doc changed; try again.' }
    out.push(edit)
    current = next
  }
  return { edits: out, select: select(docTabs(current))?.id }
}

/**
 * A new tab at the end (named `name`, or `Tab N`). The first tab of an unmarked doc gets its own
 * marker first, so emptying it later never makes it vanish: two edits then, one otherwise.
 */
export function addTab(blocks: readonly string[], name?: string): TabChange {
  const tabs = docTabs(blocks)
  if (tabs.length >= DOC_TAB_LIMITS.tabs) return { error: `A doc has at most ${DOC_TAB_LIMITS.tabs} tabs.` }
  const clean = cleanTabName(name ?? '') || freshName(tabs)
  const first = nameFirst(tabs)
  const marker = tabMarker(clean)
  if (first && blocks.length === 0)
    return sequence(blocks, [{ index: 0, span: 0, before: '', after: `${first.after}\n\n${marker}` }], (next) => next.at(-1))
  return sequence(
    blocks,
    [...(first ? [first] : []), (current) => ({ index: current.length, span: 0, before: '', after: marker })],
    (next) => next.at(-1),
  )
}

export function renameTab(blocks: readonly string[], tabId: string, name: string): TabChange {
  const tabs = docTabs(blocks)
  const index = tabs.findIndex((tab) => tab.id === tabId)
  const tab = tabs[index]
  if (!tab) return { error: 'That tab is gone.' }
  const clean = cleanTabName(name)
  if (!clean) return { error: 'A tab needs a name.' }
  if (clean === tab.name) return { edits: [], select: tab.id }
  const edit: DocBlockEdit =
    tab.marker === null
      ? { index: 0, span: 0, before: '', after: tabMarker(clean) }
      : { index: tab.marker, before: blocks[tab.marker], after: tabMarker(clean) }
  return sequence(blocks, [edit], (next) => next[index])
}

/** Deletes a tab and everything in it. The last tab cannot go. */
export function deleteTab(blocks: readonly string[], tabId: string): TabChange {
  const tabs = docTabs(blocks)
  const index = tabs.findIndex((tab) => tab.id === tabId)
  const tab = tabs[index]
  if (!tab) return { error: 'That tab is gone.' }
  if (tabs.length <= 1) return { error: 'A doc keeps at least one tab.' }
  const { from, to } = ownBlocks(tab)
  if (to === from) return { error: 'That tab is gone.' }
  const edit: DocBlockEdit = { index: from, span: to - from, before: blocks.slice(from, to).join('\n\n'), after: '' }
  return sequence(blocks, [edit], (next) => next[Math.min(index, next.length - 1)] ?? next[0])
}

/**
 * Moves a tab so it ends up at position `to` among the tabs, its blocks cut and pasted as they are.
 * An unnamed first tab is named first when the move would take it from the front.
 */
export function moveTab(blocks: readonly string[], tabId: string, to: number): TabChange {
  const tabs = docTabs(blocks)
  const from = tabs.findIndex((tab) => tab.id === tabId)
  if (from === -1) return { error: 'That tab is gone.' }
  const target = Math.max(0, Math.min(tabs.length - 1, to))
  if (target === from) return { edits: [], select: tabId }
  // Only a move to or from the front can leave the unnamed first tab anywhere but first.
  const first = from === 0 || target === 0 ? nameFirst(tabs) : null
  const steps: Array<DocBlockEdit | ((current: string[]) => DocBlockEdit)> = first ? [first] : []
  steps.push((current) => {
    const now = docTabs(current)
    const tab = now[from]
    const { from: start, to: end } = ownBlocks(tab)
    const span = end - start
    // Where its first block lands once it is cut out: the target tab's start, or the end.
    const rest = now.filter((_, n) => n !== from)
    const dest = rest[target]
    const at = dest ? ownBlocks(dest).from : current.length
    const moveTo = at > start ? at - span : at
    const source = current.slice(start, end).join('\n\n')
    return { index: start, span, before: source, after: source, moveTo }
  })
  return sequence(blocks, steps, (next) => next[target])
}

/** The tab holding block `index` (a marker belongs to its own tab). */
export function tabOfBlock(tabs: DocTab[], index: number): DocTab | undefined {
  return tabs.find((tab) => index >= (tab.marker ?? tab.start) && index < tab.end) ?? tabs.at(-1)
}
