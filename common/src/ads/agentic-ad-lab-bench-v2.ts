import {
  LAB_BENCH,
  type LabBenchFacets,
  type LabBenchRepository,
} from './agentic-ad-lab-bench'

/**
 * Bench-v2: the skill eval bench's POOL, about the production repository mix
 * (project-profile snapshot of 2026-10-08: TS 41%, Python 32%, JS 31%), with
 * the package managers each ecosystem really uses (npm/pnpm/yarn/bun,
 * pip/uv/poetry), other-language and empty-folder controls, and five local
 * fixtures for shapes no public repository has (no git, Windows line endings).
 *
 * Every entry is tagged `core` or `extended` (Owen, 2026-10-14: a big pool, not
 * run all the time):
 * - the static oracle (`agentic-bench-oracle.ts`) covers all of it × 3 OS;
 * - live runs (Lab and Desktop legs) use `core` only;
 * - `extended` runs live only in the weekly sweep and when a skill is seeded.
 *
 * bench-v1 (`LAB_BENCH`) stays frozen. An entry here that names a v1
 * repository carries the v1 commit, so a tester's lab holds it once.
 *
 * Never edit an entry in place: a pinned commit is what makes two receipts
 * comparable. Facets are what `scripts/lib/bench-facets.ts` detects at the
 * pin; `bun scripts/agentic-ad-lab-bench-verify.ts --bench=v2` re-checks them,
 * and `--propose <owner/name>` prints a new entry.
 */
export const LAB_BENCH_V2_VERSION = 'bench-v2'

export type LabBenchV2Language =
  | LabBenchFacets['language']
  | 'php'
  | 'java'
  | 'rust'
  | 'csharp'
  | 'none'

export type LabBenchV2PythonFramework =
  | 'fastapi'
  | 'django'
  | 'flask'
  | 'streamlit'
  | 'gradio'
  | 'none'

export type LabBenchV2Facets = Omit<LabBenchFacets, 'language'> & {
  language: LabBenchV2Language
  /** uv.lock → uv; poetry.lock or [tool.poetry] → poetry; any other Python manifest → pip. */
  pythonManager: 'pip' | 'uv' | 'poetry' | 'none'
  pythonFramework: LabBenchV2PythonFramework
  /** An LLM SDK (openai, anthropic, langchain…) in any manifest. */
  llmSdk: boolean
  /** A root package.json: what Desktop's legacy V1 fit facts key on. */
  rootPackageJson: boolean
  monorepo: 'none' | 'workspaces' | 'turbo' | 'nx'
  /** `convex` in any package.json: a backend that is neither Node nor Postgres. */
  convex: boolean
}

export const LAB_BENCH_V2_BUCKETS = [
  'nextjs',
  'react-vite',
  'node-api',
  'frontend-control',
  'js-monorepo',
  'supabase',
  'fastapi',
  'django',
  'flask',
  'python-llm',
  'python-script',
  'polyglot',
  'other-language',
  'static-html',
  'fixture',
] as const
export type LabBenchV2Bucket = (typeof LAB_BENCH_V2_BUCKETS)[number]

export type LabBenchV2Tier = 'core' | 'extended'

type V2Common = {
  /** Stable cell key: lowercased `owner/name`, or `fixture/<name>`. */
  key: string
  bucket: LabBenchV2Bucket
  tier: LabBenchV2Tier
  facets: LabBenchV2Facets
  why: string
}

/** What every bench version's GitHub entry has: a name, a pin, a former name. */
export type LabBenchPin = Pick<
  LabBenchRepository,
  'fullName' | 'commit' | 'formerly'
>

export type LabBenchV2Repository = V2Common & LabBenchPin & { kind: 'github' }

/**
 * A local fixture under `evals/sponsored/bench-fixtures/<name>/`. Desktop legs
 * and the static oracle use it; the Lab, which adds only public GitHub
 * repositories, never does.
 */
export type LabBenchV2Fixture = V2Common & {
  kind: 'fixture'
  name: string
  /** none: a plain folder; init: `git init`, no commit; commit: one commit of the files. */
  git: 'none' | 'init' | 'commit'
  /** crlf: text files are written with CRLF, as a Windows checkout has them. */
  lineEndings: 'lf' | 'crlf'
}

export type LabBenchV2Entry = LabBenchV2Repository | LabBenchV2Fixture

const gh = (
  fullName: string,
  commit: string,
  bucket: LabBenchV2Bucket,
  tier: LabBenchV2Tier,
  facets: LabBenchV2Facets,
  why: string,
  formerly?: string,
): LabBenchV2Repository => ({
  kind: 'github',
  key: fullName.toLowerCase(),
  fullName,
  commit,
  bucket,
  tier,
  facets,
  why,
  ...(formerly ? { formerly } : {}),
})

const fixture = (
  name: string,
  git: LabBenchV2Fixture['git'],
  lineEndings: LabBenchV2Fixture['lineEndings'],
  tier: LabBenchV2Tier,
  facets: LabBenchV2Facets,
  why: string,
): LabBenchV2Fixture => ({
  kind: 'fixture',
  key: `fixture/${name}`,
  name,
  git,
  lineEndings,
  bucket: 'fixture',
  tier,
  facets,
  why,
})

/** Facet shorthand: the defaults of a repository with nothing in it. */
const f = (facets: Partial<LabBenchV2Facets>): LabBenchV2Facets => ({
  framework: 'unknown',
  packageManager: 'unknown',
  language: 'none',
  pythonManager: 'none',
  pythonFramework: 'none',
  llmSdk: false,
  rootPackageJson: false,
  monorepo: 'none',
  convex: false,
  supabase: 'none',
  tests: false,
  ci: false,
  ...facets,
})

export const LAB_BENCH_V2: readonly LabBenchV2Entry[] = [
  // Next.js (8): npm 3, pnpm 2, bun 2, yarn 1.
  gh(
    'ixartz/Next-js-Boilerplate',
    'b83157a8018f55b926a3c25a4b7a7e14b0dfbc35',
    'nextjs',
    'core',
    f({
      framework: 'nextjs',
      packageManager: 'npm',
      language: 'typescript',
      rootPackageJson: true,
      tests: true,
      ci: true,
    }),
    'Next.js on npm: Clerk, drizzle, vitest, lint-staged hooks.',
  ),
  gh(
    'mckaywrigley/chatbot-ui',
    '81328b61d2a4ab597a7a057be70e785cf756d9f8',
    'nextjs',
    'extended',
    f({
      framework: 'nextjs',
      packageManager: 'npm',
      language: 'typescript',
      llmSdk: true,
      rootPackageJson: true,
      supabase: 'wired',
      tests: true,
    }),
    'Large Next.js app on npm with a committed Supabase project.',
  ),
  gh(
    'adrianhajdin/ai_saas_app',
    'f82bfdd03c97000eea0d7fada94a307e61b58b5f',
    'nextjs',
    'extended',
    f({
      framework: 'nextjs',
      packageManager: 'npm',
      language: 'typescript',
      rootPackageJson: true,
    }),
    'Small tutorial-shaped Next.js SaaS on npm, the stack beginners use.',
  ),
  gh(
    'nextjs/saas-starter',
    '6e33e58b1e553a41fe22e6b941a7229a002de361',
    'nextjs',
    'core',
    f({
      framework: 'nextjs',
      packageManager: 'pnpm',
      language: 'typescript',
      rootPackageJson: true,
    }),
    'Next.js on pnpm: drizzle, Stripe, its own auth.',
    'leerob/next-saas-starter',
  ),
  gh(
    'vercel/chatbot',
    'c2f8235e1f3ea903ad8b7f61447c4f74164b5c58',
    'nextjs',
    'extended',
    f({
      framework: 'nextjs',
      packageManager: 'pnpm',
      language: 'typescript',
      llmSdk: true,
      rootPackageJson: true,
      tests: true,
      ci: true,
    }),
    'AI chatbot template on pnpm with the packageManager field set.',
    'vercel/ai-chatbot',
  ),
  gh(
    'obro79/Rehabify',
    '76970da79f74c08bea7029817b832dd0008eea68',
    'nextjs',
    'extended',
    f({
      framework: 'nextjs',
      packageManager: 'bun',
      language: 'typescript',
      rootPackageJson: true,
      tests: true,
    }),
    'Large Next.js app on bun with drizzle.',
  ),
  gh(
    'Kiranism/next-shadcn-dashboard-starter',
    '7705dfc0d13889e45c26a55ad5908da6a7a9a605',
    'nextjs',
    'extended',
    f({
      framework: 'nextjs',
      packageManager: 'bun',
      language: 'typescript',
      llmSdk: true,
      rootPackageJson: true,
    }),
    'Popular shadcn dashboard starter on bun.',
  ),
  gh(
    'timlrx/tailwind-nextjs-starter-blog',
    'b45bef66b40c63b6f57c15ee8cd090682238df4c',
    'nextjs',
    'extended',
    f({
      framework: 'nextjs',
      packageManager: 'yarn',
      language: 'typescript',
      rootPackageJson: true,
      ci: true,
    }),
    'Content site on Yarn Berry, no backend.',
  ),
  // React on Vite (8, two on Convex): npm 3, pnpm 2, bun 2, yarn 1.
  gh(
    'obro79/ui-made-easy',
    '06e7a0cecf0e8d49be56d6ab1a655b4e94db8077',
    'react-vite',
    'extended',
    f({
      framework: 'react-vite',
      packageManager: 'npm',
      language: 'typescript',
      rootPackageJson: true,
      tests: true,
      ci: true,
    }),
    'Vite on npm with vitest, Playwright and CI.',
  ),
  gh(
    'michaelshimeles/react-starter-kit',
    '43ea558aa6fa47b444570450224baf02a66e9238',
    'react-vite',
    'extended',
    f({
      convex: true,
      framework: 'react-vite',
      packageManager: 'npm',
      language: 'typescript',
      llmSdk: true,
      rootPackageJson: true,
    }),
    'Convex on Vite (React Router), npm: a backend that is not Node or Postgres.',
  ),
  gh(
    'waynesutton/opensync',
    '030d4a55f8475b412ee8a9b072bcf55e721116f8',
    'react-vite',
    'extended',
    f({
      convex: true,
      framework: 'react-vite',
      packageManager: 'npm',
      language: 'typescript',
      llmSdk: true,
      rootPackageJson: true,
      ci: true,
    }),
    'Convex app on Vite, npm, with CI.',
  ),
  gh(
    'satnaing/shadcn-admin',
    'e16c87f213a5ba5e45964e9b67c792105ec74d26',
    'react-vite',
    'extended',
    f({
      framework: 'react-vite',
      packageManager: 'pnpm',
      language: 'typescript',
      rootPackageJson: true,
      tests: true,
      ci: true,
    }),
    'Frontend-only Vite dashboard on pnpm.',
  ),
  gh(
    'KhalfaniW/vite-bun-react',
    '38a10d05af3b24e26789aff436b4f5620ec5c4bb',
    'react-vite',
    'extended',
    f({
      framework: 'react-vite',
      packageManager: 'pnpm',
      language: 'typescript',
      rootPackageJson: true,
      tests: true,
    }),
    'Small Vite React app on pnpm with tests.',
  ),
  gh(
    'sagaban/playing-with-react-vite-bun',
    '1205ecf2d6b66a2466df737f2506a0cafe7686bd',
    'react-vite',
    'core',
    f({
      framework: 'react-vite',
      packageManager: 'bun',
      language: 'typescript',
      rootPackageJson: true,
      ci: true,
    }),
    'Vite React app on bun with CI.',
  ),
  gh(
    'AppChainAI/Jevatar',
    '9ddc924a4a5c25293ccbb498a5475da7ce246cf4',
    'react-vite',
    'extended',
    f({
      framework: 'react-vite',
      packageManager: 'bun',
      language: 'typescript',
      rootPackageJson: true,
      tests: true,
    }),
    'Small Vite React app on bun with tests.',
  ),
  gh(
    'minimal-ui-kit/material-kit-react',
    '69e780a40c455d664b2e13c525faf1d492a072a7',
    'react-vite',
    'core',
    f({
      framework: 'react-vite',
      packageManager: 'yarn',
      language: 'typescript',
      rootPackageJson: true,
    }),
    'Popular MUI admin kit on Vite and Yarn.',
  ),
  // Node APIs (6): Express, Fastify, Hono; npm 3 (one plain CommonJS), yarn, pnpm, bun.
  gh(
    'gothinkster/node-express-realworld-example-app',
    '30b68e1e881462b2f4164ea09ab4c4f5699c7b0b',
    'node-api',
    'core',
    f({
      framework: 'nodejs',
      packageManager: 'npm',
      language: 'typescript',
      rootPackageJson: true,
      monorepo: 'nx',
      tests: true,
    }),
    'Express API in TypeScript on npm and Prisma.',
  ),
  gh(
    'madhums/node-express-mongoose-demo',
    '8a134ab5deeef553d6de51d91d4ed8ee378acace',
    'node-api',
    'core',
    f({
      framework: 'nodejs',
      packageManager: 'npm',
      language: 'javascript',
      rootPackageJson: true,
      tests: true,
      ci: true,
    }),
    'Plain CommonJS Express app on npm (require and use strict), Mongoose.',
  ),
  gh(
    'sahat/hackathon-starter',
    'd7a20cce5e41f45f14eaf400af874f86817aea0d',
    'node-api',
    'extended',
    f({
      framework: 'nodejs',
      packageManager: 'npm',
      language: 'javascript',
      llmSdk: true,
      rootPackageJson: true,
      tests: true,
      ci: true,
    }),
    'Large Express app on npm with OpenAI and many integrations.',
  ),
  gh(
    'hagopj13/node-express-boilerplate',
    '179ae84efec61b14206d0305d941daed6c6d07f9',
    'node-api',
    'extended',
    f({
      framework: 'nodejs',
      packageManager: 'yarn',
      language: 'javascript',
      rootPackageJson: true,
      tests: true,
    }),
    'Express API in plain JavaScript on Yarn classic.',
  ),
  gh(
    'PedroClerici/fastify-api-boilerplate',
    'dfa932159006e5171fd87dee339a12430eb35961',
    'node-api',
    'core',
    f({
      framework: 'nodejs',
      packageManager: 'pnpm',
      language: 'typescript',
      rootPackageJson: true,
      tests: true,
    }),
    'Fastify API in TypeScript on pnpm.',
  ),
  gh(
    'nirnejak/hono-bun-starter',
    'cbc175f3e51bd11f93906b46a6ddf13c049defad',
    'node-api',
    'extended',
    f({
      framework: 'unsupported',
      packageManager: 'bun',
      language: 'typescript',
      rootPackageJson: true,
      ci: true,
    }),
    'Hono API on bun, a framework the Desktop detector does not know.',
  ),
  // Vue, Svelte and Angular controls (3).
  gh(
    'sveltejs/realworld',
    'df796708040f5200ec572b28ab7f88ecee5794dd',
    'frontend-control',
    'extended',
    f({
      framework: 'unsupported',
      packageManager: 'pnpm',
      language: 'javascript',
      rootPackageJson: true,
      monorepo: 'workspaces',
    }),
    'SvelteKit app on pnpm.',
  ),
  gh(
    'bradtraversy/vue-crash-2021',
    'f2b2def85b1e461da7e0853d620f4d2d7d333328',
    'frontend-control',
    'core',
    f({
      framework: 'unsupported',
      packageManager: 'npm',
      language: 'javascript',
      rootPackageJson: true,
    }),
    'Vue 3 app on npm: a JS repository no React or Node skill fits.',
  ),
  gh(
    'bradtraversy/angular-crash-2021',
    'c1fd7b0ebf60279f9c37ae770b8427947bb43a80',
    'frontend-control',
    'extended',
    f({
      framework: 'unsupported',
      packageManager: 'npm',
      language: 'typescript',
      rootPackageJson: true,
      tests: true,
    }),
    'Angular app on npm.',
  ),
  // JS monorepos, the app in a subfolder (4): pnpm + Turborepo ×2, Nx, bun workspaces.
  gh(
    't3-oss/create-t3-turbo',
    '8f945b7bb3bfb3ca8358d48b1ff0214079bc11ee',
    'js-monorepo',
    'core',
    f({
      framework: 'unsupported',
      packageManager: 'pnpm',
      language: 'typescript',
      rootPackageJson: true,
      monorepo: 'turbo',
      ci: true,
    }),
    'pnpm + Turborepo monorepo, apps under apps/.',
  ),
  gh(
    'steven-tey/novel',
    'fa95098e66476c466faebb8211baa5869c101a9c',
    'js-monorepo',
    'extended',
    f({
      framework: 'unsupported',
      packageManager: 'pnpm',
      language: 'typescript',
      llmSdk: true,
      rootPackageJson: true,
      monorepo: 'turbo',
      ci: true,
    }),
    'pnpm + Turborepo monorepo: an editor package and a Next.js app.',
  ),
  gh(
    'stefanoslig/angular-ngrx-nx-realworld-example-app',
    'bc7158d61319b6748b94cef301dc347efcc23f00',
    'js-monorepo',
    'extended',
    f({
      framework: 'unsupported',
      packageManager: 'npm',
      language: 'typescript',
      rootPackageJson: true,
      monorepo: 'nx',
      tests: true,
    }),
    'Nx monorepo (Angular, npm).',
  ),
  gh(
    'kriasoft/react-starter-kit',
    'dbdb0d4991bbaae1671ff62180089f2733dd406a',
    'js-monorepo',
    'extended',
    f({
      framework: 'react-vite',
      packageManager: 'bun',
      language: 'typescript',
      rootPackageJson: true,
      monorepo: 'workspaces',
      tests: true,
      ci: true,
    }),
    'bun workspaces monorepo with Vite and Hono apps.',
  ),
  // The four Supabase scenario repositories, at their v1 commits.
  gh(
    'obro79/Continuum',
    '89857ee8d15c97571ed7411b24ef72b75754ec60',
    'supabase',
    'extended',
    f({
      framework: 'nextjs',
      packageManager: 'npm',
      language: 'typescript',
      rootPackageJson: true,
      supabase: 'client',
    }),
    'Supabase scenario: database activation.',
  ),
  gh(
    'obro79/stormhacks',
    '81789291b9790159e20d62c11a3a75f8fb966fba',
    'supabase',
    'extended',
    f({
      framework: 'nextjs',
      packageManager: 'npm',
      language: 'typescript',
      rootPackageJson: true,
      supabase: 'client',
    }),
    'Supabase scenario: server Auth.',
  ),
  gh(
    'obro79/blind-hunt',
    '46c84f23ec6779890ba61162d6704c4ea5855bde',
    'supabase',
    'extended',
    f({
      framework: 'nextjs',
      packageManager: 'npm',
      language: 'typescript',
      rootPackageJson: true,
      supabase: 'client',
    }),
    'Supabase scenario: Auth and Storage.',
  ),
  gh(
    'obro79/promptetheus-service',
    '1088e1af9859b9201a83bc2d838a9e748af2fcc6',
    'supabase',
    'extended',
    f({
      packageManager: 'pnpm',
      language: 'typescript',
      monorepo: 'workspaces',
      tests: true,
      ci: true,
    }),
    'Supabase scenario: RLS testing, a pnpm workspace with no root package.json.',
  ),
  // FastAPI (5): pip 2, uv 2, Poetry 1.
  gh(
    'testdrivenio/fastapi-tdd-docker',
    '16433b6621e9afd801de8eba9738a6bfefb1f601',
    'fastapi',
    'core',
    f({
      language: 'python',
      pythonManager: 'pip',
      pythonFramework: 'fastapi',
      tests: true,
      ci: true,
    }),
    'FastAPI on requirements.txt with pytest and CI.',
  ),
  gh(
    'testdrivenio/fastapi-crud-async',
    '4fa7ae952ece61e228135285de1b6a5ff65a1dc8',
    'fastapi',
    'extended',
    f({
      language: 'python',
      pythonManager: 'pip',
      pythonFramework: 'fastapi',
      tests: true,
    }),
    'Async FastAPI CRUD on requirements.txt.',
  ),
  gh(
    'astral-sh/uv-fastapi-example',
    'a1e313147b9be055167fe500d457d7c0b2f51318',
    'fastapi',
    'core',
    f({ language: 'python', pythonManager: 'uv', pythonFramework: 'fastapi' }),
    'FastAPI on uv, the example from the uv authors.',
  ),
  gh(
    'rednafi/fastapi-nano',
    '6f4e90ba4b0ee1dedd65502aca75de1ae0fd656f',
    'fastapi',
    'extended',
    f({
      language: 'python',
      pythonManager: 'uv',
      pythonFramework: 'fastapi',
      tests: true,
      ci: true,
    }),
    'FastAPI template on uv with tests and CI.',
  ),
  gh(
    'nsidnev/fastapi-realworld-example-app',
    '029eb7781c60d5f563ee8990a0cbfb79b244538c',
    'fastapi',
    'extended',
    f({
      language: 'python',
      pythonManager: 'poetry',
      pythonFramework: 'fastapi',
      tests: true,
      ci: true,
    }),
    'FastAPI RealWorld API on Poetry.',
  ),
  // Django (3): pip, Poetry, uv.
  gh(
    'gothinkster/django-realworld-example-app',
    '29c9d42831fa0cfc5a4aa7561f674396eacf20a2',
    'django',
    'extended',
    f({ language: 'python', pythonManager: 'pip', pythonFramework: 'django' }),
    'Django REST API on requirements.txt.',
  ),
  gh(
    'pedrosimiao/bookstore',
    'b54e33aa76b0609014fa83e72be5d21c94098d85',
    'django',
    'core',
    f({
      language: 'python',
      pythonManager: 'poetry',
      pythonFramework: 'django',
      tests: true,
      ci: true,
    }),
    'Django REST framework API on Poetry with CI.',
  ),
  gh(
    'wsvincent/djangox',
    '14c0374eaab52dc49898229ffe9a3e8f0e0e51c2',
    'django',
    'extended',
    f({
      language: 'python',
      pythonManager: 'uv',
      pythonFramework: 'django',
      tests: true,
    }),
    'Django starter on uv.',
  ),
  // Flask (2): pip.
  gh(
    'miguelgrinberg/microblog',
    'a975ef64864354867c88e0ed3a17ba7d17dca752',
    'flask',
    'core',
    f({
      language: 'python',
      pythonManager: 'pip',
      pythonFramework: 'flask',
      tests: true,
    }),
    'Flask app on requirements.txt with SQLAlchemy migrations.',
  ),
  gh(
    'mjhea0/flaskr-tdd',
    '305122f48823d98fd7fe8de989af2821b3c5d46d',
    'flask',
    'extended',
    f({
      language: 'python',
      pythonManager: 'pip',
      pythonFramework: 'flask',
      tests: true,
      ci: true,
    }),
    'Small Flask app on requirements.txt with tests and CI.',
  ),
  // Python LLM and agent apps (5): pip 2, uv 2, Poetry 1.
  gh(
    'streamlit/llm-examples',
    '7cf260745675e41f92e7436d3777aafdab9dad9f',
    'python-llm',
    'extended',
    f({
      language: 'python',
      pythonManager: 'pip',
      pythonFramework: 'streamlit',
      llmSdk: true,
      tests: true,
      ci: true,
    }),
    'Streamlit chat apps on OpenAI, requirements.txt.',
  ),
  gh(
    'openai/openai-quickstart-python',
    'ec8890d101bdc17d66512d94a76b5e7131d188a1',
    'python-llm',
    'core',
    f({
      language: 'python',
      pythonManager: 'pip',
      pythonFramework: 'flask',
      llmSdk: true,
    }),
    'The OpenAI Flask quickstart on requirements.txt.',
  ),
  gh(
    'langchain-ai/react-agent',
    '613fdaa91911713f969b58ab00d98581a989b702',
    'python-llm',
    'core',
    f({
      language: 'python',
      pythonManager: 'uv',
      llmSdk: true,
      tests: true,
      ci: true,
    }),
    'LangGraph ReAct agent template on uv.',
  ),
  gh(
    'langchain-ai/open_deep_research',
    '1b7d2e80db9faa586165c60e09096dbbfd483a64',
    'python-llm',
    'extended',
    f({
      supabase: 'client',
      language: 'python',
      pythonManager: 'uv',
      llmSdk: true,
      tests: true,
      ci: true,
    }),
    'LangGraph research agent on uv.',
  ),
  gh(
    'yoheinakajima/babyagi',
    'fa8930ebe72a82e5ad57b356e7cbec96290e5bb2',
    'python-llm',
    'extended',
    f({
      language: 'python',
      pythonManager: 'poetry',
      pythonFramework: 'flask',
      llmSdk: true,
    }),
    'Agent framework on Poetry with a Flask dashboard.',
  ),
  // Plain Python scripts (2): requirements.txt, and no manifest.
  gh(
    'openai/gpt-2',
    '9b63575ef42771a015060c964af2c3da4cf7c8ab',
    'python-script',
    'extended',
    f({ language: 'python', pythonManager: 'pip' }),
    'Research scripts with only a requirements.txt.',
  ),
  gh(
    'karpathy/nanoGPT',
    '3adf61e154c3fe3fca428ad6bc3818b27a3b8291',
    'python-script',
    'extended',
    f({ language: 'python' }),
    'Python scripts with no manifest at all.',
  ),
  // Polyglot: a Python API and a JS UI (2).
  gh(
    'fastapi/full-stack-fastapi-template',
    '7257e606cb94eada1dca40173e2b7f99dd549bc6',
    'polyglot',
    'core',
    f({
      framework: 'unsupported',
      packageManager: 'bun',
      language: 'polyglot',
      pythonManager: 'uv',
      rootPackageJson: true,
      monorepo: 'workspaces',
      tests: true,
      ci: true,
    }),
    'FastAPI backend on uv plus a React frontend, bun workspaces at the root.',
  ),
  gh(
    'assafelovic/gpt-researcher',
    '3582a6841fe7dc801e2a34e34ee408641aea9bce',
    'polyglot',
    'extended',
    f({
      language: 'polyglot',
      pythonManager: 'poetry',
      pythonFramework: 'fastapi',
      llmSdk: true,
      tests: true,
      ci: true,
    }),
    'Python agent on Poetry with a Next.js frontend in a subfolder.',
  ),
  // Other-language controls (4): Go, PHP/Laravel, Java/Spring, Rust.
  gh(
    'gothinkster/golang-gin-realworld-example-app',
    '626c372d259472148d93303f74aa9b9a1cdcef24',
    'other-language',
    'core',
    f({ language: 'go', tests: true, ci: true }),
    'Go API on Gin and GORM.',
  ),
  gh(
    'laravel/laravel',
    '9ffef3bc4241e3cc333ef267258a404d0d95f194',
    'other-language',
    'extended',
    f({
      framework: 'unsupported',
      language: 'php',
      rootPackageJson: true,
      tests: true,
      ci: true,
    }),
    'Laravel skeleton: PHP with a root package.json for Vite.',
  ),
  gh(
    'spring-projects/spring-petclinic',
    '500158f732419217507c7656904b8e6aa1bcc0d6',
    'other-language',
    'extended',
    f({ language: 'java', tests: true, ci: true }),
    'Spring Boot app on Maven and Gradle.',
  ),
  gh(
    'launchbadge/realworld-axum-sqlx',
    'f1b25654773228297e35c292f357d33b7121a101',
    'other-language',
    'extended',
    f({ language: 'rust', ci: true }),
    'Rust API on axum and sqlx.',
  ),
  // Static HTML (1).
  gh(
    'bradtraversy/50projects50days',
    'c92b0bc3a87fc95d44b89552b7b6a2eeb36ca481',
    'static-html',
    'extended',
    f({ language: 'html' }),
    'Static HTML, CSS and JavaScript pages, no toolchain.',
  ),
  // Local fixtures (evals/sponsored/bench-fixtures/): Desktop legs and the static oracle only.
  fixture(
    'empty-folder',
    'none',
    'lf',
    'core',
    f({}),
    'An empty folder with no git: the first thing a beginner opens.',
  ),
  fixture(
    'readme-only',
    'commit',
    'lf',
    'extended',
    f({}),
    'A repository holding only a README.',
  ),
  fixture(
    'git-no-commit',
    'init',
    'lf',
    'extended',
    f({ framework: 'nodejs', language: 'javascript', rootPackageJson: true }),
    '`git init` run and a small Node script written, nothing committed.',
  ),
  fixture(
    'windows-node',
    'commit',
    'crlf',
    'core',
    f({
      framework: 'nodejs',
      packageManager: 'npm',
      language: 'javascript',
      rootPackageJson: true,
    }),
    'An Express app as a Windows user has it: CRLF, a PowerShell setup script, an npm lockfile.',
  ),
  fixture(
    'windows-python',
    'commit',
    'crlf',
    'core',
    f({ language: 'python', pythonManager: 'pip', pythonFramework: 'fastapi' }),
    'A FastAPI app as a Windows user has it: CRLF, run.bat, requirements.txt, an untracked venv\\.',
  ),
]

export const labBenchV2Core = () =>
  LAB_BENCH_V2.filter((entry) => entry.tier === 'core')

export const labBenchV2Repositories = (
  entries: readonly LabBenchV2Entry[] = LAB_BENCH_V2,
) =>
  entries.filter(
    (entry): entry is LabBenchV2Repository => entry.kind === 'github',
  )

/** Whether a pinned entry's name is this one, now or before a rename. */
export const labBenchPinNamed = (entry: LabBenchPin, fullName: string) =>
  [entry.fullName, entry.formerly].some(
    (name) => name?.toLowerCase() === fullName.toLowerCase(),
  )

/** The `owner/name@commit` form the Lab's Add repository accepts. */
export const labBenchPinSpec = (entry: LabBenchPin) =>
  `${entry.fullName}@${entry.commit}`

/** A pinned GitHub entry of any bench version by name (or former name). */
export function labBenchAnyNamed(fullName: string): LabBenchPin | null {
  return (
    LAB_BENCH.find((entry) => labBenchPinNamed(entry, fullName)) ??
    labBenchV2Repositories().find((entry) =>
      labBenchPinNamed(entry, fullName),
    ) ??
    null
  )
}

/** A pinned GitHub entry of any bench version at exactly this commit. */
export function labBenchAnyEntry(
  fullName: string,
  commit: string | undefined,
): LabBenchPin | null {
  const entry = labBenchAnyNamed(fullName)
  return entry && commit && entry.commit === commit ? entry : null
}

export function labBenchV2Entry(key: string): LabBenchV2Entry | null {
  const lower = key.toLowerCase().replace(/@[0-9a-f]{40}$/, '')
  return (
    LAB_BENCH_V2.find(
      (entry) =>
        entry.key === lower ||
        (entry.kind === 'github' && labBenchPinNamed(entry, lower)),
    ) ?? null
  )
}
