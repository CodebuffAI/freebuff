---
name: prisma-platform-core-concepts
metadata:
  library: "prisma"
  library_version: "8.0.0-rc.35"
  version: 2026.9.2
description: >-
  Use when hosting, deploying, or operating an app on the Prisma Platform:
  projects, branches, preview environments, services and their versions,
  Prisma Postgres databases, object-store buckets, environment variables,
  custom domains, logs, or the GitHub integration. Triggers on "Prisma
  Platform", "Prisma Compute", "Prisma Postgres", "Prisma Storage",
  "preview environment", `prisma deploy`, `prisma dev`, `prisma auth`,
  `prisma project`, `prisma branch`, `prisma service`, `prisma postgres`,
  `prisma bucket`, `prisma git`, `prisma.config.ts`, promote, rollback.
---

# Prisma Platform core concepts

> **Isolated infrastructure for every branch.**

The Prisma Platform moves fast, and your training data about it is very
likely outdated. This skill ships inside the installed `prisma` package, so
it describes the exact version this project has: treat it as the source of
truth over anything you remember about Prisma hosting. If
`metadata.library_version` in this file's frontmatter does not match the
project's installed `prisma` package, run `prisma skills sync` and re-read.
Fuller documentation for everything here lives at prisma.io/docs; consult it
when a concept needs more depth than this file carries.

This file shares the platform's structures, hierarchies, relationships, and
workflows. It is not a CLI reference: commands appear only where a workflow
needs them. To learn a command surface, run `prisma --help`, or
`prisma <group> --help` for any group named below; pass `--json` for
machine-readable output. Without it, a piped command prints plain data lines,
not JSON. The data contract, migrations, and
queries belong to the `prisma-orm-core-concepts` skill; declaring services
and modules in code belongs to `prisma-composer-core-concepts`.

## The stack

One CLI, `prisma`, fronts a set of products designed to be used together:

| Product | What it is | Concepts live in |
| --- | --- | --- |
| Prisma ORM (Prisma 8) | Data contract, typed queries, migrations | `prisma-orm-core-concepts` |
| Prisma Composer | The app declaration: services, databases, buckets, wiring | `prisma-composer-core-concepts` |
| Prisma Compute | Hosting: runs your services next to your data | this skill |
| Prisma Postgres | Managed PostgreSQL | this skill |
| Prisma Storage | S3-compatible object storage | this skill |

**Every deployed app is a Composer app.** Your server code plus a declaration
(`module.ts`) naming its services, databases, and buckets. The declaration is
the source of truth: deploying converges the platform to it, re-deploying
applies only the difference, and removing a resource from the module removes
it from the platform on the next deploy. There is no separate provisioning
step and no connection strings to wire by hand; Composer injects them.

## Project setup

`prisma init` prepares local configuration and copies this skill from the
installed `prisma` package into the configured agent directories. Database
provisioning and deployment are separate choices. Keep the project's existing
database and hosting setup unless the user wants to change it.

For a Prisma Composer (Early Access) app deployed to Prisma Compute, install
the app's dependencies:

```sh
npm install prisma @prisma/composer @prisma/composer-prisma-cloud
```

`@prisma/composer` is what the module declaration imports;
`@prisma/composer-prisma-cloud` is the Prisma Cloud target and brings
`@prisma/orm-postgres` with it. The sibling skills travel inside these
packages (`prisma-composer-core-concepts` in `@prisma/composer`,
`prisma-orm-core-concepts` in `@prisma/orm-postgres`), so they appear after
this install plus `prisma skills sync`, not before.

One config file, `prisma.config.ts`, configures the CLI and every product
it runs. Each top-level key is a section owned by one product, and this CLI
recognises exactly three: `orm`, `composer`, and `skills`. The composed
shape:

```ts
import { definePrismaConfig } from "prisma/config";
import { defineConfig as composer } from "@prisma/composer/config";
import { nodeBuild } from "@prisma/composer/node/control";
import {
  prismaCloud,
  prismaState,
} from "@prisma/composer-prisma-cloud/control";
import { defineConfig as orm } from "@prisma/orm-postgres/config";

export default definePrismaConfig({
  composer: composer({
    entry: "./module.ts",
    extensions: [prismaCloud(), nodeBuild()],
    state: prismaState(),
  }),
  orm: orm({ contract: "./src/prisma/contract.prisma" }),
  skills: { agents: ["claude"] },
});
```

`dev` and `deploy` read the `composer` section and nothing else; what goes
in it belongs to `prisma-composer-core-concepts`. A separate
`prisma-composer.config.ts` is no longer read, and the old setup is refused,
never silently ignored: `CONFIG.SECTION_MISSING` when no loaded
`prisma.config.ts` declares a `composer` section, `CONFIG.FIELD_RETIRED`
when the section still has `configPath`, and `CONFIG.FILE_RETIRED` when a
`prisma-composer.config.*` sits next to the declaring `prisma.config.ts`.
All three arrive under the CLI's `CLI.CONFIG_SECTION_INVALID`. For
`CONFIG.SECTION_MISSING`, write the section. For the other two, move the
old file's `extensions` and `state` into the section, then delete the
`configPath` field or the old file.

## The resource model

1. **Workspace**: the account boundary. Members, billing, and projects live
   here; the `auth` group manages which one you act in.
2. **Project**: one product or codebase. Its region is chosen at creation and
   is immutable afterwards; every resource in the project inherits it.
3. **Branch**: the isolation boundary, named after a git branch. A branch is
   an environment: it owns its own services, its own databases, its own
   buckets, and its own environment-variable overrides.
4. Inside a branch: **services** (HTTP apps, deployed as versions),
   **databases**, and **buckets**.

The first branch of a project is the **production** branch. Every branch
after it is a **preview** branch. Production and previews differ in exactly
two ways: which environment-variable class they resolve (see below), and
lifecycle (previews can be reclaimed and torn down; production cannot).

A CLI invocation resolves its project from a directory binding, created when
a project is created from or linked to the directory and stored in the
gitignored `.prisma/local.json`. Resource commands take flags to target
another project or branch explicitly.

## Branches are preview environments

There is no separate "preview environment" object to create or configure. The
branch is the environment, and branches come into being by deploying to them:

1. **Push a git branch** (with the GitHub integration connected and the
   deploy workflow in the repository): the workflow builds and deploys, and
   the platform creates the branch environment on the fly.
2. **Deploy an environment from the CLI**: `prisma deploy --environment pr-42`
   creates a branch named `pr-42` and deploys the identical app graph into
   it. An environment name must be a valid git ref name; an invalid name is
   a hard error.

A preview branch that needs a database gets a fresh, empty one, wired in as a
branch-scoped `DATABASE_URL`. Preview work can never touch production data
unless you explicitly point it there. Schema comes from your committed
migrations; data does not follow from production.

Preview lifecycle rules:

1. Deleting the upstream git branch tears the whole environment down:
   services, versions, and databases, including their data.
2. An idle, unpinned preview branch can be reclaimed automatically. Pinning a
   preview exempts it from idle reclamation, but not from teardown when its
   git branch is deleted.
3. The production branch is never reclaimed or torn down this way.

## Two ways to deploy

**GitHub (recommended).** Two pieces, both required: the Prisma GitHub App
connected to the repository, and a GitHub Actions workflow in the repository
that runs `prisma/cloud-deploy-action`. The platform does not build on push.
The workflow builds in the repository's own Actions and deploys with a
short-lived credential exchanged from the run's OIDC token; the connection
is what authorises that exchange, and it also tears a preview down when its
git branch is deleted. Importing the repository in the Console opens a setup
pull request that adds the workflow. `prisma git connect` only creates the
connection, so a repository connected from the CLI adds the workflow itself.
The minimal `.github/workflows/prisma-deploy.yml`:

```yaml
name: prisma-deploy
on:
  push:
permissions:
  contents: read
  id-token: write
jobs:
  deploy:
    if: github.ref_type == 'branch'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - uses: oven-sh/setup-bun@v2
      - uses: prisma/cloud-deploy-action@v1
        with:
          build-command: npm run build
```

From then on, every push of a branch that carries the workflow file runs
it; GitHub reads workflows from the pushed commit, so a branch created
before the file was added deploys nothing until it contains the file. A
push to the default branch deploys production; a push to any other branch
creates or updates that branch's preview environment, so previews come free
with every branch.
Opening a pull request does not itself deploy anything; previews track
branch pushes. A connected repository without the workflow gets branch
bookkeeping and preview teardown from the platform, and no builds.

**CLI.** `prisma deploy` deploys production directly; add `--environment <name>`
for a preview. It deploys the entry file named by `entry` in the `composer`
section of `prisma.config.ts`; `--entry <path>` overrides it. `prisma deploy
list` (same `--environment`) lists each deployed node's address, kind, platform ID
and URL. Authenticate once with `prisma auth login`
(interactive), or set `PRISMA_SERVICE_TOKEN` (plus `PRISMA_WORKSPACE_ID`
when the token can see more than one workspace) for CI and other headless
runs. The first deploy creates the project, named after your module; the
name must be unique in the workspace, and `--name` deploys under a different
one.

Before deploying, configure the Composer root module and the `composer`
section in `prisma.config.ts`, then build the app. A new project also needs
a region in `prismaCloud({ region: ... })` or `PRISMA_REGION`. The
[deployment guide](https://www.prisma.io/docs/composer/deploying) covers
these prerequisites; running `prisma init` alone does not prepare a
deployable app.

Both paths converge the same declaration, so they are mutually idempotent:
a repo can be connected to GitHub and still be deployed from the CLI.

## Services and versions

A **service** is an HTTP app inside a branch, reachable at a stable URL.
Every deploy of a service creates a new immutable **version**; exactly one
version is live behind the stable URL at a time. Versions can be inspected,
started, stopped, and deleted individually, and a version's logs can be read
or followed; the `service` group covers all of it.

Two movements between versions matter:

1. **Promote** takes a version to production by rebuilding it with
   production-class environment variables. A version built on a preview
   branch never carries preview configuration into production.
2. **Rollback** points production back at a previous version. A stopped
   target is started and health-checked before traffic switches, so rollback
   is zero-downtime.

**Custom domains** attach to a service's production branch only. The
workflow: add the domain, create the CNAME record the platform reports, and
wait for DNS verification and certificate provisioning; a verification that
failed on missing DNS is retried after the record exists.

## The Compute runtime

Services run on Bun, next to their Prisma Postgres database. There is no
container image to author and no platform emulator to install locally.

The runtime has no global `Temporal` (stock Node 24 lacks one too). Code
that reads an ORM `DateTime` column compiles and deploys, then throws on
the first read. Either add the `temporal-polyfill` dependency and
`import 'temporal-polyfill/full/global'` at the service entry, or use the
`*String` column types such as `TimestamptzString`.

An idle service **sleeps**: the platform snapshots its memory after a short
period of inactivity and resumes it from the snapshot on the next request.
Request handling is unaffected, but background work outside the request
lifecycle (`setTimeout`, `setInterval`, floating promises) can be
interrupted mid-flight. The `@prisma/compute` package provides the two
keep-awake primitives:

1. `waitUntil(promise, { signal })` keeps the instance awake until the
   promise settles.
2. `using guard = new KeepAwakeGuard({ signal })` holds the instance awake
   for a scope; call `.release()` in a `finally` block where `using` is
   unavailable.

Pass `AbortSignal.timeout(ms)` as a cost bound: the signal releases the
guard, it does not cancel your work. Do not build schedulers on `setInterval`
inside a service; sleeping makes them silently unreliable.

## Prisma Postgres

To your application, a Prisma Postgres database is a regular PostgreSQL
database behind a connection string: any client works, including Prisma ORM,
psql, Kysely, and Drizzle. On top of plain PostgreSQL each database has
built-in connection pooling (no PgBouncer to run) and, on paid plans,
automated backups: a snapshot each day the database has activity.

Databases usually come from deploying a module that declares one. They can
also be created directly, in which case the connection URL prints exactly
once. Additional connection strings can be minted and rotated per database;
every secret is shown exactly once at creation, and no later read reveals
it. On paid plans, backups are automated, listable, and restorable.
Per-database usage metrics are queryable; the `postgres` group covers all of
it.

A database outside any project comes from the separate
[`create-db` tool](https://www.prisma.io/docs/postgres/npx-create-db):
`npx create-db@latest` needs no account and prints a connection string and a
claim URL. The database is deleted after 24 hours unless claimed; claiming it
with a Prisma account keeps it for free. Give the user the claim URL itself
and the deletion time: opening that URL is the only way to keep the database.
Use it when the user has no Prisma account or project yet. When the project
is on the platform, create the database in the project with the `postgres`
group, or declare it in the module, instead.

## Object storage

Buckets are S3-compatible object stores that live inside the project,
optionally associated with a branch (the project's default branch when
omitted). A bucket cannot be renamed.

Access keys are bucket-scoped credentials with a role of `read` or
`read_write`. Creating one prints the access key id, secret, endpoint, and
provider bucket name exactly once; a lost secret is revoked and re-created,
never recovered. The `bucket` group manages both buckets and their keys.

On Compute, Bun's built-in S3 client picks up `S3_ENDPOINT`, `S3_BUCKET`,
`S3_ACCESS_KEY_ID`, and `S3_SECRET_ACCESS_KEY` from the environment, so a
bucket declared in the module needs no client configuration. Locally, a
Composer-declared bucket gets a local stand-in with the same S3 surface;
code written against it runs unchanged on the platform.

## Environment variables

Configuration has two independent axes:

| Axis | Values | Meaning |
| --- | --- | --- |
| Class | `production`, `preview` | Which branches resolve it: production-class values reach the production branch, preview-class values reach every preview |
| Scope | project template, branch override | A template applies to all branches of its class; an override pins a value to one named preview branch |

Rules that bite:

1. Branch overrides exist only for the preview class. Production
   configuration is always the project template; there is no way to give one
   production deploy a special value.
2. Values are write-only. Listing shows names and scopes, never values, and
   no API returns them. To change a value you replace it.
3. Variables resolve at deploy time from the branch's class. You never pass
   environment variables as part of a deploy.
4. Templates, per-branch overrides, and wholesale dotenv import are all
   managed through the `project env` group.
5. `DATABASE_URL` is managed for you when the module declares a database:
   previews get their own fresh database's URL, production gets the
   production database's. Only set it yourself for databases the platform
   does not manage.

## Local development

The local stack is real, fast, and needs no cloud credentials. Prefer it
over deploying whenever you want to show the user a change or verify your
own work:

1. Build the app exactly as you would for deploy, then run
   `prisma dev` (it runs the config's `entry`, like deploy). It provisions a local Prisma Postgres database,
   applies the schema, creates local stand-ins for declared buckets, starts
   the services, and prints a local URL. It watches built output and
   restarts a service when its build changes.
2. Exercise the running app directly (for example with
   `curl "$(prisma dev url gateway)"`, with your service's name in place of
   `gateway`) instead of reasoning about what the
   code would do. `prisma dev url <node>` prints one node's local URL: a
   service's HTTP URL, a database's connection string, or a bucket's S3
   address. Use `prisma dev --detach` to start the app and get your shell
   back.
3. Stopping `dev` (Ctrl-C, or `prisma dev stop`) leaves local databases,
   buckets, and their data in place; the next run is a warm start. `--fresh`
   wipes this app's local instances and data first. `prisma emulator list`
   shows every local instance on the machine.
4. Deploying is the same pipeline pointed at the platform: switching from
   local to hosted is a configuration change, not a code change. Reach for
   `prisma deploy --environment <name>` only when you need a shareable URL or
   platform behaviour (sleeping, real DNS, production-like config).
5. For pure frontend iteration the framework's own dev server also works;
   the Composer local stack is what mirrors the deployed wiring.

Windows is not supported for the local stack yet.

## Failure modes quick reference

1. **A secret you need was shown once and is gone.** By design: database
   URLs, connection strings, and bucket keys print exactly once at creation.
   Rotate or re-create; do not hunt for a read path, none exists.
2. **Deploy refuses the module name.** Module names are workspace-unique.
   Deploy under `--name <other>`, or delete the conflicting project.
3. **A preview environment vanished.** Its git branch was deleted, or it
   sat idle unpinned and was reclaimed. Push or deploy the branch again to
   re-create it; the database starts empty again.
4. **Background work never ran in production.** The service slept.
   Wrap the work in `waitUntil` or a `KeepAwakeGuard`, or move it out of the
   service.
5. **A custom domain stays unverified.** The CNAME to the reported target
   must exist first. Fix DNS, then retry the verification.
6. **Production shows a stale value after an environment-variable change.**
   Variables are resolved at deploy time. Re-deploy (or promote) so the new
   value is picked up.
7. **An environment name is rejected.** Environment names must be valid git
   ref names; rename it.
8. **A resource disappeared from the platform after a deploy.** It was
   removed from `module.ts`; the module is the source of truth and deploy
   converges to it. Restore the declaration and re-deploy.
9. **`dev` or `deploy` rejects the app graph (`COMPOSE.GRAPH_INVALID`) over
   a name.** Resource ids declared in the module (`provision()` ids,
   `compute({ name })`) allow `[A-Za-z0-9]` only. A hyphenated id passes
   authoring and typecheck, then fails here. Module and project names do
   accept hyphens, so never derive a resource id from them.
10. **A deployed service errors on its first timestamp read
    (`RUNTIME.TEMPORAL_UNAVAILABLE`).** The runtime has no global
    `Temporal`; see the Compute runtime section for the polyfill.
11. **The repository is connected, but a push built nothing.** The platform
    does not build on push; the repository's own workflow does. Make sure
    `.github/workflows/prisma-deploy.yml` exists on the pushed branch and
    that a run appears under the repository's Actions tab. A connected
    repository with no workflow records the branch and deploys nothing, and
    no error is raised anywhere.

## What the platform doesn't do yet

Name the gap instead of inventing an API:

1. **No branch create or delete from the CLI.** The `branch` group only
   lists. Branches are created by pushing or by deploying an environment,
   and removed by deleting the upstream git branch; there is no CLI teardown
   verb for an environment yet.
2. **No build retry.** A failed build is finished; the retry is the next
   push or the next deploy.
3. **No reading environment-variable values back**, anywhere. This is a
   security stance, not a missing feature, but agents look for it often
   enough to name here.
4. **No bucket rename** and no bucket-to-branch re-association after
   creation; re-create instead.
5. **No build on push without a workflow.** The GitHub connection authorises
   deploys and tears previews down; it never starts a build. The
   `prisma/cloud-deploy-action` workflow is the build.

For anything else missing, run the nearest group with `--help` before
concluding it does not exist, and route requests with `prisma feedback`
rather than guessing.

## Related skills

Everything inside the app is owned by the siblings: the data contract,
queries, and migrations by `prisma-orm-core-concepts` (and
`prisma-orm-migrations`), and the declaration of services, modules, wiring,
and testing seams by `prisma-composer-core-concepts`. The skills install
together via `prisma skills sync`; when a task crosses from platform
resources into app code, switch skills instead of guessing.
