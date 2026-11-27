#!/usr/bin/env bun

import {
  isTerminalCommandBrokerInvocation,
  serveTerminalCommandBroker,
} from './utils/terminal-command-broker'

if (isTerminalCommandBrokerInvocation(process.argv)) {
  await serveTerminalCommandBroker()
} else if (
  process.argv.slice(2).includes('/import') &&
  (await import('./utils/env')).getCliEnv().FREEBUFF_MODE === 'true' &&
  (await import('./cli-args')).parseArgs().command === '/import'
) {
  // The same local setup flow is available to a new installation before the chat login gate.
  try {
    const { runTerminalSetupImport } = await import('./commands/setup-import')
    process.stdout.write((await runTerminalSetupImport()) + '\n')
  } catch {
    process.stderr.write('Import was interrupted. Run freebuff /import again to check remaining items.\n')
    process.exitCode = 1
  }
} else {
  await import('./index')
}
