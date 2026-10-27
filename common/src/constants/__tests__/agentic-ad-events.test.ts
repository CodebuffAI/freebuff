import { describe, expect, test } from 'bun:test'

import {
  AGENTIC_BILLABLE_FUNNEL_EVENT_TYPES,
  AGENTIC_FUNNEL_EVENT_SOURCES,
  AGENTIC_FUNNEL_EVENT_TYPES,
  AGENTIC_POSTBACK_EVENT_TYPES,
  AGENTIC_FUNNEL_OCCURRENCE_ID_PATTERN,
  CLIENT_REPORTED_AGENTIC_FUNNEL_EVENT_TYPES,
  REPEATING_AGENTIC_FUNNEL_EVENT_TYPES,
  agenticProposalFunnelEventId,
  isClientReportedAgenticFunnelEvent,
  isRepeatingAgenticFunnelEvent,
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
      // Appended, never inserted: the enum is append-only in Postgres, so
      // position here is the migration's order and not a preference.
      'run_delivered',
      'offer_received',
      'plan_viewed',
      'accept_clicked',
      'accept_refused',
      'run_started',
      'needs_you',
      'undo',
      'signup_opened',
    ])
  })

  test('the first fourteen members keep their positions', () => {
    // Every member up to `run_delivered` is already a Postgres enum value
    // with rows behind it; the revamp's stages may only follow them.
    expect(AGENTIC_FUNNEL_EVENT_TYPES.slice(0, 14)).toEqual([
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
      'run_delivered',
    ])
  })

  test('no consent_* stage: the confirms were dropped (decisions 3 and 8)', () => {
    expect(
      AGENTIC_FUNNEL_EVENT_TYPES.filter((t) => t.startsWith('consent_')),
    ).toEqual([])
  })

  test('the repeating stages are members, and Accept is not one', () => {
    for (const eventType of REPEATING_AGENTIC_FUNNEL_EVENT_TYPES) {
      expect(AGENTIC_FUNNEL_EVENT_TYPES).toContain(eventType)
    }
    expect(REPEATING_AGENTIC_FUNNEL_EVENT_TYPES).toEqual([
      'accept_refused',
      'needs_you',
      'tool_used',
    ])
    expect(
      REPEATING_AGENTIC_FUNNEL_EVENT_TYPES as readonly string[],
    ).not.toContain('accepted')
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

  test('pressing Accept is not the charge: accept_clicked never bills', () => {
    expect(isBillableAgenticFunnelEvent('accept_clicked')).toBe(false)
    expect(isBillableAgenticFunnelEvent('accept_refused')).toBe(false)
  })

  test('the postback set does not take any revamp stage', () => {
    for (const eventType of [
      'offer_received',
      'plan_viewed',
      'accept_clicked',
      'accept_refused',
      'run_started',
      'needs_you',
      'undo',
    ]) {
      expect(AGENTIC_POSTBACK_EVENT_TYPES as readonly string[]).not.toContain(
        eventType,
      )
    }
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

describe('what a client may report', () => {
  test('only the stages the client alone sees, and never a charge', () => {
    expect(CLIENT_REPORTED_AGENTIC_FUNNEL_EVENT_TYPES).toEqual([
      'plan_viewed',
      'accept_clicked',
      'needs_you',
      'undo',
      'signup_opened',
    ])
    for (const eventType of CLIENT_REPORTED_AGENTIC_FUNNEL_EVENT_TYPES) {
      expect(AGENTIC_FUNNEL_EVENT_TYPES).toContain(eventType)
      expect(isBillableAgenticFunnelEvent(eventType)).toBe(false)
      expect(AGENTIC_POSTBACK_EVENT_TYPES as readonly string[]).not.toContain(
        eventType,
      )
    }
  })

  test('the guard admits exactly the client set', () => {
    for (const eventType of AGENTIC_FUNNEL_EVENT_TYPES) {
      expect(isClientReportedAgenticFunnelEvent(eventType)).toBe(
        (
          CLIENT_REPORTED_AGENTIC_FUNNEL_EVENT_TYPES as readonly string[]
        ).includes(eventType),
      )
    }
    for (const value of [undefined, null, 1, '', 'PLAN_VIEWED', {}]) {
      expect(isClientReportedAgenticFunnelEvent(value)).toBe(false)
    }
  })

  test('repeating membership', () => {
    expect(isRepeatingAgenticFunnelEvent('needs_you')).toBe(true)
    expect(isRepeatingAgenticFunnelEvent('accept_refused')).toBe(true)
    expect(isRepeatingAgenticFunnelEvent('plan_viewed')).toBe(false)
    expect(isRepeatingAgenticFunnelEvent('accepted')).toBe(false)
  })

  test('event ids: once per proposal, or once per occurrence', () => {
    expect(agenticProposalFunnelEventId('plan_viewed', 'p1')).toBe(
      'plan_viewed:p1',
    )
    expect(agenticProposalFunnelEventId('needs_you', 'p1', 'w2')).toBe(
      'needs_you:p1:w2',
    )
    // Never the accept key: money's row cannot collide with telemetry.
    expect(agenticProposalFunnelEventId('accept_clicked', 'p1')).not.toBe(
      agenticAcceptEventId('p1'),
    )
  })

  test('occurrence ids are short and plain', () => {
    expect(AGENTIC_FUNNEL_OCCURRENCE_ID_PATTERN.test('wait-1_a')).toBe(true)
    for (const bad of ['', 'a b', 'a:b', 'x'.repeat(65), 'é']) {
      expect(AGENTIC_FUNNEL_OCCURRENCE_ID_PATTERN.test(bad)).toBe(false)
    }
  })
})
