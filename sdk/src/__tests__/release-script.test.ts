import { describe, expect, spyOn, test } from 'bun:test'

/**
 * The SDK release script is a deliberate twin of `cli/scripts/release.ts`, and
 * it carried the same two defects: a shell string handed to `execSync`, with
 * the GitHub token and the `versionType` argv value interpolated into it.
 *
 * The reproductions and the mutation probes are recorded in
 * `cli/src/__tests__/release-script.test.ts` — one record, both files, because
 * they are the same change. The two that matter here:
 *
 *  - `versionType = "x'; rm -rf ~ #"` used to close the `-d '…'` shell word and
 *    run the remainder as a command;
 *  - the token used to sit in the command line of a child process, where any
 *    local process could read it. It is now only inside a request header.
 *
 * Mutations run against this file 2026-11-26, each verified in the diff:
 * token into the URL → "token only in a header" red; `body` by interpolation
 * instead of `JSON.stringify` → the punctuation case red (NOT the shell payload
 * alone: for `x'; rm -rf ~ #` the two are byte-identical, see the cli record);
 * the old "does the body contain workflow_dispatch" success test → the 401 case
 * red; `err.message` dropped from the catch → the thrown-fetch case red; the
 * `require.main === module` guard removed → this file dies at import.
 */

const TOKEN = 'ghp_test_token_not_real'
// The shell payload: what used to break the `-d '…'` word.
const HOSTILE = "x'; rm -rf ~ #"
// The JSON payload: what interpolation cannot encode.
const HOSTILE_JSON = '1.2.3"},"extra":"1'
const DISPATCH_URL =
  'https://api.github.com/repos/CodebuffAI/freebuff-private/actions/workflows/sdk-release.yml/dispatches'

type Recorded = { url: string; init: RequestInit }
type ReleaseModule = {
  buildDispatch: (
    versionType: string,
    token: string,
  ) => { url: string; init: RequestInit }
  triggerWorkflow: (
    versionType: string,
    fetchImpl?: typeof fetch,
    token?: string,
  ) => Promise<'dispatched' | 'failed'>
}

// The script is plain JS with `module.exports`, so it is required rather than
// imported: that is also exactly how it is loaded when run.
const release = require('../../scripts/release.js') as ReleaseModule

function recordingFetch(response: Response | (() => Promise<Response>)) {
  const calls: Recorded[] = []
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return typeof response === 'function' ? await response() : response
  }) as unknown as typeof fetch
  return { calls, impl }
}

async function withCapturedLog<T>(run: () => Promise<T>) {
  const lines: string[] = []
  const original = console.log
  console.log = (...parts: unknown[]) => {
    lines.push(parts.map((part) => String(part)).join(' '))
  }
  try {
    const result = await run()
    return { result, lines, text: lines.join('\n') }
  } finally {
    console.log = original
  }
}

describe('sdk buildDispatch', () => {
  test('the token travels in the Authorization header and nowhere else', () => {
    const { url, init } = release.buildDispatch('patch', TOKEN)
    const headers = init.headers as Record<string, string>

    expect(headers.Authorization).toBe(`token ${TOKEN}`)
    expect(url).toBe(DISPATCH_URL)
    expect(url).not.toContain(TOKEN)
    expect(init.body as string).not.toContain(TOKEN)
  })

  test('a hostile versionType stays JSON data, byte for byte', () => {
    const { init } = release.buildDispatch(HOSTILE, TOKEN)
    const body = init.body as string

    expect(() => JSON.parse(body)).not.toThrow()
    expect(
      (JSON.parse(body) as { inputs: { version_type: string } }).inputs
        .version_type,
    ).toBe(HOSTILE)
    // The wire body is the JSON, with the hostile value inside it untouched.
    // Nothing reinterprets that quote, because nothing between here and GitHub
    // is a shell. (JSON does not escape `'` — an earlier version of this test
    // claimed it did, and was simply wrong.)
    expect(body).toBe(`{"ref":"main","inputs":{"version_type":"${HOSTILE}"}}`)
  })

  test('a versionType with quotes in it is encoded, not concatenated', () => {
    const { init } = release.buildDispatch(HOSTILE_JSON, TOKEN)
    const body = init.body as string

    // String.raw because the expectation contains real backslashes, and a plain
    // template literal would swallow them.
    expect(body).toBe(
      String.raw`{"ref":"main","inputs":{"version_type":"1.2.3\"},\"extra\":\"1"}}`,
    )
    expect(
      (JSON.parse(body) as { inputs: { version_type: string } }).inputs
        .version_type,
    ).toBe(HOSTILE_JSON)
  })
})

describe('sdk triggerWorkflow', () => {
  test('a hostile versionType reaches the network as data and nothing else runs', async () => {
    const { calls, impl } = recordingFetch(new Response(null, { status: 204 }))

    const { result } = await withCapturedLog(() =>
      release.triggerWorkflow(HOSTILE, impl, TOKEN),
    )

    expect(result).toBe('dispatched')
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(DISPATCH_URL)
    expect(
      (
        JSON.parse(calls[0].init.body as string) as {
          inputs: { version_type: string }
        }
      ).inputs.version_type,
    ).toBe(HOSTILE)
  })

  test('204 means the workflow was dispatched', async () => {
    const { impl } = recordingFetch(new Response(null, { status: 204 }))

    const { result, text } = await withCapturedLog(() =>
      release.triggerWorkflow('patch', impl, TOKEN),
    )

    expect(result).toBe('dispatched')
    expect(text).toContain('🎉')
  })

  test('422 without the trigger is a failure that explains itself', async () => {
    const body = '{"message":"Workflow does not have workflow_dispatch trigger"}'
    const { impl } = recordingFetch(new Response(body, { status: 422 }))

    const { result, text } = await withCapturedLog(() =>
      release.triggerWorkflow('patch', impl, TOKEN),
    )

    expect(result).toBe('failed')
    expect(text).toContain('422')
    expect(text).toContain('workflow_dispatch')
    expect(text).not.toContain('🎉')
  })

  test('any other non-204 is a failure, not a celebration', async () => {
    const body = '{"message":"Bad credentials"}'
    const { impl } = recordingFetch(new Response(body, { status: 401 }))

    const { result, text } = await withCapturedLog(() =>
      release.triggerWorkflow('patch', impl, TOKEN),
    )

    expect(result).toBe('failed')
    expect(text).toContain('401')
    expect(text).toContain('Bad credentials')
    expect(text).not.toContain('🎉')
  })

  test('a thrown fetch is reported with its cause and does not crash', async () => {
    const impl = (async () => {
      throw new Error('getaddrinfo ENOTFOUND api.github.com')
    }) as unknown as typeof fetch

    const { result, text } = await withCapturedLog(() =>
      release.triggerWorkflow('patch', impl, TOKEN),
    )

    expect(result).toBe('failed')
    expect(text).toContain('ENOTFOUND')
    expect(text).not.toContain('🎉')
  })

  test('refuses to run without a token, and sends nothing', async () => {
    const savedCodebuff = process.env.CODEBUFF_GITHUB_TOKEN
    delete process.env.CODEBUFF_GITHUB_TOKEN
    // `error()` exits the process. Spying on it is the only way to observe the
    // refusal without killing the runner.
    const exit = spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`)
    }) as never)
    const originalError = console.error
    const errors: string[] = []
    console.error = (...parts: unknown[]) => {
      errors.push(parts.map((part) => String(part)).join(' '))
    }
    const { calls, impl } = recordingFetch(new Response(null, { status: 204 }))

    try {
      await expect(release.triggerWorkflow('patch', impl)).rejects.toThrow(
        'process.exit(1)',
      )
      // A refusal that still sends the dispatch is the bug wearing a fix's
      // clothes.
      expect(calls).toHaveLength(0)
      expect(errors.join('\n')).toContain('CODEBUFF_GITHUB_TOKEN')
    } finally {
      console.error = originalError
      exit.mockRestore()
      if (savedCodebuff !== undefined) {
        process.env.CODEBUFF_GITHUB_TOKEN = savedCodebuff
      }
    }
  })

  test('importing the module does not start a release', () => {
    // The require above already happened with no token in the environment; if
    // the guard were missing, that require would have exited the process.
    expect(typeof release.buildDispatch).toBe('function')
    expect(typeof release.triggerWorkflow).toBe('function')
  })
})
