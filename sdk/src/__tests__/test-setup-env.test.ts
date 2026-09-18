import { expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'

test('the shared test preload removes an inherited ads Slack webhook', () => {
  const result = Bun.spawnSync(
    [
      process.execPath,
      '--preload',
      fileURLToPath(new URL('../../test/setup-env.ts', import.meta.url)),
      '--eval',
      'console.log(process.env.FREEBUFF_ADS_SLACK_WEBHOOK_URL === undefined)',
    ],
    {
      env: {
        ...process.env,
        NODE_ENV: 'production',
        BUN_ENV: 'production',
        NEXT_PUBLIC_CB_ENVIRONMENT: 'prod',
        FREEBUFF_ADS_SLACK_WEBHOOK_URL:
          'https://slack.example.invalid/inherited',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )

  expect(result.exitCode).toBe(0)
  expect(result.stdout.toString().trim()).toBe('true')
})
