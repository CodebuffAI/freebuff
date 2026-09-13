# Testing

- Prefer dependency injection over module mocking; define contracts in `common/src/types/contracts/`.
- Use `spyOn()` only for globals / legacy seams.
- Avoid `mock.module()` for functions; use `@codebuff/common/testing/mock-modules.ts` helpers for constants only.

CLI hook testing note: React 19 + Bun + RTL `renderHook()` is unreliable; prefer integration tests via components for hook behavior.

## Test env must come from a fixture, not the developer's `.env`

`@codebuff/common`'s `env.ts` validates the `NEXT_PUBLIC_*` vars at **import** time and throws, and Bun loads `.env` files from the process cwd — so a package-local `bun test` sees none of the repo-root env even when the root run is green. A whole test file then dies with `Invalid environment configuration` before a single test runs, which bun reports as an unhandled error rather than a failure, so the suite silently stops covering that file.

Every package must therefore have a `bunfig.toml` preloading `sdk/test/setup-env.ts` — the one shared fixture, which supplies placeholder values for every var the schemas require. This is not just a local-dev nicety: CI runs `cd <package> && bun test`, i.e. exactly the package-local mode. Placeholders only — tests must never need real credentials, so `bun test` means the same thing in a fresh worktree and in a provisioned checkout.

The unit-test matrix therefore never loads Infisical. This is a correctness boundary, not merely a secrets optimization: production rollout switches are mutable operational state, so importing them makes unrelated commits fail as soon as an operator changes a flag. Tests for non-default modes must set the specific variable in the test or inject the mode explicitly. Secret-bearing integration jobs remain separate.

The same rule covers generated inputs. `cli/src/agents/bundled-agents.generated.ts` is gitignored, and importing it at module scope wiped 17 files (~371 tests) in a fresh worktree; `cli/test/setup-agents-artifact.ts` now builds it on demand instead of relying on everyone knowing to run `bun run prebuild:agents`.

Tests that need a **service** rather than a variable should skip cleanly and say why, but never in CI. `@codebuff/internal/testing/test-db` probes Postgres once, skips the DB suites locally with the docker command to fix it, and throws when `CODEBUFF_GITHUB_ACTIONS=true` — otherwise a broken CI service container would read as a pass. Gate on **reachability**, never on `!process.env.DATABASE_URL`: the fixtures supply a placeholder URL, so presence stopped meaning availability.

Tests that spawn a server child should race readiness against `proc.exited` and report the child's captured output (see `freebuff-desktop/src/app/server.test.ts`). Polling a dead port surfaces only as "a hook timed out", which names neither the cause nor the process that failed.

### The CI guard against disappearing tests

CI does not run `bun test` directly — it goes through `scripts/ci/test-with-guard.ts`, which fails the build on any of:

1. any error outside a test body — an `Unhandled error between tests` marker (a file that crashed at import) or a non-zero `N errors` in bun's summary,
2. a test or file count **below** the baseline in `.github/test-baselines.json`, including the degenerate case where the caller's glob selects **no files at all** (a renamed directory would otherwise print "no tests found" and pass).

Growth never fails the build, so adding tests needs no baseline change; the guard just notes the baseline is stale. Deleting tests on purpose means re-recording: re-run the job's command with `--update`.

**Refresh the baselines periodically, and act on the "stale" line.** Because growth never fails, a baseline nobody touches quietly becomes a floor far below reality — which is a guard that no longer guards. When this rot was first measured, `freebuff-desktop` was recorded at 971 tests while actually running 1278, so **307 tests could have stopped running and CI would have stayed green** (393 across all suites). Re-record from a real CI run, not locally.

Expect to do it more than once. Desktop moved 1278 → 1282 → 1339 over the two days it took to land that refresh, so on an active package the floor starts sliding immediately. That is fine — a floor 50 tests low still catches the failure this exists for, which is a suite losing *hundreds* at once. It is a floor 300 low that is worthless. Treat the "stale" line as a nudge, not an emergency.

A suite that selects **no files and has no baseline** is not a failure — it can legitimately have no tests yet — but it now emits a `Suite ran no tests` warning annotation rather than passing in silence. Three jobs sit in that state today (`test:.agents`, `test-integration:common`, `test-integration:packages/agent-runtime`), each spending ~55s of setup to verify nothing; `.agents` even declares `"test": "bun test __tests__"` against a directory that does not exist. Either give them tests or drop them from `ci.yml` — but decide, rather than letting them read as green.

**A skipped suite and a running suite do not report the same total.** Skipped tests are counted, so it is tempting to assume a baseline recorded locally transfers to CI — it does not when a whole `describe` is skipped. Measured on the billing DB suites: each skipped file reported exactly **two more** than it did when it ran (47 vs 41 across three files), and the guard duly failed a healthy CI run. So a baseline for a suite that skips locally but runs in CI — anything DB-backed — must be taken from a real CI run. Read the observed counts out of the job log and write them into `.github/test-baselines.json`.

Re-record in a CI-equivalent state, which means running `cd sdk && bun run build` first. A few cli tests register a placeholder test *only when* `sdk/dist` is missing, so a baseline seeded without it is inflated and the guard then fails a perfectly healthy CI run. (The guard caught exactly this while being built.)

This exists because every check bun gives you is blind to the failure mode that actually happened here three times: a file stops contributing tests and the summary still reads as mostly-green.

**`[test].exclude` in `bunfig.toml` does nothing on bun 1.3.14.** Verified by pointing it at an ordinary test file, which still ran. That is why the repo-root `exclude` does not keep `*.integration.test.*` out of a root run, and why CI filters them with `find ... ! -name '*.integration.test.ts'`. Gate on a runtime condition instead of trusting the key.

## The production-runtime smoke in `build-web`

Everything else in CI runs under Bun. Production `web` runs under Node (Render's
default, pinned in `.node-version` so CI and Render read the same file), and
the two disagree on which JS built-ins exist: on 2026-09-11 a
`Promise.withResolvers()` in the completions handler was green everywhere and
threw on every request in production (#3218). `scripts/check-node-runtime-apis.ts`
catches the known names; `web/scripts/prod-smoke.ts` catches the class. After
the Next build, `build-web` starts `next start` on the pinned Node against a
migrated Postgres container and drives one real client journey — session
admission, agent-run start, a streamed chat completion — with every external
HTTP call stubbed by `web/scripts/prod-smoke-upstream.cjs`. A request that
cannot complete end to end fails the job. The `web` Render service deploys
manually, so this makes `main` red before someone deploys it rather than
blocking the deploy itself.

Run it locally after `bun run build` in `web/` with `DATABASE_URL` pointing at
a loopback Postgres that has the migrations applied (the script seeds rows, so
it refuses any other host):

```bash
cd web && DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/testdb bun run smoke:prod
```

## What CI actually spends its time on

`ci.yml` is one flat fan-out: `typecheck`, `build-web`, and three test matrices,
with **no `needs:` edges between them**. Before that, every test job waited on a
combined `build-and-check` gate, and measuring a run showed how badly that
misread the cost:

| | before | after |
|---|---|---|
| **Total run** | **10m40s** | **5m29s** |
| the gate / its replacements | `build-and-check` **441s** | `typecheck` 326s ‖ `build-web` 194s |
| web build's own compile | 330s (`in 5.5min`) | **73s** |
| all test jobs' `bun test` steps, added together | 184s | **110s** |
| `test-common`'s actual test run | **1s** (after 55s of setup) | 1s |

The gate was ~70% of the run, and the thing it gated took under two minutes of
real work. Nothing a test imports is produced by the typecheck or the Next
build, so the edges bought nothing.

Splitting typecheck from the web build was worth more than un-gating: the Next
compile went 330s → 73s purely by not sharing two cores with tsc. Note what did
**not** change — Next still logs `using 1 worker` for page-data collection and
static generation, before and after. On a 2-vCPU runner it always will. The win
came from the webpack compile phase, not from more workers; don't chase the
worker count.

The corollary for anyone optimizing this: **individual tests are not the
problem, and deleting them will not help.** Per-job setup (dependency-cache
restore, SDK build) costs far more than the tests in almost every job.

### Typecheck runs in lanes

`bun --filter='*' run typecheck` scheduled `@codebuff/freebuff-web` last: it did
not start until 114s into a 227s step, then ran ~113s alone while all 17 other
packages had finished and the runner idled on one tsc. So the typecheck job is a
matrix over *lanes* — `freebuff-web` gets its own runner, `rest` takes the other
17 — defined in `scripts/ci/typecheck-lanes.ts`.

Membership lives in that script rather than in `ci.yml` because both obvious
ways to write it in YAML fail silently:

- **`--filter='*' --filter='!@codebuff/freebuff-web'` does not exclude
  anything.** bun 1.3.14 ignores the negation and runs all 18 packages
  (verified), so the `rest` lane would re-run the package it exists to hand off
  and the split would buy nothing while looking correct.
- **Listing the other 17 by hand** means a newly added package matches no lane
  and is typechecked by nobody — a green build with a hole in it.

So lanes are derived from the workspace at runtime and the derivation is
checked: every package with a `typecheck` script must land in exactly one lane
or the script exits 1. Adding a package needs no change; only moving one
between lanes does.

Everything else in that script exists to make the remaining ways it can quietly
check nothing loud. Each of these **exits 0** on its own:

- **A lane declared in the script but missing from `ci.yml`'s matrix.** Its
  packages leave `rest` and are then run by nobody, while every lane that *does*
  run still passes. This is why the step passes `--expect-lanes`: the two lists
  must match or the build fails. Keep them in sync when adding a lane.
- **A filter that matches nothing, next to filters that do.** Measured on bun
  1.3.14: `--filter=@codebuff/common --filter=@codebuff/nope` runs `common`,
  ignores the bad one and **exits 0**. A lone non-matching filter exits 1, so
  only the multi-package case is silent — which is exactly what `rest` is. The
  script therefore asserts every lane member actually reported a result.
  (Relatedly, write `--filter=NAME`; as separate argv entries the value does not
  bind and bun matches nothing at all.)
- **A lane naming a package** that was renamed or lost its `typecheck` script.
- **`Bun.Glob` skipping dot-directories.** Without `dot: true` the workspace
  scan finds 20 manifests instead of 21 and `.agents` silently leaves every
  lane.

**Beware retry-inflated numbers when you profile this.** The first pass at the
table above recorded `freebuff-desktop` at 130s, which was wrong: the job had
silently failed once (`Boundary result-checkpointed was not reached`, 69.55s)
and passed on attempt 2 (48.78s), and `nick-fields/retry` reported success. Read
bun's own `Ran N tests across M files [Xs]` line, not the step duration, and
grep the log for `Attempt N failed` before trusting any per-job figure.

Every test job ends with a step that reacts to a pass-on-retry, so this stops
being something you only discover by hand-reading logs. **Unit suites fail**;
integration suites get a `Flaky suite` warning.

The split is measured, not assumed. Across 100 CI runs / 2000 test-job instances
(2026-07-31 → 08-02) the retry rescued a unit suite **zero** times; both real
rescues were `test-integration-packages/internal`, i.e. a Postgres service
container. Retrying infrastructure is what a retry is for; retrying test logic
just moves the bill to whoever hits it next, so a retried unit suite is now a
flake by measurement and fails on the PR that introduced it. `max_attempts`
stays 3 there on purpose — attempt 2 passing is what separates "flaky" from
"broken", and a genuinely broken suite already runs three times either way.

### `sdk/dist` is cached, not rebuilt per job

`./.github/actions/build-sdk` restores `sdk/dist` from a cache keyed on every
input the bundler reads (sdk sources/scripts/vendor, the workspace packages it
inlines via tsconfig `paths`, and `bun.lock`). It has **no `restore-keys`** on
purpose: a prefix match would hand back a dist built from different sources and
every downstream test would silently run against a stale SDK. A miss just costs
the ~18s build.

`freebuff/web`'s `prepare:workspace` shells out to that same SDK build, and it
was the tail of the typecheck job — freebuff/web finishes last, and spent its
first ~65s rebuilding what the job had already restored. It now honours
`SDK_ALREADY_BUILT`, which **only** CI's typecheck job sets, immediately after
`build-sdk` has run. Unset everywhere else, so local runs and Render deploys
still build normally. If you add a job that runs `freebuff/web`'s typecheck or
build, either let it rebuild or set the flag *after* `build-sdk` — never before.

### Known remaining cost

`freebuff-desktop` is the heaviest suite — ~54s on CI, about half of all test
execution in the repo — and `src/app/thread-engine.test.ts` is most of it (244
of its tests). There is no hot spot to fix: the time is spread evenly (the
slowest single test is 1.6s) and about a quarter of it is the `gitEngine`
fixture spawning a real `git init` + commit per test (~125ms each, measured).
That is genuine coverage of worktree lifecycle behaviour, not slop — the lever
is sharding, not deleting cases. Sharding needs its own baseline key per shard
in `.github/test-baselines.json`, recorded from a real CI run (see above), and
is only worth doing once it is actually on the critical path. It is not today:
the whole job finishes in 130s against `typecheck`'s 326s.

Measure it on CI, not locally. That same file takes ~101s on an M-series Mac
against ~54s for the entire desktop suite on a runner, so local timings will
send you after the wrong thing.

### Cold Bun installs beat the dependency cache on Ubicloud

Do not cache `node_modules` on the Linux jobs. The first full CI run after the
Ubicloud migration gave a natural cold-cache comparison across all 31 Linux
jobs: cache lookup plus `bun install --frozen-lockfile` took 802 runner-seconds
in total, with a 26.0s median per job. The next three runs restored the same
1.185 GB archive and took 1,038–1,080 runner-seconds for restore plus install,
with 32.9–34.1s medians. A warm cache was therefore about 7–8s slower per job
and cost roughly four extra runner-minutes per full CI run.

The smaller observations agree with the full matrix. Migration CI installed
cold in 23s, while its warm restores took 18–41s. The abuse sweep installed in
17s on a miss and then spent another 24s compressing and saving the cache.
`setup-project` consequently skips dependency caching on Linux, and standalone
Ubicloud workflows use that action instead of carrying their own cache blocks.
The Windows and macOS cache remains until those runners have their own cold/warm
comparison; this measurement says nothing about their install performance.

Keep the caches whose transfer cost is materially smaller than the work they
avoid. `sdk/dist` is a roughly 17 MB restore instead of an ~18s build. The web
app's 72–74 MB Next.js cache restores in 2–3s; measured warm builds took 34–47s
against 61s cold. `oven-sh/setup-bun`'s own small runtime cache is independent
of dependency installation and also remains enabled.

## CLI tmux Testing

For testing CLI behavior via tmux, use the helper scripts in `scripts/tmux/`. These handle bracketed paste mode and session logging automatically. Session data is saved to `debug/tmux-sessions/` in YAML format and can be viewed with `bun scripts/tmux/tmux-viewer/index.tsx`. See `scripts/tmux/README.md` for details.

Useful workflow for agents:

```bash
# Start the dev CLI in a detached tmux session.
SESSION=$(./scripts/tmux/tmux-cli.sh start --name cli-check -w 160 -h 40 --wait 6)

# Capture the initial screen. Captures are written to debug/tmux-sessions/$SESSION/.
./scripts/tmux/tmux-cli.sh capture "$SESSION" --label initial

# Send a prompt. The helper uses bracketed paste so text is not dropped.
./scripts/tmux/tmux-cli.sh send "$SESSION" "Search for getAgentBaseName and report what you find" --wait-idle 4

# Capture after the run, then inspect the saved capture text.
./scripts/tmux/tmux-cli.sh capture "$SESSION" --label after-search --wait 2

# Clean up when finished.
./scripts/tmux/tmux-cli.sh stop "$SESSION"
```

If a change can be verified with a small local harness instead of a live model-backed CLI run, run that harness inside tmux too. This still checks terminal rendering and produces a capture:

```bash
SESSION=$(./scripts/tmux/tmux-cli.sh start \
  --name render-check \
  -w 160 -h 20 \
  --wait 1 \
  --command "bun .context/my-render-check.tsx")

./scripts/tmux/tmux-cli.sh capture "$SESSION" --label rendered
./scripts/tmux/tmux-cli.sh stop "$SESSION"
```

When verifying UI output, prefer checking the saved capture file for concrete strings that should and should not appear. For example, after expanding a code-searcher agent, check that the capture shows the search summary but not raw structured payload keys like `results:` or `stdout:`.

## Confirming a suspected flake

CI runs a failing test job up to three times (`nick-fields/retry` in `ci.yml`).
A unit suite that only passes on a later attempt now fails the build; an
integration one still passes with a warning. Either way the interesting question
is the same one, and CI cannot answer it: **CI never applies contention.** Each
package's suite gets its own runner, so the shared-state flakes live below its
resolution entirely. When a suite fails on a busy machine and passes on a quiet
one, the
temptation is to call it the machine's fault. Don't: **load is not a cause, it
is a magnifier.** What it magnifies are real defects that a single run on an
idle laptop cannot show.

`scripts/flake-hunt.ts` reproduces those conditions deliberately — N rounds,
each running the suite several times *simultaneously* while CPU busy-loops
compete for the cores — and names every test that fails.

```bash
# The default hunt: 3 rounds x 2 overlapping runs of the desktop suite.
bun scripts/flake-hunt.ts

# Harder, and on a different package.
bun scripts/flake-hunt.ts --dir cli --rounds 5 --concurrency 3 --hogs 8

# Interrogate one suspect file: cheap enough to run 10 times.
bun scripts/flake-hunt.ts --cmd "bun test src/app/server.test.ts" --rounds 10
```

It exits non-zero if any run reported a failing test, prints the load average
per round, and writes each run's full output to a log it names for you. If your
shell lacks the repo env (a worktree without direnv), pass it through the
command: `--cmd "bun --env-file=../.env.local test"`.

### When the hunter cannot reproduce it

The hunter is a magnifier, not an oracle, and one open flake is proof of that.
`useProjectSkills` failed on **three separate PRs, on three different cases**,
none of which touched `freebuff-desktop` — and never once under 24 hunted runs
at load 11-16, nor under 12 concurrent runs with CPU hogs, on the fixed and
unfixed versions alike.

Two concrete mechanisms were removed and it flaked again on a head that already
contained both. At that point further guessing costs other people's PRs, so the
file was skipped and tracked in **issue #1899** rather than patched a third time.

#1983 un-skipped it by moving it off the hand-rolled `mount()` entirely, onto
`@testing-library/react` + jsdom instead (the pattern already used by
`UpdatesPage.test.tsx`, `QuotaBadge.test.tsx`, `ConnectorsPanel.test.tsx`, …),
on the theory that the class of bug cannot exist there — React's own scheduler
owns the dispatcher for the whole render/effect/continuation lifecycle, instead
of a test file borrowing it by hand.

**That is a theory, not a diagnosis.** The original flake was never reproduced,
so nothing distinguishes "the dispatcher swap was the cause and is now gone"
from "the timing changed and the flake moved". Leave #1899 open until the file
has survived a stretch of CI; if it flakes again, the migration is evidence
*against* the dispatcher hypothesis and the search should widen, not repeat.
The other twelve files named below still use the swap either way.

Two things worth taking from it:

- **A green `gh pr checks` does not mean the job never failed.** CI retries, and
  a successful re-run overwrites the run conclusion. The failures above are only
  visible via `attempts/1/jobs` on the run. Check there before concluding a
  suite is healthy.
- **The suspect is usually shared, so the file that flaked is rarely the fix.**
  Here it is the hand-rolled `mount()` that swaps the process-global
  `React.__CLIENT_INTERNALS…H` dispatcher and restores it in a `finally` —
  while effects, and the fetch continuations they schedule, run *after* that
  restore. 13 desktop UI test files touch that global and at least six define
  their own `mount()` with the same shape, so fixing one file just moves the
  flake to a sibling — as it still can, for the twelve that remain.

**Three things to check before blaming the machine.** Each of these was a real
defect found by this harness on its first outing:

1. **Shared state between concurrent runs.** `server.test.ts` spawned its
   orchestrator on a hardcoded port *and probed that port for readiness*, so two
   overlapping runs did not collide — they merged. The loser's server died with
   `EADDRINUSE`, its readiness probe was answered by the winner's server, and
   its tests then drove a foreign engine with a different `$HOME` and a
   different open project. Two concurrent runs of that one file produced 6 and
   19 failures scattered across unrelated assertions; alone it passes 49/49.
   Spawn servers on port 0 and read back the port they actually got.

2. **Waits that sample instead of listening.** A fixed count of 10ms polls is a
   budget with no relationship to how long the work takes, and it pays a full
   tick even when the work already finished. Await the signal the system already
   emits (the engine's event bus, a process's own stdout), with a wall-clock
   deadline that names what it was waiting for.

3. **Timers and promises that outlive their test.** A 200ms debounced save in
   the renderer store fired *inside a later test* that had swapped in its own
   `fetch`, landing a stray request in that test's recorded calls. Which test
   becomes the victim is decided by timing, so a loaded machine changes the
   answer. Cancel pending background work between cases.

A fourth pattern worth naming: a test that races two real timers against each
other (a 20ms cadence against a 40ms window) has a 2x margin that starvation
erases. Inject the clock and advance it explicitly rather than sleeping.

One shape worth calling out separately, because no amount of isolating the test
fixes it: **a test whose subject is machine-global.** `orphan-reaper` kills any
process on the box stamped with a dead orchestrator — that is the feature — so
two copies of its real-process test reap each other's children, and the victim
fails on `Received: []` with its orphan already dead, for the module doing
exactly its job. Its temp dirs and pids were already unique; the shared state was
the process table itself. An atomic `mkdir` lock around the one section that
spawns stamped children serialises those runs against each other and costs
concurrency nowhere else.

**A fifth, and the reason some of these reports are unreadable rather than
merely red: a polling helper whose deadline is not shorter than the budget of
the test that called it.** Bun's default is 5s per test. A `waitFor` that gives
up after 10s (or exactly 5s) never gets to report anything — bun fails the test
at its own deadline first, moves on, and the helper's rejection surfaces later
with no test to attribute it to. It is printed as `unhandled error outside any
test` and counted *separately* from the failure that caused it, so one slow
shell shows up as two entries naming a file rather than one naming a case. Five
files had this inverted or equal (`terminal`, `loop-health`, `login`,
`orphan-reaper`, `smoke`). Rather than repeat the rule as a comment in each,
`test/support/budgets.ts` hands back the pair and refuses an inverted one at
import, so getting it wrong fails the file loudly instead of only when something
is slow enough for the difference to show:

```ts
const { slowTest, waitMs } = budgets(30_000, 15_000)
// slowTest declares tests carrying the 30s budget; every polling helper in the
// file gives up at waitMs, which is checked to be under it
```

Raising a test's budget is the right move *only* once you know what the test
actually spends it on. Every case above drives a real process — a pty, a bun
child, a `--version` probe — whose latency scales with machine load, so 5s was a
guess about machine speed rather than a statement about correctness. Where the
work was avoidable instead, it was removed: one claude-code test spawned four
stub binaries where one would do, paying a memoized-away `--version` per extra
binary, which made it the file's most expensive test by 2.5x and its first
casualty under load.

The first monorepo-wide sweep found the shared-state pattern twice more, both
in `cli` and both fixed the same way — give the run its own `mkdtemp` directory
instead of a name every run shares. One wrote to a fixed path *inside the
working tree* (`__dirname/temp-test-images`, deleted in `afterEach`, not
gitignored); the other to seven fixed `os.tmpdir()/codebuff-test-*` paths whose
`beforeEach` deleted them recursively. Overlapped they failed 6/10 and 4/10
runs; solo they always passed. Note the asymmetry that hid them: CI gives each
package's suite its own runner, so nothing there ever runs two copies at once —
these bit developers and this harness, not the pipeline.

Prefer these fixes over longer timeouts. A longer timeout makes the symptom
rarer without making the test deterministic, and it slows every honest run to
buy that. The one legitimate use is converting an *iteration count* into a
wall-clock deadline, since only the latter means "this is broken" rather than
"this machine is slow".

Two caveats when reading the results. A clean hunt is evidence, not proof —
absence of failure across six runs bounds the flake rate, it does not disprove
it. And a test of the form "sleep 20ms, then assert nothing has happened yet"
can only pass *vacuously* under load, so this harness will never flag it; those
need rewriting to assert ordering rather than absence.

The weekly `flake-hunt.yml` workflow runs this against `freebuff-desktop` and
reports failures without blocking any PR.

**A sixth shape, and the only one the hunt cannot reproduce: the budget bun
applies to a HOOK.** `beforeEach`/`afterEach` are charged against the same
default a test gets (5s), and one that overruns is reported as a failing *test*
— `a beforeEach/afterEach hook timed out for this test` — so the case named is
never the case at fault, and the file's first test is what takes the hit. On
2026-08-11 that failed main: `engine-lifecycle`'s `beforeEach`, 3.7ms on a
laptop and 28ms on the retry, took 5.313s on a stalled runner and failed
`dispose > closes only this engine instance terminal scope`, a test that asserts
one recorded call. Three overlapping suite runs under four CPU hogs never
reproduced it, because there is nothing in the test to reproduce: the hook opens
a real sqlite database and `rm -rf`s it again, and its latency is the machine's.
Every hook in this package that builds a real fixture (`makeDb`, `makeRepo`,
`makeEngine`, and worktree.test.ts's inline equivalent — 23 files) now carries
`FIXTURE_HOOK_MS` from `test/support/budgets.ts`; the tests themselves keep the
5s default, and a hook that is genuinely stuck still fails at the step timeout.
The line is cost, not the helper: measured per hook pair, `makeRepo` is 77ms and
`makeDb`/`makeEngine` 4.7ms, against 0.1ms for the 60-odd hooks that only
`mkdtemp` and `rm -rf`. The stall that reddened main inflated a hook ~190x (and
the test after it ~42x, which is why it reads as contention decaying rather than
one fixed pause); at 0.1ms you would need ~10,000x, so those are left alone.

That flake also cost more to find than to fix, which is its own lesson: a suite
that fails and then passes leaves the failing attempt's output buried above the
passing one, and `nick-fields/retry` reports only a count. `test-with-guard`
therefore appends each attempt's failing test names to a file under the runner's
`$RUNNER_TEMP`, and ci.yml's flake annotation names them. Before that,
identifying the one `(fail)` line meant reading an 11,014-line log.
`scripts/ci/bun-test-failures.ts` parses the names back out of bun's output,
including the `^ …` reason line, and derives that path at both ends rather than
having ci.yml pass it: `${{ runner.temp }}` is not available in a job-level
`env:`, and a workflow that references it there fails validation and runs ZERO
jobs — which is exactly how this landed the first time.

**A seventh shape, and the one that does not care about load at all: the FILE
ORDER.** The five shapes above are magnified by a busy machine, so the flake hunt
finds them. This one is decided before any test runs, by which file bun loaded
first — and bun does **not** load files in the order the command line lists them
(`test:files` sorts; the CI log does not come out sorted). So the hunt is blind
to it, the full suite passes 3573/3573 on a laptop, and CI still fails with a
different set of tests every run.

What it looked like: `test-freebuff-desktop` red on four `main` commits in a row,
once on a commit with no file changes at all, naming ~20 tests across
`Tab.rename`, `ContextBar.menu`, `AccountMenu.menu`, `AgentPicker.menu` and
`QuotaBadge` — five files with nothing in common except that they are the only
five that mount React against a real DOM. Renderers came back as the empty
string, `fireEvent` was handed nothing to click, and the head of the cascade was
one test sitting on `await new Promise((r) => requestAnimationFrame(r))` until
bun's 5s budget.

The cause is `global-jsdom` deciding **once per process** which globals it
installs. Its `KEYS` list is built on the first call — every own property of the
jsdom window that is not already on `globalThis` — and cached at module scope for
every call after it. Two suites had left `requestAnimationFrame` on `globalThis`:
one assigned a `() => 0` stub at module scope and put back only `fetch`, the
other "restored" it with `Object.assign`, which writes `undefined` rather than
removing the property. `!(k in global)` cannot tell either from a real global, so
whichever mounted suite loaded first inherited a rAF that never fires — and so
did the other four, for the rest of the run.

Note what the loser is not: the file holding the stub passes either way. Fixing
this by chasing the failing tests, or by re-splitting a suite to isolate it (as
#1382 did for the quota timers), treats the victim.

The cascade is worth understanding separately from the poisoning, because the two
were fixed by different PRs. The other four files did not fail because they
needed rAF — they failed because `Tab.rename` was killed mid-`act()` at the 5s
budget and left React's state inconsistent for everything after it. #1569 drives
those frames by hand instead of awaiting a real one, which removes the hang and
therefore the cascade. That is the trigger. The mechanism below is what stays:
verified by probe on top of #1569, a stubbed `getComputedStyle` or
`MutationObserver` is still never replaced by jsdom's, in every mounted suite,
for the whole run. Nothing awaits those today, so nothing is red — which is
exactly the shape of a defect that reappears the next time someone writes a test
that does.

Two rules come out of it:

1. **Restore a global by DELETING the key when there was none.** Capture
   `Object.getOwnPropertyDescriptor` and `Reflect.deleteProperty` if it comes
   back undefined. Assigning the captured `undefined` leaves the property in
   place, which is all any `in` check — including global-jsdom's — looks at.
2. **Get a DOM only from `test/support/jsdom.ts`.** `installJsdom()` clears the
   DOM globals before handing over, so global-jsdom makes that one-shot decision
   against bun's own globals rather than against whatever ran first, and then
   asserts the keys React DOM needs really did come from jsdom. A stub it does
   not know about fails there, naming the key, instead of surfacing as a timeout
   in a file that never touched it.

The general form is worth keeping in mind beyond jsdom: **a library that caches a
decision at module scope turns "who ran first" into behaviour**, and bun's one
process per package makes every test file a candidate for first. Contention is
not required, so neither `flake-hunt.ts` nor a green local run says anything
about it. Reproduce it instead by putting the suspected leak in a `--preload`,
which is exactly "some earlier file did this", and running the affected files:

```bash
echo ';(globalThis as any).requestAnimationFrame = () => 0' > /tmp/leak.ts
cd freebuff-desktop && bun test \
  --preload ../test/setup-scm-loader.ts --preload ../sdk/test/setup-env.ts --preload /tmp/leak.ts \
  src/ui/shell/Tab.rename.test.tsx src/ui/agent/QuotaBadge.test.tsx
```
