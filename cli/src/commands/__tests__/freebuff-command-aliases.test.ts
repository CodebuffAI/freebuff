import { describe, expect, test } from 'bun:test'

describe('freebuff command aliases', () => {
  test('/model opens its own picker command in freebuff', () => {
    const slashCommandsUrl = new URL(
      '../../data/slash-commands.ts',
      import.meta.url,
    ).href
    const commandRegistryUrl = new URL(
      '../command-registry.ts',
      import.meta.url,
    ).href

    const result = Bun.spawnSync({
      cmd: [
        'bun',
        '--eval',
        `
          import { SLASH_COMMANDS } from ${JSON.stringify(slashCommandsUrl)}
          import { findCommand } from ${JSON.stringify(commandRegistryUrl)}

          const endSession = SLASH_COMMANDS.find((cmd) => cmd.id === 'end-session')
          if (!endSession) throw new Error('end-session slash command missing')
          if (endSession.aliases?.includes('model')) {
            throw new Error('model must not end the session')
          }

          for (const name of ['reasoning', 'effort', 'think']) {
            if (findCommand(name)) throw new Error(name + ' command should be removed')
          }
          const modelCommand = findCommand('model')
          if (!modelCommand) throw new Error('model command alias missing')
          if (modelCommand.name !== 'model') {
            throw new Error('model must resolve to its own command')
          }
        `,
      ],
      cwd: process.cwd(),
      env: {
        ...process.env,
        FREEBUFF_MODE: 'true',
        NODE_ENV: 'test',
        NEXT_PUBLIC_CB_ENVIRONMENT: 'test',
        NEXT_PUBLIC_CODEBUFF_APP_URL: 'https://app.codebuff.test',
        NEXT_PUBLIC_SUPPORT_EMAIL: 'support@codebuff.test',
        NEXT_PUBLIC_POSTHOG_API_KEY: 'phc_test_key',
        NEXT_PUBLIC_POSTHOG_HOST_URL: 'https://posthog.codebuff.test',
        NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_test_123',
        NEXT_PUBLIC_STRIPE_CUSTOMER_PORTAL: 'https://stripe.codebuff.test',
        NEXT_PUBLIC_WEB_PORT: '3000',
      },
      stderr: 'pipe',
      stdout: 'pipe',
    })

    const stderr = new TextDecoder().decode(result.stderr)
    expect(result.exitCode, stderr).toBe(0)
  }, 15_000)
})
