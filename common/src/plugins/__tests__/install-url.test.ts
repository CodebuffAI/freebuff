import { describe, expect, test } from 'bun:test'

import { parsePluginSourceUrl } from '../install-url'

import type { ParsePluginSourceResult } from '../install-url'

/**
 * Asserts the parse succeeded, failing with the parser's reason otherwise,
 * and returns the source so tests assert on the coordinates, never on the
 * result's shape.
 */
function expectSourceOk(result: ParsePluginSourceResult) {
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(`expected ok, got: ${result.reason}`)
  return result.source
}

describe('plugin install URL parse', () => {
  /**
   * Given a GitHub URL in one of the accepted forms, when parsed, it
   * yields the repo coordinates the tarball fetch needs: owner, repo,
   * ref (default HEAD), and the plugin's subpath inside the repo.
   */
  test.each([
    {
      form: 'repo root',
      url: 'https://github.com/google/skills',
      want: { owner: 'google', repo: 'skills', ref: 'HEAD', subpath: null },
    },
    {
      form: 'trailing .git',
      url: 'https://github.com/google/skills.git',
      want: { owner: 'google', repo: 'skills', ref: 'HEAD', subpath: null },
    },
    {
      form: 'tree ref with subpath',
      url: 'https://github.com/google/skills/tree/main/plugins/cloud/google-cloud-developer',
      want: {
        owner: 'google',
        repo: 'skills',
        ref: 'main',
        subpath: 'plugins/cloud/google-cloud-developer',
      },
    },
    {
      form: 'tree ref without subpath',
      url: 'https://github.com/google/skills/tree/v1.1.2',
      want: { owner: 'google', repo: 'skills', ref: 'v1.1.2', subpath: null },
    },
    {
      form: 'plain subpath',
      url: 'https://github.com/google/skills/plugins/cloud/google-cloud-developer',
      want: {
        owner: 'google',
        repo: 'skills',
        ref: 'HEAD',
        subpath: 'plugins/cloud/google-cloud-developer',
      },
    },
  ])('$form → $want.repo @ $want.ref', ({ url, want }) => {
    const source = expectSourceOk(parsePluginSourceUrl(url))

    expect(source).toEqual(want)
  })

  /**
   * Given a URL that is not an https GitHub remote — another host, or an
   * ssh form — when parsed, it is rejected with the reason naming what is
   * unsupported, before any network work happens.
   */
  test.each([
    { case: 'another host', url: 'https://gitlab.com/google/skills' },
    { case: 'ssh remote', url: 'git@github.com:google/skills.git' },
    { case: 'no repo', url: 'https://github.com/google' },
  ])('$case → rejected', ({ url }) => {
    const result = parsePluginSourceUrl(url)

    expect(result.ok).toBe(false)
  })
})
