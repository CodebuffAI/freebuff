import { describe, expect, test } from 'bun:test'
import {
  localAgenticBackendCampaign,
  localAgenticTestCampaign,
} from './local-agentic-test'

const local = {
  TEST_AGENTIC_ADS: 'true',
  TEST_AGENTIC_ADS_CAMPAIGN: 'd5dbe7ad-c2cc-4423-8871-211234560001',
  NODE_ENV: 'development',
  NEXT_PUBLIC_CB_ENVIRONMENT: 'dev',
  NEXT_PUBLIC_CODEBUFF_APP_URL: 'http://localhost:3300',
  NEXT_PUBLIC_FREEBUFF_APP_URL: 'http://localhost:3302',
  DATABASE_URL:
    'postgres://user:password@127.0.0.1:55432/freebuff_agentic_test',
  DIRECT_DATABASE_URL:
    'postgres://user:password@127.0.0.1:55432/freebuff_agentic_test',
  NEXT_PUBLIC_CONVEX_URL: 'http://127.0.0.1:3320',
  REDIS_URL: 'redis://127.0.0.1:56379',
}
describe('local agentic test authority', () => {
  test('absent flag leaves ordinary production behavior alone', () => {
    expect(
      localAgenticBackendCampaign({ DATABASE_URL: 'postgres://prod/db' }),
    ).toBeNull()
  })
  test('client and backend accept only the explicit local setup', () => {
    expect(localAgenticTestCampaign(local)).toBe(
      local.TEST_AGENTIC_ADS_CAMPAIGN,
    )
    expect(localAgenticBackendCampaign(local)).toBe(
      local.TEST_AGENTIC_ADS_CAMPAIGN,
    )
  })
  test.each([
    ['NODE_ENV', 'production'],
    ['NEXT_PUBLIC_CB_ENVIRONMENT', 'prod'],
    ['TEST_AGENTIC_ADS_CAMPAIGN', ''],
    ['NEXT_PUBLIC_CODEBUFF_APP_URL', 'https://www.codebuff.com'],
    ['NEXT_PUBLIC_FREEBUFF_APP_URL', 'https://freebuff.com'],
    ['DATABASE_URL', 'postgres://prod/freebuff_agentic_test'],
    ['DIRECT_DATABASE_URL', 'postgres://prod/freebuff_agentic_test'],
    ['DATABASE_URL', 'postgres://127.0.0.1/another_database'],
    [
      'DATABASE_URL',
      'postgres://localhost.attacker.test/freebuff_agentic_test',
    ],
    ['NEXT_PUBLIC_CONVEX_URL', 'https://example.convex.cloud'],
    ['REDIS_URL', 'redis://remote:6379'],
    ['CONVEX_ADMIN_KEY', 'prod:secret'],
  ])('refuses %s=%s before any write', (key, value) => {
    expect(() =>
      localAgenticBackendCampaign({ ...local, [key]: value }),
    ).toThrow()
  })
})
