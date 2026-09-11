import { describe, expect, test } from 'bun:test'

import { AnalyticsEvent } from '../../constants/analytics-events'
import { buildLogRows } from '../log-ingest'

const base = {
  source: 'cli' as const,
  service: 'web',
  env: 'test',
  userId: 'authenticated-user',
  now: new Date('2026-08-25T00:00:00.000Z'),
}

const acknowledgement = {
  surface: 'waiting_room',
  placement_id: 'waiting-room-1',
  outcome: 'accepted',
  attempt: 1,
  duration_ms: 250,
  client_family: 'cli',
}

const showcasePresentation = {
  gravity_showcase_version: 'gravity-showcase-v1',
  gravity_showcase_config_id: 'gsc_abc123',
  gravity_showcase_arm: 'control',
  gravity_showcase_attempt_id: '5b32fd40-758b-4d10-8ce5-9fd098299453',
  gravity_showcase_opportunity_id: 'opp_0123456789abcdef0123456789abcdef',
  gravity_showcase_variant: 'inline_fallback',
  placement_id: 'Desktop-Below-Chat',
  surface: 'cli_chat',
  format: 'inline',
  client_event_id: '6b32fd40-758b-4d10-8ce5-9fd098299453',
  client_family: 'desktop',
}

describe('buildLogRows', () => {
  test('bounds authenticated Showcase presentation and clears free-form identity', () => {
    const [row] = buildLogRows({
      ...base,
      records: [
        {
          level: 'info',
          event: AnalyticsEvent.ADS_SHOWCASE_PRESENTED,
          timestamp: '2099-01-01T00:00:00.000Z',
          message: 'private message',
          client_session_id: 'private-session',
          client_request_id: 'private-request',
          fingerprint_id: 'private-fingerprint',
          data: { ...showcasePresentation, token: 'private-token' },
        },
      ],
    })
    expect(row).toMatchObject({
      timestamp: base.now,
      event: AnalyticsEvent.ADS_SHOWCASE_PRESENTED,
      message: null,
      user_id: base.userId,
      client_session_id: null,
      client_request_id: null,
      fingerprint_id: null,
      data: showcasePresentation,
    })
    expect(JSON.stringify(row)).not.toContain('private')
  })

  test('drops anonymous and malformed Showcase presentation rows', () => {
    const record = {
      level: 'info' as const,
      event: AnalyticsEvent.ADS_SHOWCASE_PRESENTED,
      data: showcasePresentation,
    }
    expect(buildLogRows({ ...base, userId: null, records: [record] })).toEqual(
      [],
    )
    expect(
      buildLogRows({
        ...base,
        records: [
          { ...record, data: { ...showcasePresentation, format: 'showcase' } },
        ],
      }),
    ).toEqual([])
    expect(
      buildLogRows({
        ...base,
        userId: null,
        records: [
          {
            level: 'info',
            event: 'ordinary.event',
            data: {
              ...showcasePresentation,
              axiomEvent: AnalyticsEvent.ADS_SHOWCASE_PRESENTED,
              token: 'private-token',
            },
          },
        ],
      }),
    ).toEqual([])
  })
  test('accepts only the exact view acknowledgement payload, clears every identity field, and uses server receive time', () => {
    const [row] = buildLogRows({
      ...base,
      records: [
        {
          level: 'info',
          event: AnalyticsEvent.ADS_FIRST_PARTY_VIEW_ACK,
          timestamp: '2099-01-01T00:00:00.000Z',
          message: 'private message must not persist',
          client_session_id: 'private-session',
          client_request_id: 'private-request',
          fingerprint_id: 'private-fingerprint',
          data: acknowledgement,
        },
      ],
    })
    expect(row).toMatchObject({
      event: AnalyticsEvent.ADS_FIRST_PARTY_VIEW_ACK,
      message: null,
      user_id: null,
      client_session_id: null,
      client_request_id: null,
      fingerprint_id: null,
      timestamp: base.now,
      data: acknowledgement,
    })
  })

  test('drops malformed/private acknowledgement events instead of retaining a count', () => {
    const rows = buildLogRows({
      ...base,
      records: [
        {
          level: 'info',
          event: AnalyticsEvent.ADS_FIRST_PARTY_VIEW_ACK,
          data: { ...acknowledgement, token: 'private-token' },
        },
        {
          level: 'info',
          event: AnalyticsEvent.ADS_FIRST_PARTY_VIEW_ACK,
          data: { ...acknowledgement, error: { raw: 'private' } },
        },
        {
          level: 'info',
          event: AnalyticsEvent.ADS_FIRST_PARTY_VIEW_ACK,
          data: { ...acknowledgement, placement_id: 'unknown' },
        },
      ],
    })
    expect(rows).toEqual([])
  })

  test('leaves ordinary client records unchanged', () => {
    const [row] = buildLogRows({
      ...base,
      records: [
        {
          level: 'info',
          event: 'ordinary.event',
          message: 'ordinary message',
          client_session_id: 'session',
          data: { private: 'ordinary records retain normal behavior' },
        },
      ],
    })
    expect(row).toMatchObject({
      event: 'ordinary.event',
      message: 'ordinary message',
      user_id: 'authenticated-user',
      client_session_id: 'session',
      data: { private: 'ordinary records retain normal behavior' },
    })
  })
})
