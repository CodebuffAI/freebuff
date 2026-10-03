import { readUrl } from '../../sdk/src/tools/read-url'

import type { CodebuffClient } from '@codebuff/sdk'

type OverrideTools = NonNullable<
  Parameters<CodebuffClient['run']>[0]['overrideTools']
>

/**
 * The evaluated repository's upstream is off limits during a task.
 *
 * Every buffbench task is a real commit, and its ground truth is one HTTP
 * request away: in the 2026-09-26/27 runs the base3 arm read the upstream
 * commit from GitHub in 4-6 of 10 tasks per run, reproduced it byte for byte,
 * and was scored 10 for it. That measures the fetch, not the agent. The
 * `read_url` tool runs on the client, so the bench substitutes a handler that
 * refuses the repository's own hosts and paths and delegates everything else
 * to the SDK's implementation. `web_search` runs server-side and returns
 * snippets only; a snippet cannot be applied as a diff.
 *
 * Blocked, for a repo at github.com/<owner>/<name>: any URL whose host or
 * path carries the owner or the repo name as a token. That covers the repo
 * on github.com, raw.githubusercontent.com, api.github.com and codeload
 * under ANY owner (a fork or a guessed owner carries the same files), the
 * npm scope that shares the repo's name (@<name>/…) on unpkg, jsDelivr,
 * npmjs.com and the registry, and the project's own documentation sites
 * (<name>.com/docs, <owner>-<name>.mintlify.app), which document the API as
 * it exists AFTER the evaluated commit — the 2026-09-29 baseline saw base3
 * read the current SDK docs for a task whose ground truth was that API.
 */
export function benchToolOverrides(params: { repoUrl: string }): OverrideTools {
  const { owner, name } = parseGitHubRepo(params.repoUrl)
  const tokens = [owner, name]
    .filter((t): t is string => !!t)
    .map((t) => t.toLowerCase())
  const isBlocked = (raw: string): boolean => isUpstreamUrl(raw, tokens)

  return {
    read_url: async (input: { url: string; max_chars?: number }) => {
      if (isBlocked(input.url)) {
        return [
          {
            type: 'json' as const,
            value: {
              url: input.url,
              errorMessage:
                `This benchmark does not allow reading the evaluated repository's upstream ` +
                `(${owner}/${name} on GitHub or its published packages). Work from the checkout in front of you.`,
            },
          },
        ]
      }
      return readUrl(input)
    },
  }
}

function parseGitHubRepo(repoUrl: string): { owner?: string; name?: string } {
  const m = repoUrl.match(
    /github\.com[/:]([^/]+)\/([^/#?]+?)(?:\.git)?(?:[/#?].*)?$/i,
  )
  return m ? { owner: m[1], name: m[2] } : {}
}

/**
 * Does `raw` point at the evaluated repository or its published forms? A
 * token (the owner or the repo name, lower-cased) matches the host
 * (codebuff.com, codebuffai-codebuff.mintlify.app) or a WORD inside a path
 * segment (/codebuffai/codebuff, /@codebuff/sdk, /repos/codebuff/codebuff,
 * /syntax-syndicate/codebuff-v0). Words are delimited by . - _ so that an
 * unrelated host's /docs/codebuffer/ does not trip it while a fork mirror
 * renamed <name>-v0 does: in the 2026-09-29 22:13 run base3 found such a
 * mirror through web_search, walked its commit history for the task's own
 * files through api.github.com (36 reads, none refused because the segment
 * had to equal the token) and was scored 10 on that task.
 */
export function isUpstreamUrl(raw: string, tokens: string[]): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  const host = url.hostname.toLowerCase()
  const path = decodeURIComponent(url.pathname).toLowerCase()
  const segments = path.split(/[/@]/).filter(Boolean)
  return tokens.some(
    (t) =>
      host === t + '.com' ||
      host.endsWith('.' + t + '.com') ||
      host.split(/[.-]/).includes(t) ||
      segments.some((seg) => seg.split(/[.\-_]/).includes(t)),
  )
}
