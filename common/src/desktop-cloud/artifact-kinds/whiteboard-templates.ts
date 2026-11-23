/**
 * Board templates: brainstorm, flowchart, kanban, retro, user journey, a 2×2 matrix and
 * swimlanes, built
 * from the board model laid out the way the guide advises (8-unit grid, 200×200 notes 40 apart,
 * sections padded 40 with a 48 title band, sections before their members). `applyTemplate` adds
 * one to a board: as is on an empty board, else below what is there with fresh ids. Pure: no DOM.
 */

import { contentBounds, geometryContext } from './whiteboard-geometry'
import { pasteFragment, translateElements } from './whiteboard-ops'
import type { NoteElement, Point, Side, WhiteboardBoard, WhiteboardColor, WhiteboardElement } from './whiteboard'

export const TEMPLATE_IDS = [
  'brainstorm',
  'flowchart',
  'kanban',
  'retro',
  'user-journey',
  'matrix',
  'swimlanes',
  // Round 4.
  'swot',
  'mind-map',
  'roadmap',
  'dot-voting',
] as const
export type TemplateId = (typeof TEMPLATE_IDS)[number]

export const TEMPLATE_INFO: Record<TemplateId, { title: string; blurb: string }> = {
  brainstorm: { title: 'Brainstorm', blurb: 'A topic and three themes of notes' },
  flowchart: { title: 'Flowchart', blurb: 'Steps, a decision and elbow arrows' },
  kanban: { title: 'Kanban', blurb: 'To do, Doing and Done columns' },
  retro: { title: 'Retro', blurb: 'Went well, to improve and actions' },
  'user-journey': { title: 'User journey', blurb: 'Stages with what people do and feel' },
  matrix: { title: '2×2 matrix', blurb: 'Impact against effort' },
  swimlanes: { title: 'Swimlanes', blurb: 'A process across teams, one lane each' },
  swot: { title: 'SWOT', blurb: 'Strengths, weaknesses, opportunities, threats' },
  'mind-map': { title: 'Mind map', blurb: 'A central idea and four branches' },
  roadmap: { title: 'Roadmap', blurb: 'Now, Next and Later' },
  'dot-voting': { title: 'Dot voting', blurb: 'Ideas to vote on, with a 5-minute timer' },
}

const NOTE = 200
const GAP = 40
const PAD = 40
const HEAD = 48

const note = (id: string, x: number, y: number, text: string, color: WhiteboardColor): NoteElement => ({
  type: 'note',
  id,
  x,
  y,
  w: NOTE,
  h: NOTE,
  text,
  color,
})

/** A section that fits `cols × rows` notes, with its notes (texts in reading order, blanks for the rest). */
function noteSection(
  id: string,
  x: number,
  y: number,
  title: string,
  cols: number,
  rows: number,
  texts: readonly string[],
  noteColor: WhiteboardColor,
  sectionColor: WhiteboardColor = 'gray',
  stack = false,
): WhiteboardElement[] {
  const w = PAD + cols * NOTE + (cols - 1) * GAP + PAD
  const h = HEAD + rows * NOTE + (rows - 1) * GAP + PAD
  const out: WhiteboardElement[] = [{ type: 'section', id, x, y, w, h, title, color: sectionColor, ...(stack ? { stack: true } : {}) }]
  texts.forEach((text, i) => {
    if (i >= cols * rows) return
    const cx = x + PAD + (i % cols) * (NOTE + GAP)
    const cy = y + HEAD + Math.floor(i / cols) * (NOTE + GAP)
    out.push(note(`${id}-n${i + 1}`, cx, cy, text, noteColor))
  })
  return out
}

const title = (text: string): WhiteboardElement => ({ type: 'text', id: 'title', x: 0, y: 0, text, size: 'xl' })

function brainstorm(): WhiteboardElement[] {
  const top = 96
  return [
    title('Brainstorm'),
    { type: 'text', id: 'prompt', x: 0, y: 64, text: 'What are we solving? Add a note per idea; vote with stickers.', size: 's', w: 600 },
    ...noteSection('themes-a', 0, top, 'Theme A', 2, 2, ['Idea', 'Idea'], 'yellow'),
    ...noteSection('themes-b', 600, top, 'Theme B', 2, 2, ['Idea', 'Idea'], 'purple'),
    ...noteSection('themes-c', 1200, top, 'Open questions', 2, 2, ['Question?'], 'blue'),
  ]
}

function flowchart(): WhiteboardElement[] {
  const y = 120
  return [
    title('Flowchart'),
    { type: 'shape', id: 'start', kind: 'pill', x: 0, y, w: 160, h: 80, text: 'Start', color: 'green' },
    { type: 'shape', id: 'step', kind: 'rect', x: 240, y, w: 160, h: 80, text: 'Do the step', color: 'blue' },
    { type: 'shape', id: 'check', kind: 'diamond', x: 480, y: y - 20, w: 160, h: 120, text: 'Done?', color: 'yellow' },
    { type: 'shape', id: 'end', kind: 'pill', x: 720, y, w: 160, h: 80, text: 'End', color: 'green' },
    { type: 'arrow', id: 'a-start', from: { elementId: 'start' }, to: { elementId: 'step' }, style: 'solid', routing: 'elbow' },
    { type: 'arrow', id: 'a-step', from: { elementId: 'step' }, to: { elementId: 'check' }, style: 'solid', routing: 'elbow' },
    { type: 'arrow', id: 'a-yes', from: { elementId: 'check' }, to: { elementId: 'end' }, label: 'yes', style: 'solid', routing: 'elbow' },
    {
      type: 'arrow',
      id: 'a-no',
      from: { elementId: 'check', side: 'bottom' },
      to: { elementId: 'step', side: 'bottom' },
      label: 'no',
      style: 'dashed',
      routing: 'elbow',
    },
  ]
}

function kanban(): WhiteboardElement[] {
  const top = 96
  const column = PAD + NOTE + PAD + GAP * 2 // a 280-wide column, then 80 to the next
  return [
    title('Kanban'),
    // Round 5: the columns stack their cards, so a card dragged between them snaps into order.
    ...noteSection('todo', 0, top, 'To do', 1, 3, ['Task', 'Task'], 'yellow', 'gray', true),
    ...noteSection('doing', column, top, 'Doing', 1, 3, ['In progress'], 'blue', 'gray', true),
    ...noteSection('done', column * 2, top, 'Done', 1, 3, [], 'green', 'green', true),
  ]
}

function retro(): WhiteboardElement[] {
  const top = 96
  return [
    title('Retro'),
    ...noteSection('went-well', 0, top, 'Went well', 2, 2, ['What helped?'], 'green', 'green'),
    ...noteSection('to-improve', 600, top, 'To improve', 2, 2, ['What slowed us down?'], 'red', 'red'),
    { type: 'section', id: 'actions', x: 1200, y: top, w: 520, h: 528, title: 'Actions', color: 'blue' },
    {
      type: 'table',
      id: 'actions-table',
      x: 1240,
      y: top + HEAD,
      w: 440,
      h: 200,
      rows: [
        ['Action', 'Owner', 'Due'],
        ['', '', ''],
        ['', '', ''],
        ['', '', ''],
        ['', '', ''],
      ],
      header: true,
    },
  ]
}

function userJourney(): WhiteboardElement[] {
  const stages = ['Discover', 'Sign up', 'First use', 'Come back']
  const step = NOTE + 80
  const out: WhiteboardElement[] = [
    title('User journey'),
    { type: 'text', id: 'row-doing', x: 0, y: 232, text: 'Doing', size: 'm' },
    { type: 'text', id: 'row-feeling', x: 0, y: 472, text: 'Feeling', size: 'm' },
  ]
  const x0 = 120
  stages.forEach((stage, i) => {
    const x = x0 + i * step
    out.push({ type: 'shape', id: `stage-${i + 1}`, kind: 'rounded', x, y: 96, w: NOTE, h: 80, text: stage, color: 'blue' })
    out.push(note(`doing-${i + 1}`, x, 216, 'What they do', 'yellow'))
    out.push(note(`feeling-${i + 1}`, x, 456, 'How they feel', 'purple'))
    if (i > 0) {
      out.push({
        type: 'arrow',
        id: `a-stage-${i}`,
        from: { elementId: `stage-${i}`, side: 'right' },
        to: { elementId: `stage-${i + 1}`, side: 'left' },
        style: 'solid',
        routing: 'elbow',
      })
    }
  })
  return out
}

function matrix(): WhiteboardElement[] {
  const top = 120
  const size = 440
  const left = 80
  const quad = (id: string, x: number, y: number, label: string, color: WhiteboardColor): WhiteboardElement => ({
    type: 'section',
    id,
    x,
    y,
    w: size,
    h: size,
    title: label,
    color,
  })
  return [
    title('Impact vs effort'),
    { type: 'text', id: 'axis-impact', x: 0, y: top + size - 12, text: 'Impact ↑', size: 's' },
    { type: 'text', id: 'axis-effort', x: left + size + GAP / 2 - 40, y: top + 2 * size + GAP + 16, text: 'Effort →', size: 's' },
    quad('quick-wins', left, top, 'Quick wins (high impact, low effort)', 'green'),
    quad('big-bets', left + size + GAP, top, 'Big bets (high impact, high effort)', 'blue'),
    quad('fill-ins', left, top + size + GAP, 'Fill-ins (low impact, low effort)', 'gray'),
    quad('time-sinks', left + size + GAP, top + size + GAP, 'Time sinks (low impact, high effort)', 'red'),
    note('quick-wins-n1', left + PAD, top + HEAD, 'Idea', 'yellow'),
  ]
}

/** Lanes are sections stacked edge to edge, each a team; a step belongs to the lane its centre is in. */
export const LANE_HEIGHT = 200

function swimlanes(): WhiteboardElement[] {
  const top = 96
  const lanes = [
    { id: 'lane-customer', title: 'Customer', color: 'blue' as const },
    { id: 'lane-support', title: 'Support', color: 'purple' as const },
    { id: 'lane-engineering', title: 'Engineering', color: 'green' as const },
  ]
  const laneW = PAD + 4 * 240 + 160 + PAD
  const laneY = (i: number) => top + i * LANE_HEIGHT
  // A step sits below its lane's title band, centred in what is left.
  const step = (id: string, lane: number, col: number, kind: 'pill' | 'rect' | 'diamond', text: string): WhiteboardElement => {
    const h = kind === 'diamond' ? 120 : 80
    const y = laneY(lane) + HEAD + (LANE_HEIGHT - HEAD - h) / 2
    return { type: 'shape', id, kind, x: PAD + col * 240, y, w: 160, h, text, color: lanes[lane].color }
  }
  const link = (
    id: string,
    from: string,
    to: string,
    label?: string,
    dashed = false,
    sides?: { from: Side; to: Side },
  ): WhiteboardElement => ({
    type: 'arrow',
    id,
    from: sides ? { elementId: from, side: sides.from } : { elementId: from },
    to: sides ? { elementId: to, side: sides.to } : { elementId: to },
    ...(label ? { label } : {}),
    style: dashed ? 'dashed' : 'solid',
    routing: 'elbow',
  })
  return [
    title('Swimlanes'),
    ...lanes.map(
      (lane, i): WhiteboardElement => ({ type: 'section', id: lane.id, x: 0, y: laneY(i), w: laneW, h: LANE_HEIGHT, title: lane.title, color: lane.color }),
    ),
    step('report', 0, 0, 'pill', 'Report a problem'),
    step('triage', 1, 1, 'rect', 'Triage'),
    step('is-bug', 1, 2, 'diamond', 'A bug?'),
    step('fix', 2, 3, 'rect', 'Fix and ship'),
    step('reply', 0, 4, 'pill', 'Hears back'),
    link('a-report', 'report', 'triage'),
    link('a-triage', 'triage', 'is-bug'),
    link('a-bug', 'is-bug', 'fix', 'yes'),
    // Two ways into "Hears back": up from the fix into its bottom, across from the decision into its left.
    link('a-fixed', 'fix', 'reply', undefined, false, { from: 'right', to: 'bottom' }),
    link('a-answer', 'is-bug', 'reply', 'no', true, { from: 'top', to: 'left' }),
  ]
}

/** A note section whose new notes take its note colour (round 4's `noteColor`). */
function coloredSection(...args: Parameters<typeof noteSection>): WhiteboardElement[] {
  const [first, ...rest] = noteSection(...args)
  return [first.type === 'section' ? { ...first, noteColor: args[7] } : first, ...rest]
}

function swot(): WhiteboardElement[] {
  const top = 96
  const across = 600
  const down = 288 + 80
  return [
    title('SWOT'),
    ...coloredSection('strengths', 0, top, 'Strengths', 2, 1, ['What we do well'], 'green', 'green'),
    ...coloredSection('weaknesses', across, top, 'Weaknesses', 2, 1, ['Where we fall short'], 'red', 'red'),
    ...coloredSection('opportunities', 0, top + down, 'Opportunities', 2, 1, ['What could help us'], 'blue', 'blue'),
    ...coloredSection('threats', across, top + down, 'Threats', 2, 1, ['What could hurt us'], 'purple', 'purple'),
  ]
}

function mindMap(): WhiteboardElement[] {
  const centre = { x: 440, y: 320, w: 200, h: 104 }
  const branches: Array<{ id: string; x: number; y: number; text: string; color: WhiteboardColor }> = [
    { id: 'branch-1', x: 0, y: 120, text: 'Branch', color: 'green' },
    { id: 'branch-2', x: 920, y: 120, text: 'Branch', color: 'purple' },
    { id: 'branch-3', x: 0, y: 560, text: 'Branch', color: 'yellow' },
    { id: 'branch-4', x: 920, y: 560, text: 'Branch', color: 'red' },
  ]
  return [
    title('Mind map'),
    { type: 'shape', id: 'centre', kind: 'ellipse', ...centre, text: 'Central idea', color: 'blue' },
    ...branches.map(
      (branch): WhiteboardElement => ({ type: 'shape', id: branch.id, kind: 'rounded', x: branch.x, y: branch.y, w: 160, h: 80, text: branch.text, color: branch.color }),
    ),
    ...branches.map(
      (branch): WhiteboardElement => ({ type: 'arrow', id: `a-${branch.id}`, from: { elementId: 'centre' }, to: { elementId: branch.id }, style: 'solid', head: 'none' }),
    ),
  ]
}

function roadmap(): WhiteboardElement[] {
  const top = 96
  const column = PAD + NOTE + PAD + GAP * 2
  return [
    title('Roadmap'),
    ...coloredSection('now', 0, top, 'Now', 1, 2, ['In flight'], 'green', 'green'),
    ...coloredSection('next', column, top, 'Next', 1, 2, ['Coming up'], 'blue', 'blue'),
    ...coloredSection('later', column * 2, top, 'Later', 1, 2, ['Ideas'], 'gray', 'gray'),
    { type: 'arrow', id: 'a-now-next', from: { elementId: 'now', side: 'right' }, to: { elementId: 'next', side: 'left' }, style: 'solid', routing: 'straight' },
    { type: 'arrow', id: 'a-next-later', from: { elementId: 'next', side: 'right' }, to: { elementId: 'later', side: 'left' }, style: 'dashed', routing: 'straight' },
  ]
}

function dotVoting(): WhiteboardElement[] {
  return [
    title('Dot voting'),
    { type: 'shape', id: 'timer', kind: 'rounded', x: 0, y: 96, w: 200, h: 96, text: 'Vote', color: 'gray', timer: { duration: 300 } },
    {
      type: 'text',
      id: 'prompt',
      x: 240,
      y: 112,
      text: 'Start the timer, then vote: + on a note, or stick a sticker on it. Sort by votes when time is up.',
      size: 's',
      w: 520,
    },
    ...coloredSection('ideas', 0, 232, 'Ideas', 3, 1, ['Idea', 'Idea', 'Idea'], 'yellow'),
  ]
}

const BUILDERS: Record<TemplateId, () => WhiteboardElement[]> = {
  brainstorm,
  flowchart,
  kanban,
  retro,
  'user-journey': userJourney,
  matrix,
  swimlanes,
  swot,
  'mind-map': mindMap,
  roadmap,
  'dot-voting': dotVoting,
}

/** A template's elements with its top-left at (0, 0). Ids are readable and unique within it. */
export function templateElements(id: TemplateId): WhiteboardElement[] {
  return BUILDERS[id]()
}

/** A template on its own, as a whole board (for previews). */
export function templateBoard(id: TemplateId): WhiteboardBoard {
  return { version: 1, title: TEMPLATE_INFO[id].title, elements: templateElements(id) }
}

/**
 * Adds template `id` to `board`. On an empty board it keeps its readable ids and the board takes
 * the template's title (when the board is untitled); otherwise it lands `at` (top-left), or
 * 160 below the existing content, with fresh ids (arrows re-pointed). Returns the board and the
 * new element ids.
 */
export function applyTemplate(
  board: WhiteboardBoard,
  id: TemplateId,
  at?: Point,
): { board: WhiteboardBoard; ids: string[] } {
  const elements = templateElements(id)
  if (board.elements.length === 0) {
    const placed: WhiteboardBoard = { ...board, elements }
    const moved = at ? translateElements(placed, new Set(elements.map((e) => e.id)), at.x, at.y) : placed
    const untitled = !board.title.trim() || /^untitled/i.test(board.title.trim())
    return {
      board: untitled ? { ...moved, title: TEMPLATE_INFO[id].title } : moved,
      ids: elements.map((e) => e.id),
    }
  }
  let origin = at
  if (!origin) {
    const bounds = contentBounds(board.elements, geometryContext(board.elements))
    origin = bounds ? { x: Math.round(bounds.x / 8) * 8, y: Math.round((bounds.y + bounds.h + 160) / 8) * 8 } : { x: 0, y: 0 }
  }
  return pasteFragment(board, elements, origin.x, origin.y)
}
