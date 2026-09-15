import { describe, expect, test } from 'bun:test'

import {
  AGENTIC_BILLABLE_FUNNEL_EVENT_TYPES,
  AGENTIC_FUNNEL_EVENT_SOURCES,
  AGENTIC_FUNNEL_EVENT_TYPES,
  AGENTIC_POSTBACK_EVENT_TYPES,
  agenticAcceptEventId,
  isBillableAgenticFunnelEvent,
} from '../agentic-ad-events'

/**
 * The funnel vocabulary is a CLOSED SET with two consumers that cannot see
 * each other: the Postgres enum `ad_agentic_funnel_event_type` (mirrored from
 * this array in `packages/internal/src/db/schema.ts`) and Convex, which may
 * never import `@codebuff/internal`. Nothing at runtime notices a member
 * added here and not migrated, or a member that quietly became billable — the
 * first shows up as a failed insert in production, the second as a charge.
 * So the membership and the billable set are asserted as data.
 */
describe('agentic funnel vocabulary', () => {
  test('carries every stage the funnel records, in append-only order', () => {
    expect(AGENTIC_FUNNEL_EVENT_TYPES).toEqual([
      'proposal_offered',
      'accepted',
      'pr_made',
      'landed',
      'merged',
      'mcp_installed',
      'api_key_issued',
      'account_created',
      'tool_used',
      'dismissed',
      'run_failed',
      'run_committed',
      'proposal_displayed',
    ])
  })

  test('the three COD-279 stages are members', () => {
    for (const eventType of ['dismissed', 'run_failed', 'run_committed']) {
      expect(AGENTIC_FUNNEL_EVENT_TYPES).toContain(eventType)
    }
  })

  test('members are unique — a duplicate is an un-migratable enum', () => {
    expect(new Set(AGENTIC_FUNNEL_EVENT_TYPES).size).toBe(
      AGENTIC_FUNNEL_EVENT_TYPES.length,
    )
  })

  /**
   * The whole point of the vocabulary. `ALTER TYPE ... ADD VALUE` appends, so
   * the Postgres enum's ordinals are this array's indices — and a member
   * inserted in the middle would silently mean a DIFFERENT stage on every row
   * already written. The prefix is pinned so that mistake fails here rather
   * than in a report six weeks later.
   */
  test('the pre-existing members keep their positions', () => {
    expect(AGENTIC_FUNNEL_EVENT_TYPES.slice(0, 9)).toEqual([
      'proposal_offered',
      'accepted',
      'pr_made',
      'landed',
      'merged',
      'mcp_installed',
      'api_key_issued',
      'account_created',
      'tool_used',
    ])
  })
})

describe('the billing rule', () => {
  test('exactly one stage may ever bill, and it is Accept', () => {
    expect(AGENTIC_BILLABLE_FUNNEL_EVENT_TYPES).toEqual(['accepted'])
  })

  test('every other stage is telemetry, new members included', () => {
    for (const eventType of AGENTIC_FUNNEL_EVENT_TYPES) {
      expect(isBillableAgenticFunnelEvent(eventType)).toBe(
        eventType === 'accepted',
      )
    }
  })

  test('the new stages are not billable', () => {
    expect(isBillableAgenticFunnelEvent('dismissed')).toBe(false)
    expect(isBillableAgenticFunnelEvent('run_failed')).toBe(false)
    expect(isBillableAgenticFunnelEvent('run_committed')).toBe(false)
    expect(isBillableAgenticFunnelEvent('proposal_displayed')).toBe(false)
  })
})

describe('what an advertiser may report', () => {
  /**
   * The postback set does NOT grow with the funnel. `dismissed`,
   * `run_failed` and `run_committed` are facts about our own surface and our
   * own run — an advertiser asserting them would be self-reported telemetry
   * about something we can read directly.
   */
  test('stays the two advertiser-side stages', () => {
    expect(AGENTIC_POSTBACK_EVENT_TYPES).toEqual([
      'account_created',
      'tool_used',
    ])
  })

  test('every postback type is a funnel type', () => {
    for (const eventType of AGENTIC_POSTBACK_EVENT_TYPES) {
      expect(AGENTIC_FUNNEL_EVENT_TYPES).toContain(eventType)
    }
  })

  test('no postback type is billable', () => {
    for (const eventType of AGENTIC_POSTBACK_EVENT_TYPES) {
      expect(isBillableAgenticFunnelEvent(eventType)).toBe(false)
    }
  })
})

describe('sources and idempotency keys', () => {
  test('an event is observed by exactly one of two parties', () => {
    expect(AGENTIC_FUNNEL_EVENT_SOURCES).toEqual([
      'internal',
      'advertiser_postback',
    ])
  })

  test('the accept key is derived from the proposal and prefixed', () => {
    expect(agenticAcceptEventId('abc123')).toBe('accept_abc123')
    // Prefixed so a future stage keyed on the same proposal id cannot collide
    // with the one row that corresponds to money having moved.
    expect(agenticAcceptEventId('abc123')).not.toBe('abc123')
  })
})
