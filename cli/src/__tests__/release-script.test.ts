import { describe, expect, spyOn, test } from 'bun:test'

import { buildDispatch, triggerWorkflow } from '../../scripts/release'

/**
 * The release script used to hand a shell string to `execSync`, with the GitHub
 * token and the `versionType` argv value interpolated into it. Two defects, both
 * reproduced before the change and both pinned below.
 *
 * Reproduced 2026-11-26, before any edit, by copying the old construction
 * verbatim into a scratch script:
 *
 *  - injection: `versionType = "x'; printf INJECTED > repro-injected.txt #"`
 *    under a POSIX shell (the platform a release is cut from) created that
 *    file. The single quote closed the `-d '…'` word and the rest of the
 *    argument ran as a command.
 *  - exposure: with the token in the command line, an unrelated process
 *    (powershell listing Win32_Process) found exactly one process exposing it.
 *    With the request-object form the same query found zero — the token stays
 *    inside this process's memory.
 *
 * Mutations used to prove these tests can fail, each run 2026-11-26 and each
 * verified in the diff before the red was believed:
 *
 *  (a) move the token from the header into the URL
 *      (`${DISPATCH_URL}?access_token=${token}`) → "token only in a header"
 *      goes red.
 *  (b) build `body` by interpolation instead of `JSON.stringify`
 *      (`{"ref":"main","inputs":{"version_type":"${versionType}"}}`) →
 *      the punctuation case goes red. IT DID NOT GO RED against the shell
 *      payload alone, and that is worth knowing: for
 *      `x'; rm -rf ~ #` the interpolated string and `JSON.stringify` output are
 *      byte-identical, because JSON never needed to escape a single quote. The
 *      first version of this file therefore could not see the mutation at all.
 *      The shell payload proves the value survives; only a value containing
 *      `"` or `\` proves the serialiser is doing the work.
 *  (c) restore the old "does the response text contain workflow_dispatch"
 *      success test → the 401 case goes red, because that is a false 🎉.
 *  (d) drop `(err as Error).message` from the catch → the thrown-fetch case
 *      goes red: the cause is what the maintainer needs.
 *  (e) remove the `import.meta.main` guard → this whole file dies at import,
 *      because with no token set the old `main()` called `process.exit(1)`.
 *  (f) make the missing-token branch return instead of exiting → "refuses to
 *      run without a token" goes red on the exit assertion, and the
 *      "nothing was sent" assertion is what proves it did not dispatch anyway.
 */

const TOKEN = 'ghp_test_token_not_real'
// The shell payload: what used to break the `-d '…'` word.
const HOSTILE = "x'; rm -rf ~ #"
// The JSON payload: what interpolation cannot encode. Needed because the two
// constructions above are identical for HOSTILE (see probe (b)).
const HOSTILE_JSON = '1.2.3"},"extra":"1'
const DISPATCH_URL =
  'https://api.github.com/repos/CodebuffAI/freebuff-private/actions/workflows/cli-release-prod.yml/dispatches'

type Recorded = { url: string; init: RequestInit }

function recordingFetch(response: Response | (() => Promise<Response>)) {
  const calls: Recorded[] = []
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return typeof response === 'function' ? await response() : response
  }) as unknown as typeof fetch
  return { calls, impl }
}

/** The script's only output is what it logs, so that is what gets asserted. */
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

describe('buildDispatch', () => {
  test('the token travels in the Authorization header and nowhere else', () => {
    const { url, init } = buildDispatch('patch', TOKEN)
    const headers = init.headers as Record<string, string>

    expect(headers.Authorization).toBe(`token ${TOKEN}`)
    expect(url).toBe(DISPATCH_URL)
    // Everything that could reach a URL, a log line or a process list.
    expect(url).not.toContain(TOKEN)
    expect(init.body as string).not.toContain(TOKEN)
  })

  test('a hostile versionType stays JSON data, byte for byte', () => {
    const { init } = buildDispatch(HOSTILE, TOKEN)
    const body = init.body as string

    expect(() => JSON.parse(body)).not.toThrow()
    expect(
      (JSON.parse(body) as { inputs: { version_type: string } }).inputs
        .version_type,
    ).toBe(HOSTILE)
    // The mechanism, exactly: the wire body is the JSON, with the hostile value
    // inside it untouched. Nothing reinterprets that quote, because nothing
    // between here and GitHub is a shell. (JSON does not escape `'` — an earlier
    // version of this test claimed it did, and was simply wrong.)
    expect(body).toBe(`{"ref":"main","inputs":{"version_type":"${HOSTILE}"}}`)
  })

  test('a versionType with quotes in it is encoded, not concatenated', () => {
    const { init } = buildDispatch(HOSTILE_JSON, TOKEN)
    const body = init.body as string

    // Built by interpolation this is `…"version_type":"1.2.3"},"extra":"1"}}`:
    // a different string, and not a document. That is the mutation this test
    // exists for.
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

describe('triggerWorkflow', () => {
  test('a hostile versionType reaches the network as data and nothing else runs', async () => {
    const { calls, impl } = recordingFetch(new Response(null, { status: 204 }))

    const { result } = await withCapturedLog(() =>
      triggerWorkflow(HOSTILE, impl, TOKEN),
    )

    expect(result).toBe('dispatched')
    // One request, and it is the dispatch: no shell, so no second process.
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
      triggerWorkflow('patch', impl, TOKEN),
    )

    expect(result).toBe('dispatched')
    expect(text).toContain('🎉')
  })

  test('422 without the trigger is a failure that explains itself', async () => {
    const body = '{"message":"Workflow does not have workflow_dispatch trigger"}'
    const { impl } = recordingFetch(new Response(body, { status: 422 }))

    const { result, text } = await withCapturedLog(() =>
      triggerWorkflow('patch', impl, TOKEN),
    )

    expect(result).toBe('failed')
    expect(text).toContain('422')
    expect(text).toContain('workflow_dispatch')
    expect(text).not.toContain('🎉')
  })

  test('any other non-204 is a failure, not a celebration', async () => {
    // The old code asked whether the body contained "workflow_dispatch". A 401
    // or a 500 never does, so it printed 🎉 and the maintainer believed a
    // release was running.
    const body = '{"message":"Bad credentials"}'
    const { impl } = recordingFetch(new Response(body, { status: 401 }))

    const { result, text } = await withCapturedLog(() =>
      triggerWorkflow('patch', impl, TOKEN),
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
      triggerWorkflow('patch', impl, TOKEN),
    )

    expect(result).toBe('failed')
    expect(text).toContain('ENOTFOUND')
    expect(text).not.toContain('🎉')
  })

  test('the token can come from the environment, as the script runs it', async () => {
    const saved = process.env.CODEBUFF_GITHUB_TOKEN
    process.env.CODEBUFF_GITHUB_TOKEN = TOKEN
    try {
      const { calls, impl } = recordingFetch(new Response(null, { status: 204 }))
      const { result } = await withCapturedLog(() =>
        triggerWorkflow('patch', impl),
      )

      expect(result).toBe('dispatched')
      expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(
        `token ${TOKEN}`,
      )
    } finally {
      if (saved === undefined) delete process.env.CODEBUFF_GITHUB_TOKEN
      else process.env.CODEBUFF_GITHUB_TOKEN = saved
    }
  })

  test('refuses to run without a token, and sends nothing', async () => {
    const savedCodebuff = process.env.CODEBUFF_GITHUB_TOKEN
    delete process.env.CODEBUFF_GITHUB_TOKEN
    // `error()` exits the process. Spying on it is the only way to observe the
    // refusal without killing the runner, which is what made this path untested
    // before: process.exit is not something a test can survive.
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
      await expect(triggerWorkflow('patch', impl)).rejects.toThrow(
        'process.exit(1)',
      )
      // The mechanism, not the return value: a refusal that still sends the
      // dispatch is the bug wearing a fix's clothes.
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

  test('importing the module does not start a release', async () => {
    const saved = process.env.CODEBUFF_GITHUB_TOKEN
    delete process.env.CODEBUFF_GITHUB_TOKEN
    try {
      // No token in the environment: the old `main().catch(...)` at the bottom
      // of the file ran on import and exited the process from here.
      const fresh = await import(`../../scripts/release.ts?fresh=${Date.now()}`)
      expect(typeof fresh.buildDispatch).toBe('function')
    } finally {
      if (saved !== undefined) process.env.CODEBUFF_GITHUB_TOKEN = saved
    }
  })
})
