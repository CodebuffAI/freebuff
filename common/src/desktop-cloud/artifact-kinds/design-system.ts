import {
  DESIGN_LIMITS,
  collectMains,
  validateDesign,
  type Design,
  type DesignBoard,
  type DesignNode,
  type DesignSystemDef,
  type DesignTokens,
  type FillStyleDef,
  type FrameNode,
  type InstalledSystem,
  type TextStyleDef,
} from './design'
import { componentToReact, componentName } from './design-codegen'
import { pruneDangling } from './design-logic-edit'
import { addPage } from './design-pages'
import { tokensToCss, tokensToJson } from './design-styles'
import { allIds, getBoard } from './design-tree'
import { variantName } from './design-variants'

/**
 * Design systems. A design PUBLISHES a system by declaring `system` (name, version, guidelines,
 * which main components): its tokens (colours across light and dark, fonts from the allowlist,
 * radius, spacing unit and scale), its shared text and fill styles (the type scale) and those
 * components with their variants. Another design of the same user INSTALLS it by reference:
 * everything is copied in at install (ids prefixed per system, so two systems never clash), the
 * source artifact and revision are recorded, and "update available" is the source's revision
 * having moved on. Updating re-copies over the same ids, so every instance follows; a component
 * the source dropped stays (marked) rather than leaving instances dangling. Pure.
 */

export type SystemSnapshot = {
  system: DesignSystemDef
  tokens: DesignTokens
  textStyles: TextStyleDef[]
  fillStyles: FillStyleDef[]
  /** Main components (and the mains they use), source ids. */
  components: FrameNode[]
}

/** The main components the system lists (default every main), plus the mains they draw. */
function systemMains(design: Design): FrameNode[] {
  const mains = collectMains(design.boards)
  // In layer order (board by board, top to bottom), so a package and an install read like the source.
  const ordered: string[] = []
  const walk = (node: DesignNode) => {
    if (node.type !== 'frame') return
    if (node.component) ordered.push(node.id)
    node.children.forEach(walk)
  }
  design.boards.forEach((board) => walk(board.root))
  const wanted = design.system?.components?.length ? design.system.components : ordered
  const out = new Map<string, FrameNode>()
  const visit = (id: string) => {
    if (out.has(id)) return
    const main = mains.get(id)
    if (!main) return
    out.set(id, main)
    const stack: DesignNode[] = [...main.children]
    while (stack.length) {
      const node = stack.pop()!
      if (node.type !== 'frame') continue
      if (node.instanceOf !== undefined) visit(node.instanceOf)
      stack.push(...node.children)
    }
  }
  wanted.forEach(visit)
  return [...out.values()]
}

/** What a design publishes as a system, or null when it declares none. */
export function systemSnapshot(design: Design): SystemSnapshot | null {
  if (!design.system) return null
  return {
    system: design.system,
    tokens: design.tokens ?? { colors: {} },
    textStyles: design.styles?.text ?? [],
    fillStyles: design.styles?.fills ?? [],
    components: systemMains(design),
  }
}

const slugOf = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 20) || 'system'

/** The id prefix one installed system's copies carry. */
export function systemPrefix(name: string): string {
  return `ds-${slugOf(name)}-`
}

const prefixed = (prefix: string, id: string) => `${prefix}${id}`.slice(0, 64)

/** A copy of a source main with every id, instance, style and link mapped into the target. */
function copyMain(main: FrameNode, prefix: string, styleMap: Map<string, string>): FrameNode {
  const visit = (node: DesignNode): DesignNode => {
    const out: Record<string, unknown> = { ...node, id: prefixed(prefix, node.id) }
    // Links, interactions, bindings and showIf name boards and variables of the source: dropped.
    delete out.linkTo
    delete out.transition
    delete out.interactions
    delete out.showIf
    delete out.bind
    delete out.responsive
    if (node.type === 'text' && node.textStyle) out.textStyle = styleMap.get(`t:${node.textStyle}`)
    if ((node.type === 'frame' || node.type === 'shape') && node.fillStyle) out.fillStyle = styleMap.get(`f:${node.fillStyle}`)
    for (const key of Object.keys(out)) if (out[key] === undefined) delete out[key]
    if (node.type === 'frame') {
      if (node.instanceOf !== undefined) out.instanceOf = prefixed(prefix, node.instanceOf)
      if (node.overrides) out.overrides = Object.fromEntries(Object.entries(node.overrides).map(([id, value]) => [prefixed(prefix, id), value]))
      delete out.repeat
      out.children = node.children.map(visit)
    }
    return out as unknown as DesignNode
  }
  const copy = visit(main) as FrameNode
  // On the system's board the mains sit in a wrapping row: their own placement is the source's.
  const { x: _x, y: _y, absolute: _a, anchor: _b, constraints: _c, ...rest } = copy
  return { ...rest, component: true }
}

function mergeTokens(base: DesignTokens | undefined, incoming: DesignTokens): DesignTokens | null {
  const colors = { ...(base?.colors ?? {}), ...incoming.colors }
  if (Object.keys(colors).length > DESIGN_LIMITS.maxTokens) return null
  const dark = { ...(base?.themes?.dark ?? {}), ...(incoming.themes?.dark ?? {}) }
  const out: DesignTokens = { ...(base ?? { colors: {} }), colors }
  if (incoming.fonts) out.fonts = incoming.fonts
  if (incoming.radius !== undefined) out.radius = incoming.radius
  if (incoming.spacingUnit !== undefined) out.spacingUnit = incoming.spacingUnit
  if (incoming.spacingScale) out.spacingScale = incoming.spacingScale
  if (Object.keys(dark).length) out.themes = { dark }
  return out
}

export type InstallSource = { artifactId: string; revision: number }
export type InstallResult = { ok: true; design: Design; installedId: string } | { ok: false; error: string }

/**
 * Installs (or, when `existingId` names an installed entry, updates) a system into `target`:
 * tokens merged (the system's values win), its styles and components copied with prefixed ids
 * onto the system's own board on its own page. Refused, with a reason, when the copy would not
 * fit the design's caps; the result always passes `validateDesign`.
 */
export function installSystem(target: Design, snapshot: SystemSnapshot, source: InstallSource, now: string, existingId?: string): InstallResult {
  const installed = target.installedSystems ?? []
  const existing = existingId ? installed.find((entry) => entry.id === existingId) : installed.find((entry) => entry.artifactId === source.artifactId)
  if (!existing && installed.length >= DESIGN_LIMITS.maxInstalledSystems) return { ok: false, error: `a design installs at most ${DESIGN_LIMITS.maxInstalledSystems} design systems` }
  const prefix = existing ? existing.id.replace(/^sys-/, 'ds-') + '-' : systemPrefix(snapshot.system.name)
  const entryId = existing?.id ?? `sys-${prefix.slice(3, -1)}`.slice(0, 64)
  if (!existing && installed.some((entry) => entry.id === entryId)) return { ok: false, error: `a system named "${snapshot.system.name}" is already installed` }

  const tokens = mergeTokens(target.tokens, snapshot.tokens)
  if (!tokens) return { ok: false, error: `the system's colours would take the design past ${DESIGN_LIMITS.maxTokens} colour tokens` }

  // Styles: copied under prefixed ids; an update replaces the previous copies.
  const styleMap = new Map<string, string>()
  const ownText = new Set(existing?.textStyles ?? [])
  const ownFill = new Set(existing?.fillStyles ?? [])
  const textStyles = snapshot.textStyles.map((style) => {
    const id = prefixed(prefix, style.id)
    styleMap.set(`t:${style.id}`, id)
    return { ...style, id }
  })
  const fillStyles = snapshot.fillStyles.map((style) => {
    const id = prefixed(prefix, style.id)
    styleMap.set(`f:${style.id}`, id)
    return { ...style, id }
  })
  const keepText = (target.styles?.text ?? []).filter((style) => !ownText.has(style.id) && !textStyles.some((copy) => copy.id === style.id))
  const keepFill = (target.styles?.fills ?? []).filter((style) => !ownFill.has(style.id) && !fillStyles.some((copy) => copy.id === style.id))
  if (keepText.length + textStyles.length > DESIGN_LIMITS.maxStyles || keepFill.length + fillStyles.length > DESIGN_LIMITS.maxStyles) {
    return { ok: false, error: `the system's styles would take the design past ${DESIGN_LIMITS.maxStyles} styles of a kind` }
  }

  // Components: on the system's board; an update keeps mains the source dropped (instances may use them).
  let design: Design = { ...target, tokens, styles: { ...(target.styles ?? {}), text: [...keepText, ...textStyles], fills: [...keepFill, ...fillStyles] } }
  if (design.styles && !design.styles.text?.length) delete design.styles.text
  if (design.styles && !design.styles.fills?.length) delete design.styles.fills
  const copies = snapshot.components.map((main) => copyMain(main, prefix, styleMap))
  const copyIds = new Set(copies.flatMap((main) => [...idsOf(main)]))
  const oldBoard = existing?.boardId ? getBoard(design, existing.boardId) : undefined
  const dropped = oldBoard
    ? oldBoard.root.children.filter((child): child is FrameNode => child.type === 'frame' && child.component === true && !copyIds.has(child.id)).map((main) => ({ ...main, name: main.name?.endsWith('(removed from system)') ? main.name : `${main.name ?? main.id} (removed from system)`.slice(0, 80) }))
    : []
  // Ids the copy takes must be free outside the system's own board.
  const taken = allIds(oldBoard ? { ...design, boards: design.boards.filter((board) => board.id !== oldBoard.id) } : design)
  const clash = [...copyIds].find((id) => taken.has(id))
  if (clash) return { ok: false, error: `the id "${clash}" is already used in this design` }

  let pageId = existing?.pageId
  if (!pageId || !design.pages?.some((page) => page.id === pageId)) {
    const made = addPage(design, `${snapshot.system.name} components`)
    if (!made.pageId) return { ok: false, error: `a design has at most ${DESIGN_LIMITS.maxPages} pages` }
    design = made.design
    pageId = made.pageId
  }
  const boardId = existing?.boardId && oldBoard ? existing.boardId : prefixed(prefix, 'board')
  const children: DesignNode[] = [...copies, ...dropped]
  const rows = Math.max(1, Math.ceil(children.length / 3))
  const board: DesignBoard = {
    id: boardId,
    title: `${snapshot.system.name} · components`.slice(0, 120),
    x: oldBoard?.x ?? 0,
    y: oldBoard?.y ?? 0,
    w: 1440,
    h: Math.min(8192, 160 + rows * 420),
    page: pageId,
    root: { type: 'frame', id: prefixed(prefix, 'board-root'), layout: 'stack-h', wrap: true, gap: 48, padding: 64, align: 'start', children },
  }
  design = oldBoard ? { ...design, boards: design.boards.map((entry) => (entry.id === boardId ? board : entry)) } : { ...design, boards: [...design.boards, board] }
  if (design.boards.length > DESIGN_LIMITS.maxBoards) return { ok: false, error: `a design has at most ${DESIGN_LIMITS.maxBoards} boards` }

  const entry: InstalledSystem = {
    id: entryId,
    artifactId: source.artifactId,
    name: snapshot.system.name,
    revision: source.revision,
    ...(snapshot.system.version !== undefined ? { version: snapshot.system.version } : {}),
    installedAt: now.slice(0, 40),
    pageId,
    boardId,
    tokens: Object.keys(snapshot.tokens.colors).slice(0, DESIGN_LIMITS.maxTokens),
    textStyles: textStyles.map((style) => style.id),
    fillStyles: fillStyles.map((style) => style.id),
    components: copies.map((main) => main.id),
  }
  design = { ...design, installedSystems: existing ? installed.map((item) => (item.id === entry.id ? entry : item)) : [...installed, entry] }
  design = pruneDangling(design)
  const verdict = validateDesign(design)
  if (!verdict.ok) return { ok: false, error: verdict.errors[0] }
  return { ok: true, design, installedId: entry.id }
}

function* idsOf(node: DesignNode): Generator<string> {
  yield node.id
  if (node.type === 'frame') for (const child of node.children) yield* idsOf(child)
}

/** Forgets an installed system: its record, board and styles go; its instances are detached by the caller's remove-board helper. */
export function uninstallRecord(design: Design, installedId: string): Design {
  const entry = design.installedSystems?.find((item) => item.id === installedId)
  if (!entry) return design
  const installedSystems = design.installedSystems!.filter((item) => item.id !== installedId)
  const next: Design = { ...design, installedSystems: installedSystems.length ? installedSystems : undefined }
  if (!next.installedSystems) delete next.installedSystems
  return next
}

/** Whether the source has moved on since the install: a newer revision (and, when published, version). */
export function updateAvailable(entry: InstalledSystem, source: { revision: number; version?: number }): boolean {
  if (source.version !== undefined && entry.version !== undefined) return source.version > entry.version || (source.version === entry.version && source.revision > entry.revision)
  return source.revision > entry.revision
}

// ---- the system as a package

export type PackageFile = { path: string; content: string }

/**
 * A system as a small package: tokens (CSS with a dark theme, JSON), one React + Tailwind file
 * per main component, and per variant group a component whose variants are a `variant` prop,
 * plus an index and a README with the guidelines. Plain text files, ready to zip.
 */
export function systemPackage(design: Design): PackageFile[] {
  const name = design.system?.name ?? design.title
  const files: PackageFile[] = []
  const dark = design.tokens?.themes?.dark ?? {}
  const darkCss = Object.keys(dark).length
    ? `\n[data-theme="dark"] {\n${Object.entries(dark).map(([key, value]) => `  --color-${key}: ${value};`).join('\n')}\n}\n`
    : ''
  files.push({ path: 'tokens.css', content: `${tokensToCss(design)}${darkCss}` })
  files.push({ path: 'tokens.json', content: tokensToJson(design) })
  const mains = systemMains(design)
  const groups = new Map<string, Array<{ main: FrameNode; variant: string }>>()
  const singles: FrameNode[] = []
  for (const main of mains) {
    const named = variantName(main.name)
    if (named.variant === null) singles.push(main)
    else {
      const list = groups.get(named.group) ?? []
      list.push({ main, variant: named.variant })
      groups.set(named.group, list)
    }
  }
  const exports: string[] = []
  const usedNames = new Set<string>()
  const unique = (base: string) => {
    let out = base
    for (let n = 2; usedNames.has(out); n += 1) out = `${base}${n}`
    usedNames.add(out)
    return out
  }
  for (const main of singles) {
    const code = componentToReact(design, main.id)
    if (!code) continue
    const component = unique(componentName(main.name ?? main.id))
    files.push({ path: `components/${component}.tsx`, content: code.replace(/export default function \w+\(/, `export default function ${component}(`) })
    exports.push(`export { default as ${component} } from './components/${component}'`)
  }
  for (const [group, variants] of groups) {
    const component = unique(componentName(group))
    const parts: Array<{ key: string; ident: string }> = []
    const keys = new Set<string>()
    for (const { main, variant } of variants) {
      const code = componentToReact(design, main.id)
      if (!code) continue
      let key = variant.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'default'
      for (let n = 2; keys.has(key); n += 1) key = `${key}-${n}`
      keys.add(key)
      const ident = `${component}${componentName(variant)}`
      files.push({ path: `components/${component}/${ident}.tsx`, content: code.replace(/export default function \w+\(/, `export default function ${ident}(`) })
      parts.push({ key, ident })
    }
    if (parts.length === 0) continue
    const union = parts.map((part) => JSON.stringify(part.key)).join(' | ')
    files.push({
      path: `components/${component}.tsx`,
      content: [
        ...parts.map((part) => `import ${part.ident} from './${component}/${part.ident}'`),
        '',
        `export type ${component}Variant = ${union}`,
        '',
        `/** ${group}: its variants from the design system "${name.replace(/\*\//g, '* /')}". */`,
        `export default function ${component}({ variant = ${JSON.stringify(parts[0].key)} }: { variant?: ${component}Variant }) {`,
        '  switch (variant) {',
        ...parts.slice(1).map((part) => `    case ${JSON.stringify(part.key)}:\n      return <${part.ident} />`),
        '    default:',
        `      return <${parts[0].ident} />`,
        '  }',
        '}',
        '',
      ].join('\n'),
    })
    exports.push(`export { default as ${component}, type ${component}Variant } from './components/${component}'`)
  }
  files.push({ path: 'index.ts', content: `import './tokens.css'\n\n${exports.join('\n')}\n` })
  files.push({
    path: 'README.md',
    content: [
      `# ${name}${design.system?.version !== undefined ? ` v${design.system.version}` : ''}`,
      '',
      design.system?.description ?? 'A design system exported from Freebuff.',
      '',
      '- `tokens.css`: colours, radius and spacing as CSS variables (`[data-theme="dark"]` for dark).',
      '- `tokens.json`: the same tokens as data.',
      '- `components/`: React + Tailwind components; a group of variants is one component with a `variant` prop.',
      '',
      ...(design.system?.guidelines ? ['## Guidelines', '', design.system.guidelines, ''] : []),
    ].join('\n'),
  })
  return files
}
