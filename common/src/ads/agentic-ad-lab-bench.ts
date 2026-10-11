import type { SponsoredCapability } from './sponsored-capability'
import { summarizeLabBatch, type LabBatch } from './agentic-ad-lab-batch'

/**
 * The skill eval bench: a fixed set of public repositories, each pinned to a
 * commit, that the Agentic Ads Lab adds in one click and runs a batch across.
 * A skill or prompt change is scored on all of them before it ships, and two
 * batches are compared repository by repository (`compareLabBatches`).
 *
 * The set is chosen to cover the stacks the sponsored offer route sees, by
 * the same facets Desktop reports in its capability (`framework` and
 * `packageManager` here are what `frameworkFromRepo` and the Desktop
 * package-manager detector return for the pinned commit), plus the four
 * Supabase scenario repositories from `evals/sponsored/`. The capability's
 * framework and package manager are not logged in production, so the mix is a
 * judgement, not a measured distribution. The Lab runs on Linux Cloud VMs, so
 * there is no OS axis here.
 *
 * Never edit an entry in place: a pinned commit is what makes two batches
 * comparable. Add a new version of the bench instead.
 */
export const LAB_BENCH_VERSION = 'bench-v1'

export type LabBenchFacets = {
  framework: SponsoredCapability['framework']
  packageManager: SponsoredCapability['packageManager']
  language: 'typescript' | 'javascript' | 'python' | 'go' | 'html' | 'polyglot'
  /** none: no Supabase; client: SDK installed; wired: a `supabase/` project committed. */
  supabase: 'none' | 'client' | 'wired'
  tests: boolean
  ci: boolean
}

export type LabBenchRepository = {
  fullName: string
  /** Full 40-hex commit. Every chat on this repository starts here. */
  commit: string
  facets: LabBenchFacets
  why: string
}

const repo = (
  fullName: string,
  commit: string,
  facets: LabBenchFacets,
  why: string,
): LabBenchRepository => ({ fullName, commit, facets, why })

export const LAB_BENCH: readonly LabBenchRepository[] = [
  // The four pinned Supabase scenario repositories (evals/sponsored/scenarios).
  repo(
    'obro79/Continuum',
    '89857ee8d15c97571ed7411b24ef72b75754ec60',
    {
      framework: 'nextjs',
      packageManager: 'npm',
      language: 'typescript',
      supabase: 'client',
      tests: false,
      ci: false,
    },
    'Supabase scenario: database activation.',
  ),
  repo(
    'obro79/stormhacks',
    '81789291b9790159e20d62c11a3a75f8fb966fba',
    {
      framework: 'nextjs',
      packageManager: 'npm',
      language: 'typescript',
      supabase: 'client',
      tests: false,
      ci: false,
    },
    'Supabase scenario: server Auth.',
  ),
  repo(
    'obro79/blind-hunt',
    '46c84f23ec6779890ba61162d6704c4ea5855bde',
    {
      framework: 'nextjs',
      packageManager: 'npm',
      language: 'typescript',
      supabase: 'client',
      tests: false,
      ci: false,
    },
    'Supabase scenario: Auth and Storage.',
  ),
  repo(
    'obro79/promptetheus-service',
    '1088e1af9859b9201a83bc2d838a9e748af2fcc6',
    {
      framework: 'unknown',
      packageManager: 'pnpm',
      language: 'typescript',
      supabase: 'none',
      tests: true,
      ci: true,
    },
    'Supabase scenario: RLS testing. A pnpm workspace with no root package.json.',
  ),
  // Next.js, the most common stack the offer route admits.
  repo(
    'obro79/Rehabify',
    '76970da79f74c08bea7029817b832dd0008eea68',
    {
      framework: 'nextjs',
      packageManager: 'bun',
      language: 'typescript',
      supabase: 'none',
      tests: true,
      ci: false,
    },
    'Large Next.js app on bun with drizzle; default branch is prod.',
  ),
  repo(
    'leerob/next-saas-starter',
    '6e33e58b1e553a41fe22e6b941a7229a002de361',
    {
      framework: 'nextjs',
      packageManager: 'pnpm',
      language: 'typescript',
      supabase: 'none',
      tests: false,
      ci: false,
    },
    'Popular SaaS starter: drizzle on Postgres, Stripe, its own auth.',
  ),
  repo(
    'vercel/nextjs-subscription-payments',
    'bdd0813206e47e6b218d42f15a7976c8a0d3c3eb',
    {
      framework: 'nextjs',
      packageManager: 'pnpm',
      language: 'typescript',
      supabase: 'wired',
      tests: false,
      ci: false,
    },
    'Supabase already wired: a Supabase skill must notice there is nothing to add.',
  ),
  repo(
    'mckaywrigley/chatbot-ui',
    '81328b61d2a4ab597a7a057be70e785cf756d9f8',
    {
      framework: 'nextjs',
      packageManager: 'npm',
      language: 'typescript',
      supabase: 'wired',
      tests: true,
      ci: false,
    },
    'Large Next.js app with a committed Supabase project and migrations.',
  ),
  repo(
    'vercel/ai-chatbot',
    'c2f8235e1f3ea903ad8b7f61447c4f74164b5c58',
    {
      framework: 'nextjs',
      packageManager: 'pnpm',
      language: 'typescript',
      supabase: 'none',
      tests: true,
      ci: true,
    },
    'AI app template: next-auth, drizzle, Playwright, packageManager field set.',
  ),
  repo(
    'ixartz/Next-js-Boilerplate',
    'b83157a8018f55b926a3c25a4b7a7e14b0dfbc35',
    {
      framework: 'nextjs',
      packageManager: 'npm',
      language: 'typescript',
      supabase: 'none',
      tests: true,
      ci: true,
    },
    'Strict boilerplate: Clerk, drizzle, vitest, lint-staged hooks.',
  ),
  repo(
    'timlrx/tailwind-nextjs-starter-blog',
    'b45bef66b40c63b6f57c15ee8cd090682238df4c',
    {
      framework: 'nextjs',
      packageManager: 'yarn',
      language: 'typescript',
      supabase: 'none',
      tests: false,
      ci: true,
    },
    'Content site on Yarn Berry, no backend at all.',
  ),
  repo(
    'shadcn-ui/next-template',
    'd117bd0fd897cfd3b0d14e8647d8fcd6341a511b',
    {
      framework: 'nextjs',
      packageManager: 'unknown',
      language: 'typescript',
      supabase: 'none',
      tests: false,
      ci: false,
    },
    'Small fresh scaffold with no lockfile: the package manager must be chosen.',
  ),
  // React on Vite.
  repo(
    'obro79/ui-made-easy',
    '06e7a0cecf0e8d49be56d6ab1a655b4e94db8077',
    {
      framework: 'react-vite',
      packageManager: 'npm',
      language: 'typescript',
      supabase: 'none',
      tests: true,
      ci: true,
    },
    'Vite, vitest and Playwright with an existing CI workflow.',
  ),
  repo(
    'satnaing/shadcn-admin',
    'e16c87f213a5ba5e45964e9b67c792105ec74d26',
    {
      framework: 'react-vite',
      packageManager: 'pnpm',
      language: 'typescript',
      supabase: 'none',
      tests: true,
      ci: true,
    },
    'Frontend-only Vite dashboard: a backend skill has no server to attach to.',
  ),
  // Node.js servers and libraries.
  repo(
    'hagopj13/node-express-boilerplate',
    '179ae84efec61b14206d0305d941daed6c6d07f9',
    {
      framework: 'nodejs',
      packageManager: 'yarn',
      language: 'javascript',
      supabase: 'none',
      tests: true,
      ci: false,
    },
    'Express API in plain JavaScript on MongoDB, Yarn classic.',
  ),
  repo(
    'gothinkster/node-express-realworld-example-app',
    '30b68e1e881462b2f4164ea09ab4c4f5699c7b0b',
    {
      framework: 'nodejs',
      packageManager: 'npm',
      language: 'typescript',
      supabase: 'none',
      tests: true,
      ci: false,
    },
    'Express API on Prisma: a settled database provider.',
  ),
  repo(
    'CodebuffAI/stagehand',
    'a656128f95549d0e8545747d4381970e93239678',
    {
      framework: 'nodejs',
      packageManager: 'npm',
      language: 'typescript',
      supabase: 'none',
      tests: true,
      ci: true,
    },
    'Published TypeScript library with changesets and a release workflow.',
  ),
  // Stacks the route calls unsupported: a skill should decline cleanly or adapt.
  repo(
    't3-oss/create-t3-turbo',
    '8f945b7bb3bfb3ca8358d48b1ff0214079bc11ee',
    {
      framework: 'unsupported',
      packageManager: 'pnpm',
      language: 'typescript',
      supabase: 'none',
      tests: false,
      ci: true,
    },
    'Turborepo monorepo with Next.js and Expo apps under apps/.',
  ),
  repo(
    'alan2207/bulletproof-react',
    '9506629ed003a561c6627735480cce4994244bb4',
    {
      framework: 'unsupported',
      packageManager: 'unknown',
      language: 'typescript',
      supabase: 'none',
      tests: true,
      ci: true,
    },
    'Three separate apps in subfolders, nothing at the root.',
  ),
  repo(
    'sveltejs/realworld',
    'df796708040f5200ec572b28ab7f88ecee5794dd',
    {
      framework: 'unsupported',
      packageManager: 'pnpm',
      language: 'javascript',
      supabase: 'none',
      tests: false,
      ci: false,
    },
    'SvelteKit app.',
  ),
  repo(
    'fastapi/full-stack-fastapi-template',
    '7257e606cb94eada1dca40173e2b7f99dd549bc6',
    {
      framework: 'unsupported',
      packageManager: 'bun',
      language: 'polyglot',
      supabase: 'none',
      tests: true,
      ci: true,
    },
    'FastAPI backend plus a React frontend, Docker Compose, bun workspaces.',
  ),
  // No JavaScript manifest at all.
  repo(
    'obro79/cortex',
    '1509973ddb2431c6b63ac1a12028746d3b814717',
    {
      framework: 'unknown',
      packageManager: 'unknown',
      language: 'python',
      supabase: 'none',
      tests: true,
      ci: true,
    },
    'Python service on uv with pyproject and CI.',
  ),
  repo(
    'miguelgrinberg/microblog',
    'a975ef64864354867c88e0ed3a17ba7d17dca752',
    {
      framework: 'unknown',
      packageManager: 'unknown',
      language: 'python',
      supabase: 'none',
      tests: true,
      ci: false,
    },
    'Flask app on requirements.txt with SQLAlchemy migrations.',
  ),
  repo(
    'gothinkster/golang-gin-realworld-example-app',
    '626c372d259472148d93303f74aa9b9a1cdcef24',
    {
      framework: 'unknown',
      packageManager: 'unknown',
      language: 'go',
      supabase: 'none',
      tests: true,
      ci: true,
    },
    'Go API on Gin and GORM.',
  ),
  repo(
    'bradtraversy/50projects50days',
    'c92b0bc3a87fc95d44b89552b7b6a2eeb36ca481',
    {
      framework: 'unknown',
      packageManager: 'unknown',
      language: 'html',
      supabase: 'none',
      tests: false,
      ci: false,
    },
    'Static HTML, CSS and JavaScript pages: the beginner project with no toolchain.',
  ),
]

/** The `owner/name@commit` form the Lab's Add repository accepts. */
export const labBenchSpec = (entry: LabBenchRepository) =>
  `${entry.fullName}@${entry.commit}`

export function labBenchEntry(
  fullName: string,
  commit: string | undefined,
): LabBenchRepository | null {
  if (!commit) return null
  return (
    LAB_BENCH.find(
      (entry) =>
        entry.fullName.toLowerCase() === fullName.toLowerCase() &&
        entry.commit === commit,
    ) ?? null
  )
}

type Tally = { graded: number; perfect: number }
const rate = (t: Tally) => (t.graded ? t.perfect / t.graded : null)

function repoTallies(batch: LabBatch) {
  const tallies = new Map<string, Tally>()
  for (const r of batch.repositories)
    tallies.set(r.projectId, { graded: 0, perfect: 0 })
  for (const run of batch.runs) {
    const tally = tallies.get(run.projectId)
    if (!tally || !run.grade) continue
    tally.graded++
    if (run.grade.tier === 'perfect') tally.perfect++
  }
  return tallies
}

export type LabBenchFacetRow = {
  facet: 'framework' | 'packageManager' | 'language' | 'supabase'
  value: string
  repositories: number
  graded: number
  perfect: number
  perfectRate: number | null
}

/**
 * Perfect rate per stack facet over the batch's bench repositories. A
 * repository that is not a pinned bench entry is left out, so a row always
 * means the same code.
 */
export function labBatchFacetBreakdown(batch: LabBatch): LabBenchFacetRow[] {
  const tallies = repoTallies(batch)
  const rows = new Map<string, LabBenchFacetRow>()
  for (const r of batch.repositories) {
    const entry = labBenchEntry(r.fullName, r.commit)
    if (!entry) continue
    const tally = tallies.get(r.projectId)!
    for (const facet of [
      'framework',
      'packageManager',
      'language',
      'supabase',
    ] as const) {
      const value = String(entry.facets[facet])
      const key = `${facet}:${value}`
      const row = rows.get(key) ?? {
        facet,
        value,
        repositories: 0,
        graded: 0,
        perfect: 0,
        perfectRate: null,
      }
      row.repositories++
      row.graded += tally.graded
      row.perfect += tally.perfect
      row.perfectRate = rate(row)
      rows.set(key, row)
    }
  }
  return [...rows.values()]
}

export type LabBatchRepoChange = {
  fullName: string
  commit: string | null
  base: Tally & { perfectRate: number | null }
  next: Tally & { perfectRate: number | null }
  change: 'regressed' | 'improved' | 'same' | 'unmeasured'
}

export type LabBatchComparison = {
  /**
   * pass: same repositories at the same commits and setup, every planned run
   * graded on both sides, and no repository's perfect rate went down.
   * regressed: comparable, and at least one repository went down.
   * incomparable: the two batches did not test the same thing, or a run is
   * still ungraded; `reasons` says which.
   */
  verdict: 'pass' | 'regressed' | 'incomparable'
  reasons: string[]
  repositories: LabBatchRepoChange[]
  base: { perfectRate: number | null; graded: number }
  next: { perfectRate: number | null; graded: number }
}

const repoKey = (r: { fullName: string; commit?: string }) =>
  `${r.fullName.toLowerCase()}@${r.commit ?? 'unpinned'}`

/**
 * The gate a skill or prompt change passes before it ships: the new batch
 * (`next`) must do at least as well as the old one (`base`) on every
 * repository, not just on average, so a fix for one stack cannot quietly
 * break another.
 */
export function compareLabBatches(
  base: LabBatch,
  next: LabBatch,
): LabBatchComparison {
  const reasons: string[] = []
  const baseKeys = new Set(base.repositories.map(repoKey))
  const nextKeys = new Set(next.repositories.map(repoKey))
  const missing = [...baseKeys].filter((key) => !nextKeys.has(key))
  const added = [...nextKeys].filter((key) => !baseKeys.has(key))
  if (missing.length)
    reasons.push(`Not run in the new batch: ${missing.join(', ')}`)
  if (added.length)
    reasons.push(`Not run in the old batch: ${added.join(', ')}`)
  const unpinned = [...base.repositories, ...next.repositories].filter(
    (r) => !r.commit,
  )
  if (unpinned.length)
    reasons.push(
      `Not pinned to a commit, so the code may differ: ${[...new Set(unpinned.map((r) => r.fullName))].join(', ')}`,
    )
  if (base.environment !== next.environment)
    reasons.push(
      `Different environments: ${base.environment} and ${next.environment}`,
    )
  if (base.signup !== next.signup)
    reasons.push(`Different signup answers: ${base.signup} and ${next.signup}`)
  const baseSummary = summarizeLabBatch(base)
  const nextSummary = summarizeLabBatch(next)
  for (const [label, summary] of [
    ['old', baseSummary],
    ['new', nextSummary],
  ] as const)
    if (summary.graded < summary.planned)
      reasons.push(
        `The ${label} batch has ${summary.planned - summary.graded} ungraded run(s).`,
      )

  const baseTallies = repoTallies(base)
  const nextTallies = repoTallies(next)
  const nextByKey = new Map(next.repositories.map((r) => [repoKey(r), r]))
  const repositories: LabBatchRepoChange[] = base.repositories.map((r) => {
    const b = baseTallies.get(r.projectId)!
    const other = nextByKey.get(repoKey(r))
    const n = other
      ? nextTallies.get(other.projectId)!
      : { graded: 0, perfect: 0 }
    const br = rate(b)
    const nr = rate(n)
    return {
      fullName: r.fullName,
      commit: r.commit ?? null,
      base: { ...b, perfectRate: br },
      next: { ...n, perfectRate: nr },
      change:
        br === null || nr === null
          ? 'unmeasured'
          : nr < br
            ? 'regressed'
            : nr > br
              ? 'improved'
              : 'same',
    }
  })
  const regressed = repositories.some((r) => r.change === 'regressed')
  return {
    verdict: reasons.length ? 'incomparable' : regressed ? 'regressed' : 'pass',
    reasons,
    repositories,
    base: { perfectRate: baseSummary.perfectRate, graded: baseSummary.graded },
    next: { perfectRate: nextSummary.perfectRate, graded: nextSummary.graded },
  }
}
