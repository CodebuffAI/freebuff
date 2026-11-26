#!/usr/bin/env bun

/**
 * Freebuff CLI release script.
 *
 * Triggers the freebuff-release.yml GitHub Actions workflow
 * to build, publish, and release the Freebuff CLI to npm.
 *
 * Usage:
 *   bun freebuff/cli/release.ts [patch|minor|major] [--ref <commit-sha>]
 *
 * Requires:
 *   CODEBUFF_GITHUB_TOKEN environment variable
 */

const DISPATCH_URL =
  'https://api.github.com/repos/CodebuffAI/freebuff-private/actions/workflows/freebuff-release.yml/dispatches'
const WORKFLOW_URL =
  'https://github.com/CodebuffAI/freebuff-private/actions/workflows/freebuff-release.yml'

export type DispatchRequest = { url: string; init: RequestInit }

/** 'dispatched' only when GitHub answered 204 and accepted the run. */
export type DispatchOutcome = 'dispatched' | 'failed'

const args = process.argv.slice(2)

let versionType = 'patch'
let checkoutRef = ''

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--ref' && args[i + 1]) {
    checkoutRef = args[i + 1]
    i++
  } else if (!args[i].startsWith('--')) {
    versionType = args[i]
  }
}

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
        'Please set it with your GitHub personal access token or use the infisical setup.',
    )
  }

  // The `process.env.GITHUB_TOKEN` copy that used to sit here existed only so
  // the interpolated curl command could read it. Nothing reads it now.
  return token
}

/**
 * The dispatch request, built as data.
 *
 * This is the third copy of a release trigger, and it kept the old shape after
 * the other two were fixed: `curl` with the token and the JSON payload
 * interpolated into a shell word handed to `execSync`. Two consequences here,
 * one of them worse than in the other copies because this script takes a
 * second argv value:
 *
 *  - the token sat in that command line, readable from the process list for as
 *    long as curl ran;
 *  - `payload` contains BOTH `versionType` and `--ref` from argv, and it was
 *    placed inside a single-quoted shell word. A `'` in either one closed the
 *    quote and the rest ran as a command.
 *
 * A request object has neither problem: no shell parses it, so `--ref "x'; …"`
 * is just a string in a JSON body.
 */
export function buildDispatch(
  versionType: string,
  checkoutRef: string,
  token: string,
): DispatchRequest {
  const inputs: Record<string, string> = { version_type: versionType }
  if (checkoutRef) {
    inputs.checkout_ref = checkoutRef
  }
  return {
    url: DISPATCH_URL,
    init: {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github.v3+json',
        Authorization: `token ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ref: 'main', inputs }),
    },
  }
}

export async function triggerWorkflow(
  versionType: string,
  checkoutRef: string,
  // Injectable so the tests can prove what was handed to the network without
  // reaching GitHub. Defaults to the real fetch.
  fetchImpl: typeof fetch = fetch,
  token: string | undefined = process.env.CODEBUFF_GITHUB_TOKEN,
): Promise<DispatchOutcome> {
  if (!token) {
    error('CODEBUFF_GITHUB_TOKEN environment variable is required but not set')
  }

  const { url, init } = buildDispatch(versionType, checkoutRef, token)

  try {
    const response = await fetchImpl(url, init)
    const body = await response.text()

    // The status is the answer. This used to be "does the response text contain
    // workflow_dispatch", so a 401 or a 500 — neither of which mentions the
    // trigger — printed a celebration and the maintainer believed a release was
    // running.
    if (response.status === 204) {
      log('🎉 Freebuff release workflow triggered!')
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
  log('🚀 Initiating Freebuff release...')
  log(`Date: ${formatTimestamp()}`)

  checkGitHubToken()
  log('✅ Using local CODEBUFF_GITHUB_TOKEN')

  log(`Version bump type: ${versionType}`)
  if (checkoutRef) {
    log(`Building from ref: ${checkoutRef}`)
  }

  await triggerWorkflow(versionType, checkoutRef)

  log('')
  log(
    'Monitor progress at: https://github.com/CodebuffAI/freebuff-private/actions/workflows/freebuff-release.yml',
  )
}

// Only when this file is the program being run. Without the guard, importing
// the module to test it fired a real release — or, with no token in the
// environment, exited the whole process from inside the import.
if (import.meta.main) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err)
    error(`Release failed: ${message}`)
  })
}
