import { describe, expect, test } from 'bun:test'

import { DESIGN_EXAMPLE, emptyDesign, validateDesign, type Design, type FrameNode } from './design'
import {
  detachInstance,
  insertInstance,
  removeBoardDetaching,
  removeNodeDetaching,
  resolveInstance,
  setComponent,
  setOverride,
} from './design-components'
import { DESIGN_LIBRARY, LIBRARY_IDS, libraryNode } from './design-library'
import { addPage, boardsOnPage, movePage, moveBoardToPage, pageOf, pagesOf, removePage, IMPLICIT_PAGE_ID } from './design-pages'
import { findNode, getBoard, insertNode, moveNodeTo } from './design-tree'
import { DESIGN_LIBRARY_IDS, collectMains } from './design'

const ok = (design: Design) => {
  const result = validateDesign(design)
  if (!result.ok) throw new Error(result.errors.join('\n'))
  return design
}
const errorsOf = (design: unknown) => {
  const result = validateDesign(design)
  return result.ok ? [] : result.errors
}

/** A v1 body exactly as stored before pages and components existed. */
const V1: Design = structuredClone(DESIGN_EXAMPLE)

describe('v1 bodies', () => {
  test('still parse, and behave as one implicit page holding every board', () => {
    ok(V1)
    expect(pagesOf(V1)).toEqual([{ id: IMPLICIT_PAGE_ID, title: 'Page 1' }])
    expect(boardsOnPage(V1, IMPLICIT_PAGE_ID).map((b) => b.id)).toEqual(['desktop', 'phone'])
  })
})

describe('pages', () => {
  test('adding a page materialises the implicit one and stamps existing boards', () => {
    const { design, pageId } = addPage(V1, 'Flows')
    ok(design)
    expect(design.pages!.map((p) => p.title)).toEqual(['Page 1', 'Flows'])
    expect(design.boards.every((b) => b.page === design.pages![0].id)).toBe(true)
    expect(boardsOnPage(design, pageId!)).toEqual([])
  })

  test('a page reference must name a declared page', () => {
    expect(errorsOf({ ...V1, boards: [{ ...V1.boards[0], page: 'nope' }] })[0]).toContain('declares no pages')
    const paged = addPage(V1, 'Two').design
    expect(errorsOf({ ...paged, boards: [{ ...paged.boards[0], page: 'nope' }] })[0]).toContain('no page "nope"')
    // A page id joins the one id space.
    expect(errorsOf({ ...paged, pages: [...paged.pages!, { id: 'desktop', title: 'Clash' }] }).join()).toContain('duplicate id "desktop"')
  })

  test('reordering keeps boards on their page; removing a page removes its boards and links', () => {
    const two = addPage(V1, 'Two')
    const moved = moveBoardToPage(two.design, 'phone', two.pageId!)
    ok(moved)
    expect(pageOf(moved, getBoard(moved, 'phone')!)).toBe(two.pageId!)
    const reordered = movePage(moved, two.pageId!, 0)
    expect(pageOf(reordered, getBoard(reordered, 'desktop')!)).toBe(moved.pages![0].id)
    const removed = ok(removePage(reordered, two.pageId!))
    expect(removed.boards.map((b) => b.id)).toEqual(['desktop'])
    // The last page stays.
    expect(removePage(removed, removed.pages![0].id)).toBe(removed)
  })
})

describe('moveNodeTo', () => {
  const nav = () => findNode(getBoard(V1, 'desktop')!.root, 'd-nav')!

  test('reorders within a frame using pre-move indexes', () => {
    const { design } = moveNodeTo(V1, 'desktop', 'd-nav', { boardId: 'desktop', parentId: 'd-root', index: 2 })
    expect(getBoard(ok(design), 'desktop')!.root.children.map((c) => c.id)).toEqual(['d-hero', 'd-nav'])
    // Dropping a node where it already is changes nothing.
    expect(moveNodeTo(V1, 'desktop', 'd-nav', { boardId: 'desktop', parentId: 'd-root', index: 1 }).nodeId).toBeNull()
    expect(nav().index).toBe(0)
  })

  test('moves between frames and boards; never into its own subtree or the root', () => {
    const across = moveNodeTo(V1, 'desktop', 'd-cta', { boardId: 'phone', parentId: 'p-hero', index: 0 })
    const next = ok(across.design)
    expect(findNode(getBoard(next, 'phone')!.root, 'd-cta')?.parent?.id).toBe('p-hero')
    expect(findNode(getBoard(next, 'desktop')!.root, 'd-cta')).toBeNull()
    expect(moveNodeTo(V1, 'desktop', 'd-hero', { boardId: 'desktop', parentId: 'd-copy', index: 0 }).nodeId).toBeNull()
    expect(moveNodeTo(V1, 'desktop', 'd-root', { boardId: 'phone', parentId: 'p-root', index: 0 }).nodeId).toBeNull()
  })

  test('copy (alt-drag) leaves the original and adds a fresh-id duplicate; absolute targets get x/y', () => {
    const withCanvas = insertNode(V1, 'desktop', 'd-root', { type: 'frame', id: 'd-free', layout: 'absolute', h: 200, children: [] })
    const copy = moveNodeTo(withCanvas, 'desktop', 'd-cta', { boardId: 'desktop', parentId: 'd-free', index: 0, x: 40.4, y: 12 }, { copy: true })
    const next = ok(copy.design)
    expect(copy.nodeId).not.toBe('d-cta')
    expect(findNode(getBoard(next, 'desktop')!.root, 'd-cta')).not.toBeNull()
    const placed = findNode(getBoard(next, 'desktop')!.root, copy.nodeId!)!.node
    expect([placed.x, placed.y]).toEqual([40, 12])
    // Leaving an absolute frame drops x/y.
    const back = moveNodeTo(next, 'desktop', copy.nodeId!, { boardId: 'desktop', parentId: 'd-copy', index: 0 })
    const node = findNode(getBoard(ok(back.design), 'desktop')!.root, copy.nodeId!)!.node
    expect(node.x).toBeUndefined()
  })
})

describe('components', () => {
  const withMain = () => ok(setComponent(V1, 'desktop', 'd-nav', true))

  test('an instance draws the main with its own id, prefixed inner ids and content overrides', () => {
    const main = withMain()
    const placed = insertInstance(main, 'phone', 'p-root', 'd-nav', 0)
    let design = ok(placed.design)
    design = ok(setOverride(design, 'phone', placed.nodeId!, 'd-logo', { text: 'Ledgerly mobile' }))
    design = ok(setOverride(design, 'phone', placed.nodeId!, 'gone-node', { text: 'stale' }))
    const instance = findNode(getBoard(design, 'phone')!.root, placed.nodeId!)!.node as FrameNode
    const drawn = resolveInstance(instance, collectMains(design.boards))
    expect(drawn.id).toBe(placed.nodeId!)
    expect(drawn.layout).toBe('stack-h')
    const logo = drawn.children[0]
    expect(logo.id).toBe(`${placed.nodeId}~d-logo`)
    expect(logo.type === 'text' && logo.text).toBe('Ledgerly mobile')
    // Editing the main restyles the instance.
    const restyled = ok({ ...design, boards: design.boards.map((b) => (b.id === 'desktop' ? { ...b, root: { ...b.root, children: [{ ...(b.root.children[0] as FrameNode), gap: 40 }, ...b.root.children.slice(1)] } } : b)) })
    expect(resolveInstance(instance, collectMains(restyled.boards)).gap).toBe(40)
  })

  test('validation refuses dangling instances, cycles and instances with children', () => {
    const main = withMain()
    const dangling = insertNode(main, 'phone', 'p-root', { type: 'frame', id: 'x1', layout: 'stack-v', instanceOf: 'nope', children: [] })
    expect(errorsOf(dangling).join()).toContain('no main component "nope"')
    const selfish = insertNode(main, 'desktop', 'd-links', { type: 'frame', id: 'x2', layout: 'stack-v', instanceOf: 'd-nav', children: [] })
    expect(errorsOf(selfish).join()).toContain('contains an instance of itself')
    const fat = insertNode(main, 'phone', 'p-root', {
      type: 'frame', id: 'x3', layout: 'stack-v', instanceOf: 'd-nav', children: [{ type: 'divider', id: 'x4' }],
    })
    expect(errorsOf(fat).join()).toContain('has no children of its own')
  })

  test('deleting a main detaches its instances (overrides baked in) so the delete validates', () => {
    const main = withMain()
    const placed = insertInstance(main, 'phone', 'p-root', 'd-nav', 0)
    const design = setOverride(placed.design, 'phone', placed.nodeId!, 'd-logo', { text: 'Kept' })
    const removed = ok(removeNodeDetaching(design, 'desktop', 'd-nav'))
    const detached = findNode(getBoard(removed, 'phone')!.root, placed.nodeId!)!.node as FrameNode
    expect(detached.instanceOf).toBeUndefined()
    expect(JSON.stringify(detached)).toContain('Kept')
    ok(removeBoardDetaching(design, 'desktop'))
    ok(setComponent(design, 'desktop', 'd-nav', false))
    expect(ok(detachInstance(design, 'phone', placed.nodeId!)).boards).toBeDefined()
  })
})

describe('library', () => {
  test('every entry inserts as a valid subtree, wide and compact, even without tokens', () => {
    const bare: Design = { version: 1, title: 'Bare', boards: [{ id: 'b', title: 'B', x: 0, y: 0, w: 390, h: 844, root: { type: 'frame', id: 'b-root', layout: 'stack-v', children: [] } }] }
    for (const design of [V1, bare, emptyDesign()]) {
      const board = design.boards[0] ?? null
      for (const entry of DESIGN_LIBRARY) {
        for (const compact of [false, true]) {
          const node = libraryNode(design, entry.id, compact)!
          const target = board ? insertNode(design, board.id, board.root.id, node) : design
          ok(target)
        }
      }
    }
    // The guide lists exactly the ids the insert op accepts.
    expect([...DESIGN_LIBRARY_IDS]).toEqual(LIBRARY_IDS)
    // Two inserts never share ids.
    const once = insertNode(V1, 'desktop', 'd-root', libraryNode(V1, 'pricing', false)!)
    ok(insertNode(once, 'desktop', 'd-root', libraryNode(once, 'pricing', false)!))
  })
})
