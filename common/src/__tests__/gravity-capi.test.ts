import { describe, expect, test } from 'bun:test'

import {
  buildGravityFirstMessagePayload,
  gravityFirstMessageEventId,
  isFreebuffGravitySurface,
  sanitizeGravityCapiData,
  sendGravityFirstMessageConversion,
} from '../gravity-capi'

describe('Gravity first-message CAPI', () => {
  test('sanitizes browser attribution in one shared boundary', () => {
    expect(
      sanitizeGravityCapiData(
        {
          user_data: {
            click_id: 'click-1',
            visitor_id: 123,
            session_id: 'session-1',
          },
          event_source_url: 'https://stale.example',
          client_context: { timezone: 'America/Los_Angeles' },
        },
        'https://freebuff.com/chat',
      ),
    ).toEqual({
      user_data: {
        click_id: 'click-1',
        visitor_id: undefined,
        session_id: 'session-1',
        client_user_agent: undefined,
      },
      event_source_url: 'https://freebuff.com/chat',
      client_context: { timezone: 'America/Los_Angeles' },
    })
    expect(isFreebuffGravitySurface('desktop')).toBe(true)
    expect(isFreebuffGravitySurface('preexisting')).toBe(false)
  })

  test('drops oversized client context before forwarding it to Gravity', () => {
    expect(
      sanitizeGravityCapiData({
        user_data: { click_id: 'click-123' },
        client_context: { padding: 'x'.repeat(32_768) },
      }),
    ).toEqual({
      user_data: {
        click_id: 'click-123',
        visitor_id: undefined,
        session_id: undefined,
        client_user_agent: undefined,
      },
      event_source_url: undefined,
      client_context: undefined,
    })
  })

  test('builds a stable, attributed payload with authoritative identity', () => {
    expect(
      buildGravityFirstMessagePayload({
        userId: 'user-123',
        email: 'person@example.com',
        surface: 'cloud',
        eventTime: 123,
        gravity: {
          event_source_url: 'https://freebuff.com/cloud/project/example',
          user_data: {
            click_id: 'click-1',
            visitor_id: 'visitor-1',
            session_id: 'session-1',
            client_user_agent: 'pixel-agent',
          },
          client_context: { timezone: 'America/Los_Angeles' },
        },
      }),
    ).toEqual({
      data: [
        {
          event_name: 'FirstMessage',
          event_time: 123,
          event_id: 'freebuff-first-message-user-123',
          action_source: 'website',
          event_source_url: 'https://freebuff.com/cloud/project/example',
          user_data: {
            click_id: 'click-1',
            visitor_id: 'visitor-1',
            session_id: 'session-1',
            client_user_agent: 'pixel-agent',
            em: ['person@example.com'],
            external_id: ['user-123'],
          },
          client_context: { timezone: 'America/Los_Angeles' },
          custom_data: {
            content_name: 'Freebuff first message',
            content_category: 'cloud',
          },
        },
      ],
    })
  })

  test('uses the same event id across surfaces for Gravity deduplication', () => {
    expect(gravityFirstMessageEventId('user-123')).toBe(
      'freebuff-first-message-user-123',
    )
  })

  test('accepts a duplicate response as delivered', async () => {
    let requestBody: unknown
    const result = await sendGravityFirstMessageConversion({
      apiKey: 'secret',
      userId: 'user-123',
      surface: 'desktop',
      fetchImpl: (async (_input, init) => {
        requestBody = JSON.parse(String(init?.body))
        return new Response(
          JSON.stringify({
            results: [
              {
                event_id: 'freebuff-first-message-user-123',
                status: 'duplicate',
              },
            ],
          }),
          { status: 200 },
        )
      }) as typeof fetch,
    })

    expect(result.status).toBe('duplicate')
    expect(requestBody).toMatchObject({
      data: [
        {
          event_name: 'FirstMessage',
          custom_data: { content_category: 'desktop' },
        },
      ],
    })
  })

  test('treats an accepted response as delivered', async () => {
    // The live CAPI's answer for a new FirstMessage.
    let calls = 0
    const result = await sendGravityFirstMessageConversion({
      apiKey: 'secret',
      userId: 'user-123',
      surface: 'cli',
      fetchImpl: (async () => {
        calls++
        return new Response(
          JSON.stringify({
            results: [
              {
                event_id: 'freebuff-first-message-user-123',
                status: 'accepted',
              },
            ],
          }),
          { status: 200 },
        )
      }) as unknown as typeof fetch,
    })
    expect(result.status).toBe('accepted')
    expect(calls).toBe(1)
  })

  test('throws on an event-level error so the claim remains retryable', async () => {
    await expect(
      sendGravityFirstMessageConversion({
        apiKey: 'secret',
        userId: 'user-123',
        surface: 'cli',
        fetchImpl: (async () =>
          new Response(JSON.stringify({ results: [{ status: 'error' }] }), {
            status: 200,
          })) as unknown as typeof fetch,
      }),
    ).rejects.toThrow('status error')
  })
})
