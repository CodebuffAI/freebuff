import { describe, expect, test } from 'bun:test'

import { parseDashboard } from './data'

/**
 * A v1 body as stored before round 2, frozen as JSON text: every stored dashboard must keep
 * parsing as the schema grows (new keys are optional, objects stay strict).
 */
const V1_BODY = `{"version":1,"title":"Signups","subtitle":"All platforms","asOf":"2026-11-14T08:00:00Z","layout":"grid","currency":"USD",
"sources":[{"id":"csv","label":"Signup export","detail":"Exported from the admin page","window":"Nov 2 – Nov 15, 2026 (PT)"}],
"datasets":[{"id":"weekly","sourceId":"csv","title":"By week","columns":[{"key":"week","label":"Week","type":"date"},{"key":"n","label":"Signups","type":"number"},{"key":"rev","label":"Revenue","type":"currency"},{"key":"conv","label":"Conversion","type":"percent"},{"key":"platform","label":"Platform","type":"string"}],
"rows":[{"week":"2026-11-02","n":96,"rev":1200.5,"conv":0.12,"platform":"Web"},{"week":"2026-11-09","n":120,"rev":null,"conv":0.14,"platform":"CLI"}]}],
"blocks":[{"kind":"section","id":"s1","title":"Growth","description":"How we grew"},
{"kind":"kpi","id":"total","label":"Signups this week","datasetId":"weekly","value":{"column":"n","agg":"sum"},"sparkline":"week","delta":{"vs":"previous","format":"percent","label":"vs last week","good":"up"},"format":"integer","sourceId":"csv","note":"people"},
{"kind":"kpi","id":"goal","label":"Goal","value":{"literal":500},"delta":{"vs":400,"format":"absolute"},"format":"number","sourceId":"csv"},
{"kind":"kpi","id":"rate","label":"Rate","datasetId":"weekly","value":{"ratio":{"numerator":{"column":"rev","agg":"sum"},"denominator":{"column":"n","agg":"sum"}}},"format":"currency","sourceId":"csv"},
{"kind":"chart","id":"trend","title":"Signups by week","type":"stacked-bar","datasetId":"weekly","x":"week","series":[{"key":"n","label":"Signups"}],"sourceId":"csv","note":"Weekly","split":"platform","agg":"sum","size":"full"},
{"kind":"chart","id":"pie","title":"By platform","type":"pie","datasetId":"weekly","x":"platform","series":[{"key":"n","label":"Signups"}],"sourceId":"csv","size":"half"},
{"kind":"table","id":"t","title":"Rows","datasetId":"weekly","columns":["week","n"],"sort":{"column":"n","dir":"desc"},"limit":10,"sourceId":"csv"},
{"kind":"text","id":"x","markdown":"**Note** the numbers."}],
"filters":[{"id":"platform","label":"Platform","datasetIds":["weekly"],"column":"platform","type":"select","default":"Web"},{"id":"range","label":"Weeks","datasetIds":["weekly"],"column":"week","type":"date-range"}]}`

const v1 = () => JSON.parse(V1_BODY) as Record<string, any>

const issues = (body: unknown) => {
  const r = parseDashboard(body)
  return r.ok ? [] : r.issues
}

describe('data schema, round 2', () => {
  test('a frozen v1 body still parses', () => {
    expect(issues(v1())).toEqual([])
  })

  test('objects stay strict: an unknown key is still refused', () => {
    const body = v1()
    body.blocks[1].colour = 'red'
    expect(issues(body).length).toBeGreaterThan(0)
  })

  test('the new optional keys parse', () => {
    const body = v1()
    body.blocks[1].span = 2
    body.blocks[1].display = 'trend'
    body.blocks[4] = {
      kind: 'chart',
      id: 'trend',
      title: 'Combo',
      type: 'combo',
      datasetId: 'weekly',
      x: 'week',
      series: [
        { key: 'n', label: 'Signups', as: 'bar' },
        { key: 'conv', label: 'Conversion', as: 'line' },
      ],
      sourceId: 'csv',
      span: 4,
      references: [{ value: 100, label: 'Goal' }],
      annotations: [{ x: '2026-11-09', label: 'Launch' }],
    }
    body.blocks[5].type = 'donut'
    body.blocks[6].heatmap = ['n']
    body.blocks[7].span = 1
    expect(issues(body)).toEqual([])
    for (const type of ['horizontal-bar', 'funnel']) {
      const b = v1()
      b.blocks[5].type = type
      expect(issues(b)).toEqual([])
    }
  })

  test('the new cross-checks', () => {
    const span = v1()
    span.blocks[1].span = 5
    expect(issues(span).length).toBeGreaterThan(0)

    const trend = v1()
    trend.blocks[2].display = 'trend' // a literal: no sparkline
    expect(issues(trend).join()).toContain('needs a sparkline')

    const split = v1()
    split.blocks[4].type = 'donut'
    expect(issues(split).join()).toContain('cannot be split')

    const heat = v1()
    heat.blocks[6].heatmap = ['platform']
    expect(issues(heat).join()).toContain('must be numeric')
  })
})
