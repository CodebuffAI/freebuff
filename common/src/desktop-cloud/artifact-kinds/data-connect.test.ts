import { describe, expect, test } from 'bun:test'

import { parseDashboard, type Dashboard, type DatasetRefresh } from './data'
import {
  APPROVAL_VIA,
  approvalRequest,
  approvalSubject,
  connectedRecipeState,
  integrationRecipeSchema,
  mayRefreshConnected,
  normaliseRecipeApproval,
  pathSegments,
  refreshOnOpenDue,
  type IntegrationRecipe,
} from './data-connect'
import { coerceCell, fillIntegrationCalls, mapIntegrationRows, outlineShape, readPath } from './data-connect-run'
import { normaliseDataWrite, recipeTrustedForRun } from './data-trust'

const NOW = '2026-11-16T18:00:00Z'

const how: IntegrationRecipe = {
  kind: 'integration',
  app: 'linear',
  calls: [{ tool: 'LINEAR_LIST_ISSUES', arguments: { team: '{{team}}', first: 50 } }],
  map: {
    records: 'issues.nodes',
    columns: [
      { key: 'title', path: 'title' },
      { key: 'points', path: 'estimate' },
      { key: 'created', path: 'createdAt' },
    ],
  },
}

function dashboard(refresh?: DatasetRefresh): Dashboard {
  return {
    version: 1,
    title: 'Issues',
    layout: 'grid',
    sources: [{ id: 'lin', label: 'Linear' }],
    datasets: [
      {
        id: 'issues',
        sourceId: 'lin',
        columns: [
          { key: 'title', label: 'Title', type: 'string' },
          { key: 'points', label: 'Points', type: 'number' },
          { key: 'created', label: 'Created', type: 'date' },
        ],
        rows: [{ title: 'Old', points: 1, created: '2026-11-01' }],
        ...(refresh ? { refresh } : {}),
      },
    ],
    filters: [{ id: 'team', label: 'Team', datasetIds: ['issues'], column: 'title', type: 'select', default: 'ENG' }],
    blocks: [{ kind: 'table', id: 't', title: 'Issues', datasetId: 'issues' }],
  }
}

const recipe = (extra: Partial<DatasetRefresh> = {}): DatasetRefresh => ({ recipe: 'Open Linear issues', how, ...extra })
const owner = { owner: true, agent: false, now: NOW, by: 'Owen' }
const ownersAgent = { owner: true, agent: true, now: NOW }
const editor = { owner: false, agent: false, now: NOW, by: 'Maya' }

describe('connected recipe schema', () => {
  test('a connected recipe validates; a blank naming nothing is refused', () => {
    expect(parseDashboard(dashboard(recipe())).ok).toBe(true)
    const bad: IntegrationRecipe = { ...how, calls: [{ tool: 'LINEAR_LIST_ISSUES', arguments: { team: '{{nope}}' } }] }
    const result = parseDashboard(dashboard(recipe({ how: bad })))
    expect(result.ok).toBe(false)
  })

  test('tool slugs, paths and argument shapes are checked', () => {
    for (const broken of [
      { ...how, calls: [{ tool: 'linear_list', arguments: {} }] },
      { ...how, calls: [{ tool: 'COMPOSIO_SEARCH_TOOLS', arguments: {} }] },
      { ...how, map: { ...how.map, records: 'a..b' } },
      { ...how, map: { ...how.map, records: '__proto__.x' } },
      { ...how, map: { ...how.map, columns: [{ key: 'title', path: 'a' }, { key: 'title', path: 'b' }] } },
      { ...how, calls: [{ tool: 'LINEAR_LIST_ISSUES', arguments: { constructor: 1 } }] },
      { ...how, calls: [{ tool: 'LINEAR_LIST_ISSUES', arguments: { q: 'x'.repeat(5000) } }] },
      { ...how, calls: Array.from({ length: 5 }, () => how.calls[0]!) },
    ])
      expect(parseDashboard(dashboard(recipe({ how: broken as IntegrationRecipe }))).ok).toBe(false)
  })

  test('paths', () => {
    expect(pathSegments('')).toEqual([])
    expect(pathSegments('issues.nodes')).toEqual(['issues', 'nodes'])
    expect(pathSegments('a[2].b')).toEqual(['a', 2, 'b'])
    expect(pathSegments('[0].id')).toEqual([0, 'id'])
    for (const bad of ['.a', 'a.', 'a b', 'a[x]', 'a.prototype', 'a[0]b']) expect(pathSegments(bad)).toBeNull()
    expect(readPath({ a: [{ b: 3 }] }, 'a[0].b')).toBe(3)
    // Own properties only.
    expect(readPath({}, 'toString')).toBeUndefined()
  })
})

describe('approval', () => {
  test("only the owner's own write stamps an approval; it covers the recipe exactly", () => {
    const sent = recipe({ approved: approvalRequest(recipe(), NOW) })
    const stamped = normaliseRecipeApproval(undefined, sent, owner, 'Owen')!
    expect(stamped.approved).toEqual({ by: 'Owen', at: NOW, of: approvalSubject(recipe()), via: APPROVAL_VIA })
    expect(connectedRecipeState(stamped)).toBe('approved')
    // The owner's agent cannot approve, even with a perfect stamp: pending.
    expect(connectedRecipeState(normaliseRecipeApproval(undefined, { ...stamped }, ownersAgent, 'Buffy'))).toBe('pending')
    // An editor's forged stamp is dropped too (their refresh change is refused anyway).
    expect(normaliseRecipeApproval(undefined, sent, editor, 'Maya')!.approved).toBeUndefined()
  })

  test('any change after approval leaves it stale; an agent change of the recipe never runs', () => {
    const approved = normaliseRecipeApproval(undefined, recipe({ approved: approvalRequest(recipe(), NOW) }), owner, 'Owen')!
    const writeTool = { ...how, calls: [{ tool: 'GMAIL_SEND_EMAIL', arguments: {} }] }
    const changed = normaliseRecipeApproval(approved, { ...approved, how: writeTool }, ownersAgent, 'Buffy')!
    expect(connectedRecipeState(changed)).toBe('pending')
    // Turning on collaborator refresh is part of what the owner approves.
    expect(connectedRecipeState({ ...approved, collaboratorsCanRefresh: true })).toBe('pending')
    expect(connectedRecipeState({ ...approved, staleAfterHours: 4 })).toBe('approved')
  })

  test('through normaliseDataWrite: agent proposals are pending, the owner approves, recipeTrustedForRun reads it', () => {
    const proposed = normaliseDataWrite(dashboard(), dashboard(recipe({ approved: { by: 'Owen', at: NOW, of: approvalSubject(recipe()) } })), ownersAgent)
    expect(proposed.ok).toBe(true)
    const pending = proposed.ok ? proposed.dashboard : dashboard()
    expect(recipeTrustedForRun(JSON.stringify(pending), 'issues')).toBe(false)
    const next = structuredClone(pending)
    next.datasets[0]!.refresh = { ...next.datasets[0]!.refresh!, approved: approvalRequest(next.datasets[0]!.refresh!, NOW) }
    const approved = normaliseDataWrite(pending, next, owner)
    expect(approved.ok).toBe(true)
    if (!approved.ok) return
    expect(recipeTrustedForRun(JSON.stringify(approved.dashboard), 'issues')).toBe(true)
    expect(recipeTrustedForRun(JSON.stringify(approved.dashboard), 'other')).toBe(false)
    expect(recipeTrustedForRun('not json', 'issues')).toBe(false)
    // An editor cannot approve (any refresh change is the owner's).
    expect(normaliseDataWrite(pending, next, editor).ok).toBe(false)
  })

  test('only the enforced pipeline\'s marked stamp counts; a legacy or forged one never runs and is never laundered', () => {
    const legacy = recipe({ approved: { by: 'Owen', at: NOW, of: approvalSubject(recipe()) } })
    expect(connectedRecipeState(legacy)).toBe('pending')
    expect(recipeTrustedForRun(JSON.stringify(dashboard(legacy)), 'issues')).toBe(false)
    // The owner's ordinary save carrying it back unchanged keeps it as it is: still unmarked, still pending.
    const roundTrip = normaliseRecipeApproval(legacy, structuredClone(legacy), owner, 'Owen')!
    expect(roundTrip.approved).toEqual(legacy.approved)
    expect(connectedRecipeState(roundTrip)).toBe('pending')
    // A forged marked stamp from anyone but the owner's own save is dropped.
    const forged = recipe({ approved: { by: 'Owen', at: NOW, of: approvalSubject(recipe()), via: APPROVAL_VIA } })
    expect(normaliseRecipeApproval(undefined, forged, editor, 'Maya')!.approved).toBeUndefined()
    expect(normaliseRecipeApproval(undefined, forged, ownersAgent, 'Buffy')!.approved).toBeUndefined()
  })

  test('a new artifact (a copy, a template) starts pending; a restore keeps only the stamp already stored', () => {
    const marked = normaliseRecipeApproval(undefined, recipe({ approved: approvalRequest(recipe(), NOW) }), owner, 'Owen')!
    expect(connectedRecipeState(marked)).toBe('approved')
    // A copy by anyone, its creator the owner: nothing it carries is approved.
    expect(normaliseRecipeApproval(undefined, marked, { ...owner, approvals: 'strip' }, 'Owen')!.approved).toBeUndefined()
    // A restore: the stamp stored now survives; an older version's different stamp is dropped.
    expect(normaliseRecipeApproval(marked, marked, { ...owner, approvals: 'keep' }, 'Owen')!.approved).toEqual(marked.approved)
    const older = { ...marked, approved: { ...marked.approved!, at: '2026-10-01T00:00:00Z' } }
    expect(normaliseRecipeApproval(marked, older, { ...owner, approvals: 'keep' }, 'Owen')!.approved).toBeUndefined()
  })

  test('the schedule is part of what the owner approves', () => {
    const marked = normaliseRecipeApproval(undefined, recipe({ approved: approvalRequest(recipe(), NOW) }), owner, 'Owen')!
    expect(connectedRecipeState({ ...marked, schedule: { every: 'day', at: '06:00' } })).toBe('pending')
    const scheduled = recipe({ schedule: { every: 'day', at: '06:00' } })
    const approvedScheduled = normaliseRecipeApproval(undefined, { ...scheduled, approved: approvalRequest(scheduled, NOW) }, owner, 'Owen')!
    expect(connectedRecipeState(approvedScheduled)).toBe('approved')
    expect(connectedRecipeState({ ...approvedScheduled, schedule: { every: 'hour' } })).toBe('pending')
  })

  test("a call's account is a handle, never a label or email (the recipe is shown to every reader)", () => {
    expect(integrationRecipeSchema.safeParse({ ...how, calls: [{ ...how.calls[0]!, account: 'linear_red' }] }).success).toBe(true)
    expect(integrationRecipeSchema.safeParse({ ...how, calls: [{ ...how.calls[0]!, account: 'owen@example.com' }] }).success).toBe(false)
    expect(integrationRecipeSchema.safeParse({ ...how, calls: [{ ...how.calls[0]!, account: 'Owen Personal' }] }).success).toBe(false)
  })

  test('who may refresh, and refresh on open once per window', () => {
    expect(mayRefreshConnected('owner', recipe())).toBe(true)
    expect(mayRefreshConnected('editor', recipe())).toBe(false)
    expect(mayRefreshConnected('editor', recipe({ collaboratorsCanRefresh: true }))).toBe(true)
    expect(mayRefreshConnected('commenter', recipe({ collaboratorsCanRefresh: true }))).toBe(false)
    const on = recipe({ onOpen: true, staleAfterHours: 2 })
    const refresh = { ...on, approved: { by: 'Owen', at: NOW, of: approvalSubject(on), via: APPROVAL_VIA } }
    const now = Date.parse(NOW)
    expect(refreshOnOpenDue({ refresh }, now)).toBe(true)
    expect(refreshOnOpenDue({ refresh, provenance: { fetchedAt: '2026-11-16T17:00:00Z' } }, now)).toBe(false)
    expect(refreshOnOpenDue({ refresh, provenance: { fetchedAt: '2026-11-16T15:00:00Z' } }, now)).toBe(true)
    // A failure just now counts: opening never retries a broken source in a loop.
    expect(refreshOnOpenDue({ refresh, provenance: { fetchedAt: '2026-11-16T15:00:00Z' }, lastRun: { at: '2026-11-16T17:59:00Z' } }, now)).toBe(false)
    expect(refreshOnOpenDue({ refresh: on }, now)).toBe(false)
  })
})

describe('blanks', () => {
  test("filled from the reader's values or defaults; unsafe values refuse", () => {
    const d = dashboard(recipe())
    expect(fillIntegrationCalls(d, how)).toEqual({ calls: [{ tool: 'LINEAR_LIST_ISSUES', arguments: { team: 'ENG', first: 50 } }] })
    expect(fillIntegrationCalls(d, how, { filters: { team: { kind: 'select', value: 'Design team' } } })).toEqual({
      calls: [{ tool: 'LINEAR_LIST_ISSUES', arguments: { team: 'Design team', first: 50 } }],
    })
    for (const value of ['a"; drop', '-rf', 'x'.repeat(200), 'a\nb'])
      expect(fillIntegrationCalls(d, how, { filters: { team: { kind: 'select', value } } })).toEqual({ problem: 'blank_unsafe' })
  })

  test("a string that is exactly a parameter's blank becomes its number", () => {
    const d = { ...dashboard(), params: [{ id: 'n', label: 'N', default: 20 }] }
    const withParam: IntegrationRecipe = { ...how, calls: [{ tool: 'LINEAR_LIST_ISSUES', arguments: { first: '{{n}}', note: 'top {{n}}' } }] }
    expect(fillIntegrationCalls(d, withParam, { params: { n: 5 } })).toEqual({
      calls: [{ tool: 'LINEAR_LIST_ISSUES', arguments: { first: 5, note: 'top 5' } }],
    })
  })
})

describe('mapping', () => {
  const columns = dashboard().datasets[0]!.columns
  const data = {
    issues: {
      nodes: [
        { title: 'Fix login', estimate: '3', createdAt: '2026-11-02T10:00:00Z', extra: { secret: 'x' } },
        { title: { nested: true }, estimate: 'n/a', createdAt: 1762041600 },
      ],
    },
  }

  test('paths and coercion to the column types', () => {
    const result = mapIntegrationRows([{ tool: 'LINEAR_LIST_ISSUES', data }], how.map, columns)
    expect(result).toEqual({
      ok: true,
      rows: [
        { title: 'Fix login', points: 3, created: '2026-11-02' },
        { title: null, points: null, created: '2025-11-02' },
      ],
      dropped: 0,
      blanked: 2,
    })
  })

  test('caps rows; special paths; several calls concatenate', () => {
    const map = { records: 'issues.nodes', columns: [{ key: 'title', path: '$account' }, { key: 'points', path: '$index' }], limit: 3 }
    const result = mapIntegrationRows(
      [
        { tool: 'T', account: 'a', data },
        { tool: 'T', account: 'b', data },
      ],
      map,
      columns,
    )
    expect(result).toEqual({
      ok: true,
      rows: [
        { title: 'a', points: 0 },
        { title: 'a', points: 1 },
        { title: 'b', points: 2 },
      ],
      dropped: 1,
      blanked: 0,
    })
  })

  test('bad payloads fail the whole run', () => {
    expect(mapIntegrationRows([{ tool: 'T', error: 'boom' }], how.map, columns)).toEqual({ ok: false, problem: 'call_failed' })
    expect(mapIntegrationRows([{ tool: 'T', data: { truncated: true, preview: '{"issues"' } }], how.map, columns)).toEqual({ ok: false, problem: 'too_large' })
    expect(mapIntegrationRows([{ tool: 'T', data: { issues: { nodes: 'no' } } }], how.map, columns)).toEqual({ ok: false, problem: 'no_list' })
    expect(mapIntegrationRows([{ tool: 'T', data: null }], how.map, columns)).toEqual({ ok: false, problem: 'no_list' })
    expect(mapIntegrationRows([{ tool: 'T', data }], { records: 'issues.nodes', columns: [{ key: 'ghost', path: 'a' }] }, columns)).toEqual({
      ok: false,
      problem: 'unknown_column',
    })
    // One good call and one failed: nothing is written.
    expect(mapIntegrationRows([{ tool: 'T', data }, { tool: 'T', error: 'x' }], how.map, columns).ok).toBe(false)
  })

  test('cells', () => {
    expect(coerceCell('$1,234.50', 'currency')).toBe(1234.5)
    expect(coerceCell(1999, 'currency', 0.01)).toBeCloseTo(19.99)
    expect(coerceCell('12%', 'percent')).toBe(12)
    expect(coerceCell('2026-02-30', 'date')).toBeUndefined()
    expect(coerceCell(['a', 'b'], 'string')).toBe('a, b')
    expect(coerceCell(true, 'number')).toBeUndefined()
    expect(coerceCell('x'.repeat(2000), 'string')).toHaveLength(1000)
  })

  test("the owner's outline lists the lists and a record's fields", () => {
    const outline = outlineShape(data)
    expect(outline.lists[0]).toEqual({ path: 'issues.nodes', length: 2 })
    expect(outline.fields.map((f) => f.path)).toEqual(['title', 'estimate', 'createdAt', 'extra.secret'])
  })
})
