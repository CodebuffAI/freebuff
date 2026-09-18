import { createHash } from 'node:crypto'

import { describe, expect, test } from 'bun:test'

import {
  ACCEPTANCE_CRITERIA_CONTRACT_VERSION,
  acceptanceCriteriaSha256,
  buildAcceptanceCriteriaFromAdvertiserChecks,
  canonicalizeAcceptanceCriteriaContract,
  mapAdvertiserSuccessCheck,
  parseAcceptanceCriteriaContract,
  parseReviewAcceptanceCriteria,
  sha256Hex,
  summarizeAcceptanceCriteria,
  type AcceptanceCriteriaContract,
} from './sponsored-acceptance-criteria'

const fixture = (): AcceptanceCriteriaContract => ({
  version: ACCEPTANCE_CRITERIA_CONTRACT_VERSION,
  criteria: [
    {
      id: 'env-example',
      title: 'Document the API key',
      expected: '.env.example names ACME_API_KEY',
      required: true,
      phase: 'code-ready',
      evidenceMethod: 'configuration',
      check: {
        kind: 'config_key_declared',
        pathPattern: '.env.example',
        keyPattern: 'ACME_API_KEY',
      },
    },
    {
      id: 'live-account',
      title: 'Connect an account',
      expected: 'Approved probe sees an authenticated session',
      required: true,
      phase: 'live-setup',
      evidenceMethod: 'live_probe',
      check: { kind: 'live_auth', probeId: 'acme-session' },
    },
  ],
})

describe('parseAcceptanceCriteriaContract', () => {
  test('accepts a valid versioned contract', () => {
    const parsed = parseAcceptanceCriteriaContract(fixture())
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.contract.criteria).toHaveLength(2)
  })

  test('rejects a new empty contract', () => {
    const parsed = parseAcceptanceCriteriaContract({
      version: 1,
      criteria: [],
    })
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) {
      expect(parsed.errors[0]?.message).toContain('cannot be empty')
    }
  })

  test('rejects duplicate ids and live_auth in the code-ready phase', () => {
    const parsed = parseAcceptanceCriteriaContract({
      version: 1,
      criteria: [
        {
          id: 'same',
          title: 'One',
          expected: 'A',
          required: true,
          phase: 'code-ready',
          evidenceMethod: 'live_probe',
          check: { kind: 'live_auth', probeId: 'acme-session' },
        },
        {
          id: 'same',
          title: 'Two',
          expected: 'B',
          required: true,
          phase: 'live-setup',
          evidenceMethod: 'live_probe',
          check: { kind: 'live_auth', probeId: 'acme-session' },
        },
      ],
    })
    expect(parsed.ok).toBe(false)
  })

  test('rejects a method that does not match the check', () => {
    const parsed = parseAcceptanceCriteriaContract({
      version: 1,
      criteria: [
        {
          id: 'mismatch',
          title: 'Mismatch',
          expected: 'Should fail review',
          required: true,
          phase: 'code-ready',
          evidenceMethod: 'live_probe',
          check: {
            kind: 'path_added',
            pathPattern: 'src/acme.ts',
          },
        },
      ],
    })
    expect(parsed.ok).toBe(false)
  })
})

describe('parseReviewAcceptanceCriteria', () => {
  test('absent is the legacy omit, not an invalid new contract', () => {
    expect(parseReviewAcceptanceCriteria(null)).toEqual({ kind: 'legacy' })
    expect(parseReviewAcceptanceCriteria(undefined)).toEqual({ kind: 'legacy' })
  })

  test('present empty is invalid at review', () => {
    const parsed = parseReviewAcceptanceCriteria({ version: 1, criteria: [] })
    expect(parsed.kind).toBe('invalid')
  })

  test('present valid is a reviewable contract', () => {
    const parsed = parseReviewAcceptanceCriteria(fixture())
    expect(parsed.kind).toBe('contract')
  })
})

describe('acceptanceCriteriaSha256', () => {
  test('matches node crypto over the canonical bytes', () => {
    const contract = fixture()
    const canonical = canonicalizeAcceptanceCriteriaContract(contract)
    expect(acceptanceCriteriaSha256(contract)).toBe(
      createHash('sha256').update(canonical, 'utf8').digest('hex'),
    )
    expect(sha256Hex(canonical)).toBe(
      createHash('sha256').update(canonical, 'utf8').digest('hex'),
    )
  })

  test('is stable under criterion reordering', () => {
    const a = fixture()
    const b: AcceptanceCriteriaContract = {
      ...a,
      criteria: [...a.criteria].reverse(),
    }
    expect(acceptanceCriteriaSha256(a)).toBe(acceptanceCriteriaSha256(b))
  })

  test('changes when expected result changes', () => {
    const edited = fixture()
    edited.criteria[0] = {
      ...edited.criteria[0]!,
      expected: 'Different expected result',
    }
    expect(acceptanceCriteriaSha256(edited)).not.toBe(
      acceptanceCriteriaSha256(fixture()),
    )
  })
})

describe('mapAdvertiserSuccessCheck', () => {
  test('maps three plain-language advertiser checks without JSON', () => {
    const built = buildAcceptanceCriteriaFromAdvertiserChecks([
      {
        title: 'SDK is installed',
        expected: 'package.json includes @acme/sdk',
      },
      {
        title: 'Application uses the SDK',
        expected: 'src/app.ts imports @acme/sdk',
      },
      {
        title: 'A test connection succeeds',
        expected: 'A test connection succeeds',
      },
    ])
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.contract.criteria).toHaveLength(3)
    expect(built.contract.criteria.map((criterion) => criterion.title)).toEqual([
      'SDK is installed',
      'Application uses the SDK',
      'A test connection succeeds',
    ])
    expect(built.contract.criteria[0]?.check).toEqual({
      kind: 'content_added',
      pathPattern: 'package.json',
      pattern: '@acme/sdk',
    })
    expect(built.contract.criteria[1]?.check).toEqual({
      kind: 'content_added',
      pathPattern: 'src/app.ts',
      pattern: '@acme/sdk',
    })
    expect(built.contract.criteria[2]?.check).toEqual({
      kind: 'live_auth',
      probeId: 'approved-session',
    })
    expect(built.contract.criteria[2]?.phase).toBe('live-setup')
  })

  test('placeholder config language maps to configuration, not live auth', () => {
    const mapped = mapAdvertiserSuccessCheck({
      title: 'Document the API key',
      expected: '.env.example names ACME_API_KEY',
    })
    expect(mapped.supported).toBe(true)
    expect(mapped.criterion.check).toEqual({
      kind: 'config_key_declared',
      pathPattern: '.env.example',
      keyPattern: 'ACME_API_KEY',
    })
    expect(mapped.criterion.evidenceMethod).toBe('configuration')
  })

  test('ambiguous text is rejected at review instead of becoming an unverifiable promise', () => {
    const mapped = mapAdvertiserSuccessCheck({
      title: 'It works',
      expected: 'the agent finished',
    })
    expect(mapped.supported).toBe(false)
    expect(mapped.feedback).toContain('file')
    const reviewed = parseReviewAcceptanceCriteria({
      version: 1,
      criteria: [mapped.criterion],
    })
    expect(reviewed.kind).toBe('invalid')
  })
})

describe('summarizeAcceptanceCriteria', () => {
  test('is safe to show before Accept — no check internals required', () => {
    const summary = summarizeAcceptanceCriteria(fixture())
    expect(summary).toEqual([
      {
        id: 'env-example',
        title: 'Document the API key',
        required: true,
        phase: 'code-ready',
        expected: '.env.example names ACME_API_KEY',
      },
      {
        id: 'live-account',
        title: 'Connect an account',
        required: true,
        phase: 'live-setup',
        expected: 'Approved probe sees an authenticated session',
      },
    ])
  })
})
