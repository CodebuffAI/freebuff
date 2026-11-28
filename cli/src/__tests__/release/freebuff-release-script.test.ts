import { describe, expect, spyOn, test } from 'bun:test'

import {
  buildDispatch,
  triggerWorkflow,
} from '../../../../freebuff/cli/release'

/**
 * THIS IS THE THIRD COPY of the release trigger, and it was missed by the sweep
 * that fixed the other two (`cli/scripts/release.ts`, `sdk/scripts/release.js`).
 * Both of those took `versionType` from argv; this one also takes `--ref`, and
 * it interpolated the whole JSON payload into a single-quoted shell word handed
 * to `execSync`. So a `'` in either argv value closed the quote and the rest of
 * the argument ran as a command — the same defect, one file over, with a second
 * way in.
 *
 * The defect is inferred from reading the old code rather than reproduced in a
 * shell here: the pre-fix construction was
 * `execSync("curl … -d '${payload}'")`, where `payload` is
 * `JSON.stringify({ref:'main',inputs:{version_type,checkout_ref}})` — a JSON
 * string containing `'` verbatim, because JSON has no reason to escape it.
 *
 * Mutations used to prove these tests can fail, each run 2026-11-26 and each
 * verified in the diff before the red was believed:
 *
 *  (a) move the token out of the header into the URL
 *      (`` `${DISPATCH_URL}?access_token=${token}` ``) → "token only in a
 *      header" goes red.
 *  (b) interpolate the body instead of `JSON.stringify`
 *      (`` `{"ref":"main","inputs":{"version_type":"${versionType}"}}` ``) →
 *      the quote-and-backslash case goes red.
 *  (c) drop `checkoutRef` from the inputs → "the ref reaches the body" goes red.
 *  (d) restore the old "does the response text contain workflow_dispatch"
 *      success test → the 401 case goes red, because that is a false 🎉.
 *  (e) remove the `import.meta.main` guard → this file dies at import, because
 *      with no token set `main()` calls `process.exit(1)`.
 */

const TOKEN = 'ghp_test_token_not_real'
// What used to break out of the `-d '…'` word.
const HOSTILE = "x'; rm -rf ~ #"
// What JSON.stringify must encode and interpolation cannot.
const HOSTILE_JSON = '1.2.3"},"extra":"1'
const DISPATCH_URL =
  'https://api.github.com/repos/CodebuffAI/freebuff-private/actions/workflows/freebuff-release.yml/dispatches'

type Recorded = { url: string; init: RequestInit }

function recordingFetch(response: Response | (() => Promise<Response>)) {
  const calls: Recorded[] = []
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return typeof response === 'function' ? response() : response
  }) as typeof fetch
  return { impl, calls }
}

describe('freebuff release dispatch, built as data', () => {
  test('the python-free request carries the token only in a header', () => {
    const { url, init } = buildDispatch('patch', '', TOKEN)

    expect(url).toBe(DISPATCH_URL)
    expect(String(url)).not.toContain(TOKEN)
    expect(init.headers).toMatchObject({ Authorization: `token ${TOKEN}` })
  })

  test('an argv value with a quote lands in the body verbatim', () => {
    const { init } = buildDispatch(HOSTILE_JSON, '', TOKEN)
    const body = JSON.parse(String(init.body))

    expect(body.inputs.version_type).toBe(HOSTILE_JSON)
  })

  test('the shell-metacharacter version survives without changing the request', () => {
    const { init } = buildDispatch(HOSTILE, '', TOKEN)
    const body = JSON.parse(String(init.body))

    expect(body.inputs.version_type).toBe(HOSTILE)
    expect(Object.keys(body.inputs)).toEqual(['version_type'])
  })

  test('the --ref value reaches the body, and is absent when not given', () => {
    expect(JSON.parse(String(buildDispatch('minor', 'abc123', TOKEN).init.body))).toEqual({
      ref: 'main',
      inputs: { version_type: 'minor', checkout_ref: 'abc123' },
    })
    expect(JSON.parse(String(buildDispatch('minor', '', TOKEN).init.body)).inputs).toEqual({
      version_type: 'minor',
    })
  })
})

describe('freebuff triggerWorkflow', () => {
  test('204 is the only success', async () => {
    const { impl } = recordingFetch(new Response('', { status: 204 }))
    expect(await triggerWorkflow('patch', '', impl, TOKEN)).toBe('dispatched')
  })

  test('401 with an empty body is a failure, not a celebration', async () => {
    const { impl } = recordingFetch(new Response('', { status: 401 }))
    expect(await triggerWorkflow('patch', '', impl, TOKEN)).toBe('failed')
  })

  test('422 without the trigger is still a failure', async () => {
    const { impl } = recordingFetch(
      new Response(JSON.stringify({ message: 'Not Found' }), { status: 422 }),
    )
    expect(await triggerWorkflow('patch', '', impl, TOKEN)).toBe('failed')
  })

  test('a thrown fetch is reported with its cause and does not crash', async () => {
    const log = spyOn(console, 'log').mockImplementation(() => {})
    const { impl } = recordingFetch(() =>
      Promise.reject(new Error('ECONNREFUSED 140.82.121.6:443')),
    )
    const outcome = await triggerWorkflow('patch', '', impl, TOKEN)
    const printed = log.mock.calls.map((call) => call.join(' ')).join('\n')
    log.mockRestore()

    expect(outcome).toBe('failed')
    expect(printed).toContain('ECONNREFUSED 140.82.121.6:443')
  })

  test('refuses to run without a token, and sends nothing', async () => {
    const exit = spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`)
    }) as never)
    const { impl, calls } = recordingFetch(new Response('', { status: 204 }))

    await expect(triggerWorkflow('patch', '', impl, undefined)).rejects.toThrow(
      'exit 1',
    )
    exit.mockRestore()

    expect(calls).toEqual([])
  })

  test('importing this module does not start a release', () => {
    // If the import had run `main()`, the missing-token branch would have
    // exited this test process before this line.
    expect(typeof buildDispatch).toBe('function')
  })
})
