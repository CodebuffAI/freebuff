import { describe, expect, test } from 'bun:test'

import {
  ADS_FETCH_COMPLETED_EVENT,
  ADS_FIRST_PARTY_DECISION_EVENT,
  ADS_FIRST_PARTY_CLICK_RECORDED_EVENT,
  ADS_FIRST_PARTY_IMPRESSION_RECORDED_EVENT,
  ADS_FIRST_PARTY_SETTLEMENT_EVENT,
  ADS_FIRST_PARTY_VIEW_ACK_EVENT,
  ADS_EXTERNAL_CONVERSION_CLICK_ID_SHAPES,
  ADS_EXTERNAL_CONVERSION_POSTBACK_EVENT,
  ADS_CAMPAIGN_INGRESS_EVIDENCE_EVENT,
  ADS_ADVERTISER_REPORTING_READ_EVENT,
  ADS_MCP_TOOL_CALL_EVENT,
  ADS_IMPREZIA_FETCH_COMPLETED_EVENT,
  CONTEXT_PRUNING_COMPLETED_EVENT,
  getAxiomOnlyLogEvent,
  STREAM_RECOVERY_EVENT,
  ADS_CLIENT_EVENT_HYGIENE_FIELDS,
  ADS_FIRST_PARTY_TRACKING_FIELD_NAMES,
  FIRST_PARTY_VIEW_ACK_FIELD_NAMES,
} from '../axiom-only-log'

describe('getAxiomOnlyLogEvent', () => {
  test('keeps a content-free MCP census and drops arguments, results and secrets', () => {
    expect(getAxiomOnlyLogEvent({
      axiomEvent: ADS_MCP_TOOL_CALL_EVENT,
      advertiser_id: 'advertiser-a', key_id: 'key-a', tool: 'get_account',
      outcome: 'ok', duration_ms: 12,
      arguments: { campaign: 'private-input' }, result: { profile: 'private-output' },
      authorization: 'Bearer must-not-leak', error: { message: 'private' },
    })).toEqual({ event: ADS_MCP_TOOL_CALL_EVENT, data: {
      advertiser_id: 'advertiser-a', key_id: 'key-a', tool: 'get_account', outcome: 'ok', duration_ms: 12,
    } })
  })
  test('keeps only the advertiser reporting audit contract', () => {
    expect(
      getAxiomOnlyLogEvent({
        axiomEvent: ADS_ADVERTISER_REPORTING_READ_EVENT,
        advertiser_id: 'advertiser-a',
        key_id: 'key-a',
        endpoint: 'delivery',
        range_days: 30,
        rows: 12,
        duration_ms: 42,
        outcome: 'ok',
        authorization: 'Bearer must-not-leak',
      }),
    ).toEqual({
      event: ADS_ADVERTISER_REPORTING_READ_EVENT,
      data: {
        advertiser_id: 'advertiser-a',
        key_id: 'key-a',
        endpoint: 'delivery',
        range_days: 30,
        rows: 12,
        duration_ms: 42,
        outcome: 'ok',
      },
    })
  })

  test('sanitizes context-pruning metadata', () => {
    expect(
      getAxiomOnlyLogEvent({
        axiomEvent: CONTEXT_PRUNING_COMPLETED_EVENT,
        trigger_reason: 'context_limit',
        client_session_id: 'turn-123',
        dropped_user_entry_count: 2,
        live_user_prompt_text_preserved: true,
        prompt: 'must not leave the client',
        nested: { secret: true },
        context_token_count: Number.POSITIVE_INFINITY,
      }),
    ).toEqual({
      event: CONTEXT_PRUNING_COMPLETED_EVENT,
      data: {
        trigger_reason: 'context_limit',
        client_session_id: 'turn-123',
        dropped_user_entry_count: 2,
        live_user_prompt_text_preserved: true,
      },
    })
  })

  test('does not treat arbitrary events as Axiom-only', () => {
    expect(
      getAxiomOnlyLogEvent({
        axiomEvent: 'untrusted.event',
        prompt: 'secret',
      }),
    ).toBeNull()
  })

  test('does not treat an Object.prototype property name as a registered event', () => {
    // The event name is caller-supplied (any logger.*(data, msg) call sets
    // `data.axiomEvent`). Guards against ever matching it with a lookup keyed
    // on that name (e.g. a plain-object registry), where 'constructor' would
    // resolve through the prototype chain and get treated as registered —
    // shipping `{}` in place of the log's real payload. Must be rejected like
    // any other unknown event, via both the data-field and event-param path.
    for (const poisonEvent of [
      'constructor',
      'toString',
      'hasOwnProperty',
      'valueOf',
      '__proto__',
    ]) {
      expect(
        getAxiomOnlyLogEvent({
          axiomEvent: poisonEvent,
          prompt: 'must not be silently dropped',
        }),
      ).toBeNull()
      expect(
        getAxiomOnlyLogEvent(
          { prompt: 'must not be silently dropped' },
          poisonEvent,
        ),
      ).toBeNull()
    }
  })

  test('sanitizes the client wire format identified by its top-level event', () => {
    expect(
      getAxiomOnlyLogEvent(
        {
          dropped_user_entry_count: 2,
          prompt: 'must not reach Axiom',
        },
        CONTEXT_PRUNING_COMPLETED_EVENT,
      ),
    ).toEqual({
      event: CONTEXT_PRUNING_COMPLETED_EVENT,
      data: { dropped_user_entry_count: 2 },
    })
  })

  test('accepts an allowlisted top-level event with empty data', () => {
    expect(getAxiomOnlyLogEvent(null, CONTEXT_PRUNING_COMPLETED_EVENT)).toEqual(
      {
        event: CONTEXT_PRUNING_COMPLETED_EVENT,
        data: {},
      },
    )
  })

  test('sanitizes stream-recovery metadata', () => {
    expect(
      getAxiomOnlyLogEvent({
        axiomEvent: STREAM_RECOVERY_EVENT,
        metric: 'stream_recovery_detected',
        source: 'stream-interrupted',
        model: 'openrouter/anthropic/claude-sonnet-4.5',
        agentId: 'base2',
        runId: 'run-123',
        userInputId: 'input-456',
        finishReason: 'unknown',
        hasYieldedContent: true,
        consecutive: 2,
        // Not in the allowlist: must not leak through.
        userId: 'user-789',
        message: 'must not leave the client',
        messageHistory: [{ role: 'user', content: 'secret' }],
      }),
    ).toEqual({
      event: STREAM_RECOVERY_EVENT,
      data: {
        metric: 'stream_recovery_detected',
        source: 'stream-interrupted',
        model: 'openrouter/anthropic/claude-sonnet-4.5',
        agentId: 'base2',
        runId: 'run-123',
        userInputId: 'input-456',
        finishReason: 'unknown',
        hasYieldedContent: true,
        consecutive: 2,
      },
    })
  })

  test('drops a stream-recovery field with the wrong value type', () => {
    // consecutive must be a number; a string value for it (or any other
    // type mismatch) is dropped rather than coerced.
    expect(
      getAxiomOnlyLogEvent({
        axiomEvent: STREAM_RECOVERY_EVENT,
        metric: 'stream_recovery_rescued',
        consecutive: '2',
      }),
    ).toEqual({
      event: STREAM_RECOVERY_EVENT,
      data: { metric: 'stream_recovery_rescued' },
    })
  })

  test('preserves bounded scalar ad-routing metadata and drops identifiers', () => {
    expect(
      getAxiomOnlyLogEvent({
        axiomEvent: ADS_FETCH_COMPLETED_EVENT,
        outcome: 'fill',
        opportunity_id: 'opp_11111111-2222-3333-4444-555555555555',
        policy_version: 'a1b2c3d4e5f6',
        policy_commit: 'deadbeefcafe',
        sample_rate: 1,
        first_party_arm_bucket: 4_242,
        eligible_campaign_count: 2,
        excluded_campaign_count: 3,
        eligible_campaign_labels: 'coderabbit,pilot-b',
        exclusion_reasons: 'daily_cap_spent:1,tag_mismatch:2',
        hour_utc: 14,
        session_ad_seq: 3,
        model: 'deepseek-v4-flash',
        slot_erpm_bucket: 'unscored',
        first_party_geo_multiplier_bps: 6_500,
        first_party_geo_cpc_bucket: '25_to_lt_50',
        requested_provider: 'gravity',
        served_provider: 'first_party',
        attempted_provider_chain: 'gravity>first_party',
        experiment_arm: 'treatment',
        first_party_route: 'gravity_then_first_party',
        first_party_primary_percent: 10,
        first_party_backfill_enabled: true,
        first_party_geo_routing_enabled: true,
        first_party_inventory_geo_tier: 'tier1',
        first_party_geo_source: 'cloudflare',
        first_party_country_code: 'US',
        first_party_tier2_bonus_percent: 2,
        first_party_billing_mode: 'cpa',
        external_settlement_enabled: false,
        first_party_primary_cohort: 'pilot-a',
        first_party_primary_cohort_percent: 1,
        first_party_served_cohort: 'pilot-a',
        first_party_entrypoint: 'primary',
        first_party_geo_tier: 'full',
        first_party_geo_floored: false,
        geo_cpc_enabled: true,
        gravity_outcome: 'no_fill',
        selection_reason: 'gravity_no_fill_backfill',
        ad_count: 1,
        surface: 'cli',
        placement_id: 'CLI-Chat-Inline',
        duration_ms: 42,
        client_ua_product: 'freebuff-cli',
        client_ua_version: '1.2.3',
        yield_shadow_sampled: true,
        yield_shadow_policy_version: 'cpc-yield-shadow-v1',
        yield_shadow_scope: 'eligible_single_placement',
        yield_shadow_exclusion_reason: 'none',
        yield_shadow_current_provider: 'gravity',
        yield_shadow_recommended_provider: 'first_party',
        yield_shadow_disagrees: true,
        yield_shadow_first_party_state: 'scored',
        yield_shadow_first_party_value_bucket: '100_plus',
        yield_shadow_gravity_state: 'scored',
        yield_shadow_gravity_value_bucket: '10_to_lt_100',
        yield_shadow_imprezia_state: 'unscored_missing_prior',
        yield_shadow_imprezia_value_bucket: 'unscored',
        yield_actual_attempt_chain: 'gravity>first_party',
        yield_requested_placement_count_bucket: 'one',
        yield_returned_ad_count_bucket: 'one',
        yield_live_mode: 'live',
        yield_live_activated: true,
        yield_live_reason: 'live',
        yield_live_arm: 'treatment',
        yield_live_policy_version: 'policy:v1',
        yield_live_estimate_version: 'estimates-v1',
        yield_live_effective_treatment_bps: 50,
        yield_live_planned_chain: 'first_party>gravity>carbon',
        yield_live_evidence_reservation_status: 'reserved',
        yield_live_evidence_status: 'scheduled',
        // Arrays must be producer-encoded as attempted_provider_chain.
        attempted_providers: ['gravity', 'carbon'],
        // High-cardinality identifiers and content do not reach Axiom.
        userId: 'user-123',
        advertiser_id: 'advertiser-123',
        chat_session_id: 'session-123',
        campaign_ids: ['campaign-123'],
        creative_ids: ['creative-123'],
        ad_url: 'https://example.com/secret',
        yield_shadow_raw_ecpm_cents: 123.45,
        yield_shadow_provider_priors: { gravity: 0.12 },
        yield_shadow_provider_outcomes: ['fill'],
        yield_shadow_campaign_id: 'campaign-123',
        yield_shadow_creative_url: 'https://example.com/creative',
        yield_shadow_error: 'upstream timeout',
        messages: [{ role: 'user', content: 'secret' }],
      }),
    ).toEqual({
      event: ADS_FETCH_COMPLETED_EVENT,
      data: {
        outcome: 'fill',
        opportunity_id: 'opp_11111111-2222-3333-4444-555555555555',
        policy_version: 'a1b2c3d4e5f6',
        policy_commit: 'deadbeefcafe',
        sample_rate: 1,
        first_party_arm_bucket: 4_242,
        eligible_campaign_count: 2,
        excluded_campaign_count: 3,
        eligible_campaign_labels: 'coderabbit,pilot-b',
        exclusion_reasons: 'daily_cap_spent:1,tag_mismatch:2',
        hour_utc: 14,
        session_ad_seq: 3,
        model: 'deepseek-v4-flash',
        slot_erpm_bucket: 'unscored',
        first_party_geo_multiplier_bps: 6_500,
        first_party_geo_cpc_bucket: '25_to_lt_50',
        requested_provider: 'gravity',
        served_provider: 'first_party',
        attempted_provider_chain: 'gravity>first_party',
        experiment_arm: 'treatment',
        first_party_route: 'gravity_then_first_party',
        first_party_primary_percent: 10,
        first_party_backfill_enabled: true,
        first_party_geo_routing_enabled: true,
        first_party_inventory_geo_tier: 'tier1',
        first_party_geo_source: 'cloudflare',
        first_party_country_code: 'US',
        first_party_tier2_bonus_percent: 2,
        first_party_billing_mode: 'cpa',
        external_settlement_enabled: false,
        first_party_primary_cohort: 'pilot-a',
        first_party_primary_cohort_percent: 1,
        first_party_served_cohort: 'pilot-a',
        first_party_entrypoint: 'primary',
        first_party_geo_tier: 'full',
        first_party_geo_floored: false,
        geo_cpc_enabled: true,
        gravity_outcome: 'no_fill',
        selection_reason: 'gravity_no_fill_backfill',
        ad_count: 1,
        surface: 'cli',
        placement_id: 'CLI-Chat-Inline',
        duration_ms: 42,
        client_ua_product: 'freebuff-cli',
        client_ua_version: '1.2.3',
        yield_shadow_sampled: true,
        yield_shadow_policy_version: 'cpc-yield-shadow-v1',
        yield_shadow_scope: 'eligible_single_placement',
        yield_shadow_exclusion_reason: 'none',
        yield_shadow_current_provider: 'gravity',
        yield_shadow_recommended_provider: 'first_party',
        yield_shadow_disagrees: true,
        yield_shadow_first_party_state: 'scored',
        yield_shadow_first_party_value_bucket: '100_plus',
        yield_shadow_gravity_state: 'scored',
        yield_shadow_gravity_value_bucket: '10_to_lt_100',
        yield_shadow_imprezia_state: 'unscored_missing_prior',
        yield_shadow_imprezia_value_bucket: 'unscored',
        yield_actual_attempt_chain: 'gravity>first_party',
        yield_requested_placement_count_bucket: 'one',
        yield_returned_ad_count_bucket: 'one',
        yield_live_mode: 'live',
        yield_live_activated: true,
        yield_live_reason: 'live',
        yield_live_arm: 'treatment',
        yield_live_policy_version: 'policy:v1',
        yield_live_estimate_version: 'estimates-v1',
        yield_live_effective_treatment_bps: 50,
        yield_live_planned_chain: 'first_party>gravity>carbon',
        yield_live_evidence_reservation_status: 'reserved',
        yield_live_evidence_status: 'scheduled',
      },
    })
  })

  test('keeps only server-shaped Imprezia correlation handles', () => {
    expect(
      getAxiomOnlyLogEvent({
        axiomEvent: ADS_IMPREZIA_FETCH_COMPLETED_EVENT,
        outcome: 'provider_error',
        request_id: 'adr_0123456789abcdef0123456789abcdef',
        opportunity_id: 'opp_0123456789abcdef0123456789abcdef',
        selection_reason: 'fallback',
        experiment_arm: 'control',
        surface: 'freebuff_web_chat',
        ad_count: 0,
        duration_ms: 42,
        test_mode: false,
        failure_class: 'provider_failure',
        userId: 'user-private',
        sessionId: 'session-private',
        requestId: 'request-private',
        request: 'private prompt',
        response: 'private response',
        ad: { title: 'private creative' },
        clickUrl: 'https://private.example/click',
        error: new Error('private raw provider error'),
      }),
    ).toEqual({
      event: ADS_IMPREZIA_FETCH_COMPLETED_EVENT,
      data: {
        outcome: 'provider_error',
        request_id: 'adr_0123456789abcdef0123456789abcdef',
        opportunity_id: 'opp_0123456789abcdef0123456789abcdef',
        selection_reason: 'fallback',
        experiment_arm: 'control',
        surface: 'freebuff_web_chat',
        ad_count: 0,
        duration_ms: 42,
        test_mode: false,
        failure_class: 'provider_failure',
      },
    })
  })

  test('rejects unbounded or incomplete Imprezia completion dimensions', () => {
    const valid = {
      axiomEvent: ADS_IMPREZIA_FETCH_COMPLETED_EVENT,
      outcome: 'no_fill',
      request_id: 'adr_0123456789abcdef0123456789abcdef',
      opportunity_id: 'opp_0123456789abcdef0123456789abcdef',
      selection_reason: 'primary',
      experiment_arm: 'imprezia_first',
      surface: 'freebuff_web_chat',
      ad_count: 0,
      duration_ms: 42,
      test_mode: false,
    }
    for (const invalid of [
      { ...valid, outcome: 'private raw error' },
      { ...valid, selection_reason: 'campaign-123' },
      { ...valid, experiment_arm: 'user-123' },
      { ...valid, surface: 'https://private.example' },
      { ...valid, ad_count: 2 },
      { ...valid, outcome: 'fill', ad_count: 0 },
      { ...valid, duration_ms: -1 },
      { ...valid, duration_ms: 60_001 },
      { ...valid, failure_class: 'raw upstream stack trace' },
      { ...valid, request_id: 'request-private' },
      { ...valid, opportunity_id: 'opp_private' },
      { ...valid, request_id: undefined },
      { ...valid, opportunity_id: undefined },
      { ...valid, test_mode: 'false' },
      // Every dimension except failure_class is required.
      { ...valid, experiment_arm: undefined },
    ]) {
      expect(getAxiomOnlyLogEvent(invalid)).toBeNull()
    }
  })

  test('names and sanitizes first-party selection telemetry', () => {
    expect(
      getAxiomOnlyLogEvent({
        axiomEvent: ADS_FIRST_PARTY_DECISION_EVENT,
        outcome: 'no_fill',
        no_fill_reason: 'no_eligible_campaign',
        primary_allocation_invalid: true,
        placement_count: 2,
        candidate_count: 4,
        candidate_load_ms: 8,
        frequency_status: 'unavailable',
        frequency_unavailable_cause: 'timeout',
        frequency_unavailable_causes: 'timeout,unreachable',
        frequency_reservation_ms: 75,
        frequency_max_reservation_ms: 75,
        duration_ms: 11,
        campaign_ids: ['campaign-123'],
        creative_ids: ['creative-123'],
        placement_ids: ['CLI-Chat-Inline'],
        userId: 'user-123',
        reasons: ['budget_exhausted'],
        nested: { private: true },
      }),
    ).toEqual({
      event: ADS_FIRST_PARTY_DECISION_EVENT,
      data: {
        outcome: 'no_fill',
        no_fill_reason: 'no_eligible_campaign',
        primary_allocation_invalid: true,
        placement_count: 2,
        candidate_count: 4,
        candidate_load_ms: 8,
        frequency_status: 'unavailable',
        frequency_unavailable_cause: 'timeout',
        frequency_unavailable_causes: 'timeout,unreachable',
        frequency_reservation_ms: 75,
        frequency_max_reservation_ms: 75,
        duration_ms: 11,
      },
    })
  })

  test('names and sanitizes first-party settlement telemetry', () => {
    expect(
      getAxiomOnlyLogEvent(
        {
          billing_model: 'cpa',
          settlement_status: 'charged',
          amount_cents: 75,
          balance_cents: 925,
          duration_ms: 6,
          userId: 'user-123',
          advertiser_id: 'advertiser-123',
          campaign_id: 'campaign-123',
          ad_impression_id: 'impression-123',
          error: { message: 'private failure detail' },
        },
        ADS_FIRST_PARTY_SETTLEMENT_EVENT,
      ),
    ).toEqual({
      event: ADS_FIRST_PARTY_SETTLEMENT_EVENT,
      data: {
        billing_model: 'cpa',
        settlement_status: 'charged',
        amount_cents: 75,
        balance_cents: 925,
        duration_ms: 6,
      },
    })
  })

  test('keeps first-party tracking telemetry content- and identity-free', () => {
    for (const event of [
      ADS_FIRST_PARTY_CLICK_RECORDED_EVENT,
      ADS_FIRST_PARTY_IMPRESSION_RECORDED_EVENT,
    ]) {
      expect(
        getAxiomOnlyLogEvent({
          axiomEvent: event,
          provider: 'first_party',
          surface: 'cli_chat',
          placement_id: 'CLI-Chat-Inline',
          already_clicked: false,
          pixel_count: 0,
          userId: 'user-private',
          ad_impression_id: 'impression-private',
          title: 'private creative',
          cta: 'private cta',
          ad_url: 'https://advertiser.example/private',
        }),
      ).toEqual({
        event,
        data: {
          provider: 'first_party',
          surface: 'cli_chat',
          placement_id: 'CLI-Chat-Inline',
          already_clicked: false,
          pixel_count: 0,
        },
      })
    }
  })

  test('accepts only the exact bounded first-party view acknowledgement schema', () => {
    expect(
      getAxiomOnlyLogEvent({
        axiomEvent: ADS_FIRST_PARTY_VIEW_ACK_EVENT,
        surface: 'waiting_room',
        placement_id: 'waiting-room-1',
        outcome: 'accepted',
        attempt: 1,
        duration_ms: 250,
        client_family: 'cli',
      }),
    ).toEqual({
      event: ADS_FIRST_PARTY_VIEW_ACK_EVENT,
      data: {
        surface: 'waiting_room',
        placement_id: 'waiting-room-1',
        outcome: 'accepted',
        attempt: 1,
        duration_ms: 250,
        client_family: 'cli',
      },
    })
  })

  // COD-365: released binaries send the six-field shape, newer ones add
  // `client_event_id` and `sample_rate`. Both must validate; a malformed
  // optional field rejects the whole event like a malformed required one.
  test('accepts the COD-365 optional view-ack fields and keeps the old shape valid', () => {
    const legacy = {
      surface: 'cli_chat',
      placement_id: 'CLI-Chat-Inline',
      outcome: 'accepted',
      attempt: 1,
      duration_ms: 12,
      client_family: 'cli',
    }
    expect(
      getAxiomOnlyLogEvent({
        axiomEvent: ADS_FIRST_PARTY_VIEW_ACK_EVENT,
        ...legacy,
      }),
    ).toEqual({ event: ADS_FIRST_PARTY_VIEW_ACK_EVENT, data: legacy })
    const modern = {
      ...legacy,
      client_event_id: '123e4567-e89b-42d3-a456-426614174000',
      sample_rate: 1,
    }
    expect(
      getAxiomOnlyLogEvent({
        axiomEvent: ADS_FIRST_PARTY_VIEW_ACK_EVENT,
        ...modern,
      }),
    ).toEqual({ event: ADS_FIRST_PARTY_VIEW_ACK_EVENT, data: modern })
    for (const payload of [
      { ...modern, client_event_id: 'not an id' },
      { ...modern, client_event_id: 'x'.repeat(129) },
      { ...modern, client_event_id: 42 },
      { ...modern, sample_rate: 0 },
      { ...modern, sample_rate: 1.5 },
      { ...modern, sample_rate: '1' },
    ]) {
      expect(
        getAxiomOnlyLogEvent({
          axiomEvent: ADS_FIRST_PARTY_VIEW_ACK_EVENT,
          ...payload,
        }),
      ).toBeNull()
    }
  })

  test('carries the COD-365 hygiene fields on the tracking events', () => {
    for (const event of [
      ADS_FIRST_PARTY_IMPRESSION_RECORDED_EVENT,
      ADS_FIRST_PARTY_CLICK_RECORDED_EVENT,
    ]) {
      expect(
        getAxiomOnlyLogEvent({
          axiomEvent: event,
          provider: 'first_party',
          client_event_id: 'evt-1',
          deduped: false,
          render_delay_ms: 1234,
          opportunity_id: 'opp_1',
          creative_version: 2,
          client_family: 'desktop',
          sample_rate: 1,
          userId: 'user-private',
          view_event_id: 'private',
        }),
      ).toEqual({
        event,
        data: {
          provider: 'first_party',
          client_event_id: 'evt-1',
          deduped: false,
          render_delay_ms: 1234,
          opportunity_id: 'opp_1',
          creative_version: 2,
          client_family: 'desktop',
          sample_rate: 1,
        },
      })
    }
  })

  // AC6 (COD-365), scoped to the allowlists COD-365 owns: the CLIENT-emitted
  // ads events. `ADS_FETCH_COMPLETED_FIELDS` is a server event owned by the
  // rail slice (COD-369 / D1): it already carries `sample_rate`, and the day
  // it also carries `client_family` this guard should be widened to
  // `ADS_FETCH_COMPLETED_FIELD_NAMES` for both -- deliberately NOT asserted
  // here so this test cannot red that branch while the two land separately.
  test('CI guard: every client ads allowlist carries the hygiene fields', () => {
    for (const field of ADS_CLIENT_EVENT_HYGIENE_FIELDS) {
      expect(ADS_FIRST_PARTY_TRACKING_FIELD_NAMES).toContain(field)
      expect(FIRST_PARTY_VIEW_ACK_FIELD_NAMES).toContain(field)
    }
  })

  test('rejects malformed or private first-party view acknowledgement payloads', () => {
    const valid = {
      surface: 'cli_chat',
      placement_id: 'CLI-Chat-Inline',
      outcome: 'network_error',
      attempt: 3,
      duration_ms: 1,
      client_family: 'desktop',
    }
    const invalid = [
      { ...valid, impression_token: 'private-token' },
      { ...valid, error: { message: 'private raw error' } },
      { ...valid, url: 'https://private.example' },
      { ...valid, placement_id: 'unknown-slot' },
      { ...valid, surface: 'waiting_room' },
      { ...valid, outcome: 'retrying' },
      { ...valid, attempt: 0 },
      { ...valid, attempt: 4 },
      { ...valid, attempt: 1.5 },
      { ...valid, duration_ms: Number.POSITIVE_INFINITY },
      { ...valid, duration_ms: -1 },
      { ...valid, duration_ms: 10_001 },
      { ...valid, client_family: 'mobile' },
    ]
    for (const payload of invalid) {
      expect(
        getAxiomOnlyLogEvent({
          axiomEvent: ADS_FIRST_PARTY_VIEW_ACK_EVENT,
          ...payload,
        }),
      ).toBeNull()
    }
    expect(getAxiomOnlyLogEvent(valid, ADS_FIRST_PARTY_VIEW_ACK_EVENT)).toEqual(
      {
        event: ADS_FIRST_PARTY_VIEW_ACK_EVENT,
        data: valid,
      },
    )
  })

  test('keeps external conversion postbacks content- and identifier-free', () => {
    expect(
      getAxiomOnlyLogEvent({
        axiomEvent: ADS_EXTERNAL_CONVERSION_POSTBACK_EVENT,
        channel: 'client',
        outcome: 'accepted',
        rejection_reason: 'none',
        event_type: 'signup_completed',
        traffic_class: 'test',
        primary_allocation_cohort: 'drizz',
        settlement_status: 'not_billable',
        charged_cents: 0,
        duration_ms: 8,
        api_key: 'fbadv_private',
        key_prefix: 'fbadv_123',
        bfcid: 'bfc_test_1.private',
        event_id: 'private-event',
        campaign_id: 'campaign-private',
        advertiser_id: 'advertiser-private',
        user_id: 'user-private',
        email: 'private@example.com',
        url: 'https://partner.example/private',
        body: { private: true },
        error: new Error('private failure'),
      }),
    ).toEqual({
      event: ADS_EXTERNAL_CONVERSION_POSTBACK_EVENT,
      data: {
        channel: 'client',
        outcome: 'accepted',
        rejection_reason: 'none',
        event_type: 'signup_completed',
        traffic_class: 'test',
        primary_allocation_cohort: 'drizz',
        settlement_status: 'not_billable',
        charged_cents: 0,
        duration_ms: 8,
      },
    })
  })

  test('keeps only closed click-id shape labels on the postback census', () => {
    const base = {
      axiomEvent: ADS_EXTERNAL_CONVERSION_POSTBACK_EVENT,
      channel: 's2s',
      outcome: 'rejected',
      rejection_reason: 'invalid_click_id',
      event_type: 'unknown',
      traffic_class: 'unknown',
      primary_allocation_cohort: 'none',
      settlement_status: 'unknown',
      charged_cents: 0,
      duration_ms: 8,
    }
    for (const clickIdShape of ADS_EXTERNAL_CONVERSION_CLICK_ID_SHAPES) {
      expect(
        getAxiomOnlyLogEvent({
          ...base,
          click_id_shape: clickIdShape,
        })?.data,
      ).toMatchObject({ click_id_shape: clickIdShape })
    }

    const result = getAxiomOnlyLogEvent({
      ...base,
      click_id_shape: 'bfc_1.private-raw-click-value',
      advertiser_id: 'advertiser-private',
      api_key: 'fbadv_private',
    })
    expect(result?.data).not.toHaveProperty('click_id_shape')
    expect(JSON.stringify(result)).not.toContain('private')
  })

  test('drops a non-string channel from the postback census', () => {
    const result = getAxiomOnlyLogEvent({
      axiomEvent: ADS_EXTERNAL_CONVERSION_POSTBACK_EVENT,
      channel: 42,
      outcome: 'accepted',
      rejection_reason: 'none',
      event_type: 'signup_completed',
      traffic_class: 'test',
      primary_allocation_cohort: 'drizz',
      settlement_status: 'not_billable',
      charged_cents: 0,
      duration_ms: 8,
    })
    expect(result?.data).not.toHaveProperty('channel')
  })

  test('keeps only bounded campaign ingress evidence fields', () => {
    expect(
      getAxiomOnlyLogEvent({
        axiomEvent: ADS_CAMPAIGN_INGRESS_EVIDENCE_EVENT,
        evidence_version: 'campaign_ingress_evidence_v1',
        evidence_id: 'che_0123456789abcdef0123456789abcdef',
        advertiser_id: 'advertiser-1',
        campaign_id: 'campaign-1',
        campaign_config_revision: 4,
        binding_status: 'independently_bound',
        outcome: 'joined',
        rail: 's2s_postback',
        traffic_class: 'real',
        traffic_class_version: 'traffic_class_v1',
        source_event_id: 'partner-private-id',
        click_id: 'bfc_private',
        receiver_secret: 'private',
        email: 'private@example.com',
        ip: '192.0.2.1',
        user_agent: 'private-agent',
      }),
    ).toEqual({
      event: ADS_CAMPAIGN_INGRESS_EVIDENCE_EVENT,
      data: {
        evidence_version: 'campaign_ingress_evidence_v1',
        evidence_id: 'che_0123456789abcdef0123456789abcdef',
        advertiser_id: 'advertiser-1',
        campaign_id: 'campaign-1',
        campaign_config_revision: 4,
        binding_status: 'independently_bound',
        outcome: 'joined',
        rail: 's2s_postback',
        traffic_class: 'real',
        traffic_class_version: 'traffic_class_v1',
      },
    })
  })
})
