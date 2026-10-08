import { expect, test } from 'bun:test'
import { normalizePullRequestChecks } from './pull-request'

test('check runs and commit statuses share a conservative aggregate', () => {
  expect(normalizePullRequestChecks([])).toBe('none')
  expect(normalizePullRequestChecks(null)).toBe('unknown')
  expect(normalizePullRequestChecks([{ conclusion: 'success' }])).toBe('unknown')
  expect(normalizePullRequestChecks([{ status: 'completed', conclusion: 'success' }, { state: 'SUCCESS' }])).toBe('passed')
  expect(normalizePullRequestChecks([{ status: 'COMPLETED', conclusion: 'SKIPPED' }, { state: 'PENDING' }])).toBe('pending')
  expect(normalizePullRequestChecks([{ status: 'IN_PROGRESS' }, { state: 'failure' }])).toBe('failed')
  expect(normalizePullRequestChecks([{ status: 'COMPLETED', conclusion: null }, { state: 'SUCCESS' }])).toBe('unknown')
})
