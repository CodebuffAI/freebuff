#!/usr/bin/env node

// Parse command line arguments
const args = process.argv.slice(2)
const versionType = args[0] || 'patch' // patch, minor, major, or specific version like 1.2.3

const DISPATCH_URL =
  'https://api.github.com/repos/CodebuffAI/freebuff-private/actions/workflows/cli-release-prod.yml/dispatches'
const WORKFLOW_URL =
  'https://github.com/CodebuffAI/freebuff-private/actions/workflows/cli-release-prod.yml'

export type DispatchRequest = { url: string; init: RequestInit }

/** 'dispatched' only when GitHub answered 204 and accepted the run. */
export type DispatchOutcome = 'dispatched' | 'failed'

function log(message: string) {
  console.log(`${message}`)
}

function error(message: string): never {
  console.error(`❌ ${message}`)
  process.exit(1)
}

function formatTimestamp() {
  const now = new Date()
  const options = {
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short',
  } as const
  return now.toLocaleDateString('en-US', options)
}

function checkGitHubToken() {
  const token = process.env.CODEBUFF_GITHUB_TOKEN
  if (!token) {
    error(
      'CODEBUFF_GITHUB_TOKEN environment variable is required but not set.\n' +
      'Please set it with your GitHub personal access token or use the infisical setup.'
    )
  }
  return token
}

/**
 * The dispatch request, built as data.
 *
 * This used to be a shell string handed to `execSync`, with the token and
 * `versionType` interpolated into it. Two consequences, both real:
 *
 *  - the token sat in that command line, so every local process could read it
 *    out of the process list for as long as curl ran;
 *  - `versionType` comes straight from `argv`, and it was placed inside a
 *    single-quoted shell word. A `'` in it closed the quote and the rest of the
 *    argument was executed by the shell.
 *
 * A request object has neither problem: no shell ever parses it, so a hostile
 * `versionType` is just a string in a JSON body. Probes for both defects are
 * recorded in `src/__tests__/release-script.test.ts`.
 */
export function buildDispatch(
  versionType: string,
  token: string,
): DispatchRequest {
  return {
    url: DISPATCH_URL,
    init: {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github.v3+json',
        Authorization: `token ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ref: 'main',
        inputs: { version_type: versionType },
      }),
    },
  }
}

export async function triggerWorkflow(
  versionType: string,
  // Injectable so the tests can prove what was handed to the network without
  // reaching GitHub. Defaults to the real fetch.
  fetchImpl: typeof fetch = fetch,
  token: string | undefined = process.env.CODEBUFF_GITHUB_TOKEN ??
    process.env.GITHUB_TOKEN,
): Promise<DispatchOutcome> {
  if (!token) {
    error('CODEBUFF_GITHUB_TOKEN environment variable is required but not set')
  }

  const { url, init } = buildDispatch(versionType, token)

  try {
    const response = await fetchImpl(url, init)
    const body = await response.text()

    // The status is the answer. This used to be "does the response text contain
    // workflow_dispatch", so a 401 or a 500 — neither of which mentions the
    // trigger — printed "🎉 Release workflow triggered!" and the maintainer
    // believed a release was running.
    if (response.status === 204) {
      log('🎉 Release workflow triggered!')
      return 'dispatched'
    }

    log(
      `⚠️  Workflow dispatch failed: HTTP ${response.status}${body ? ` — ${body}` : ''}`,
    )
    // Hint only. The decision above is the status code; this just explains the
    // one 422 that means "the workflow has no workflow_dispatch trigger".
    if (response.status === 422 && body.includes('workflow_dispatch')) {
      log('The workflow may need to be updated on GitHub.')
    }
    log(`Please trigger the workflow manually at: ${WORKFLOW_URL}`)
    return 'failed'
  } catch (err) {
    // The cause is printed, not flattened: a refused connection and a 401 are
    // different problems and the maintainer needs to tell them apart.
    log(`⚠️  Failed to trigger workflow automatically: ${(err as Error).message}`)
    log(`You may need to trigger it manually at: ${WORKFLOW_URL}`)
    return 'failed'
  }
}

async function main() {
  log('🚀 Initiating release...')
  log(`Date: ${formatTimestamp()}`)

  // Check for local GitHub token
  checkGitHubToken()
  log('✅ Using local CODEBUFF_GITHUB_TOKEN')

  log(`Version bump type: ${versionType}`)

  // Trigger the workflow
  await triggerWorkflow(versionType)

  log('')
  log('Monitor progress at: https://github.com/CodebuffAI/freebuff-private/actions')
}

// Only when this file is the program being run. Without the guard, importing
// the module to test it fired a real release — or, with no token in the
// environment, exited the whole process from inside the import.
if (import.meta.main) {
  main().catch((err) => {
    error(`Release failed: ${err.message}`)
  })
}
