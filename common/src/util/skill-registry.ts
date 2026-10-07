// the one place that speaks the skills.sh registry's http protocol; kept out of ThreadEngine so the engine stays an orchestrator over stores, mirroring how browser-check.ts isolates playwright

export interface SkillSearchResult {
  id: string
  name: string
  slug: string
  source: string
  installs: number
}

const REGISTRY_BASE = 'https://skills.sh'

// returns an empty list on any failure — discovery is best-effort; the empty-query "browse popular" list is curated client-side, so this only handles real queries
export async function searchRegistry(
  query: string,
): Promise<SkillSearchResult[]> {
  const q = query.trim()
  if (q.length < 2) return []
  try {
    // over-fetch a little so collapsing same-named skills still leaves ~10 rows
    const url = `${REGISTRY_BASE}/api/search?q=${encodeURIComponent(q)}&limit=16`
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) return []
    const data = (await res.json()) as { skills?: unknown[] }
    const sorted = (data.skills ?? [])
      .map((raw) => {
        const s = (raw ?? {}) as Record<string, unknown>
        return {
          id: String(s.id ?? ''),
          name: String(s.name ?? s.skillId ?? ''),
          slug: String(s.skillId ?? ''),
          source: String(s.source ?? ''),
          installs: Number(s.installs ?? 0),
        }
      })
      .filter((s) => s.slug && s.source)
      .sort((a, b) => b.installs - a.installs)
    // the registry returns the same skill name from multiple repos (e.g. two `docker-patterns`), which renders as near-duplicate rows
    const seen = new Set<string>()
    return sorted
      .filter((s) => !seen.has(s.name) && seen.add(s.name))
      .slice(0, 10)
  } catch {
    return []
  }
}

export interface DownloadedSkill {
  content: string
  files: { path: string; contents: string }[]
}

// unlike search, a failed download is worth interrupting the user for — so the recoverable causes
// throw a message that says what to do, and `null` is reserved for "the registry has no skill here".
// collapsing the two told a rate-limited user the skill did not exist, sending them to look for the
// wrong problem (the registry allows 60 downloads an hour, which a single browsing session can reach).
export class RegistryUnavailable extends Error {}

// main instructions are SKILL.md, else AGENTS.md, else any .md; sibling resources are retained so relative scripts/references in the instructions keep working
export async function downloadSkill(
  source: string,
  slug: string,
): Promise<DownloadedSkill | null> {
  const [owner, repo] = source.split('/')
  if (!owner || !repo || !slug) return null
  const url = `${REGISTRY_BASE}/api/download/${encodeURIComponent(owner)}/${encodeURIComponent(
    repo,
  )}/${encodeURIComponent(slug)}`

  let res: Response
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
  } catch (error) {
    throw new RegistryUnavailable(
      (error as { name?: string })?.name === 'TimeoutError'
        ? 'The skill registry took too long to respond. Try again in a moment.'
        : 'Could not reach the skill registry. Check your connection and try again.',
    )
  }

  if (res.status === 429) {
    throw new RegistryUnavailable(
      'The skill registry is rate limiting downloads from this machine. Try again in a few minutes.',
    )
  }
  // only a 404 is the registry saying the skill is not there; every other error status is its own problem
  if (res.status !== 404 && !res.ok) {
    throw new RegistryUnavailable(
      `The skill registry is unavailable right now (HTTP ${res.status}). Try again shortly.`,
    )
  }
  if (!res.ok) return null

  let data: { files?: unknown[] }
  try {
    data = (await res.json()) as { files?: unknown[] }
  } catch {
    throw new RegistryUnavailable(
      'The skill registry returned a malformed response.',
    )
  }

  // a `files` field of the wrong type is as good as no files — narrowing here is what lets the rest run untried
  const files = (Array.isArray(data.files) ? data.files : [])
    .filter(
      (raw): raw is Record<string, unknown> =>
        typeof raw === 'object' && raw !== null,
    )
    .filter(
      (file) =>
        typeof file.path === 'string' && typeof file.contents === 'string',
    )
    .map((file) => ({
      path: file.path as string,
      contents: file.contents as string,
    }))
  const pick =
    files.find((f) => /(^|\/)SKILL\.md$/i.test(f.path)) ??
    files.find((f) => /(^|\/)AGENTS\.md$/i.test(f.path)) ??
    files.find((f) => f.path.toLowerCase().endsWith('.md'))
  if (!pick) return null

  // registry paths are posix-style; if the selected instructions are nested, root the installed package at their directory and ignore unrelated files elsewhere in the response
  const slash = pick.path.lastIndexOf('/')
  const prefix = slash === -1 ? '' : pick.path.slice(0, slash + 1)
  const packageFiles = files
    .filter((file) => file.path.startsWith(prefix))
    .map((file) => ({ ...file, path: file.path.slice(prefix.length) }))
  return { content: pick.contents, files: packageFiles }
}
