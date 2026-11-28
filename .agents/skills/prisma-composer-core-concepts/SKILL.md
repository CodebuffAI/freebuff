---
name: prisma-composer-core-concepts
metadata:
  library: "@prisma/composer"
  library_version: "0.40.0"
  version: 2026.9.1
description: >-
  Use when deploying or managing an app that uses Prisma Composer
  (`@prisma/composer`): wiring its services and Modules, running it locally,
  testing composed services, or standing up / tearing down an environment.
  Triggers on "prisma composer", "@prisma/composer", "prisma app",
  `prisma deploy`, `prisma dev`, `compute()`, `appRoot()`, `module()`, `contract()`,
  `service.load()`, `mockService`, `bootstrapService`.
---

# Prisma Composer core concepts

A **Prisma App** is a tree of typed declarations composed in TypeScript and
handed to the `prisma` CLI, whose two main Composer commands are `prisma deploy`
and `prisma dev`. Removing a whole app is `prisma project delete`. Removing
one environment and reading logs are not commands; they are the `destroy` and `log`
operations of `@prisma/composer/control`, called from a script.
This file covers structures, hierarchies, relationships, and workflows: the
concepts you cannot observe from the code or the CLI's help output. It is not
a CLI reference; discover each command's flags with `prisma <command> --help`
rather than inferring them. The Prisma platform moves fast, so treat this file as the
stable conceptual core and find current, fuller documentation at
<https://www.prisma.io/docs>. For working code, read `examples/` in the
prisma/composer repo.

Two principles govern everything and are binding
(`docs/design/01-principles/`):

1. **Your code never reads environment variables.** Dependencies, configuration,
   credentials, and the port all arrive through the service node, typed.
   `process.env` is never the answer.
2. **Composer never bundles or transforms your code.** You build with your own
   bundler; the framework assembles the built output by deterministic steps
   and hands it to the configured deploy target.

## Declarations are data

Everything you author is a declaration: plain data describing a piece of the
app, executing nothing when imported. Three node kinds exist:

| Kind | Declared with | Purpose |
| --- | --- | --- |
| Service | `compute()` | A running unit of your code; atomic, Composer sees only its boundary |
| Resource | `rawPostgres()`, `bucket()` | A stateful managed dependency |
| Resource: public URL | `publicUrl()` | Makes one service reachable from the internet at one hostname; depends on the service's exposed HTTP interface and exposes nothing |
| Module | `module()` | A grouping boundary; runs no code of its own, depends on and exposes typed interfaces; its builder receives `deps`, `input`, `environment` and `provision` |
| App root | `appRoot()` | The outermost module, the entry's default export; no `deps` or `expose`, and nothing can provision it; its builder receives `input`, `environment` and `provision` |

Nodes connect through typed **interfaces**: `deps` declares what a node depends on, `expose` declares what it exposes. Wiring happens in a Module's builder via `provision()`, and the app root, built with `appRoot()` and handed to the CLI, is the App:

```ts
// module.ts
import { appRoot } from '@prisma/composer';

export default appRoot('store', ({ provision }) => {
  const catalog = provision(catalogModule);
  provision(storefrontService, { deps: { catalog: catalog.rpc } });
});
```

Because interfaces are typed, **the compiler verifies every wire**. A dependency wired to the wrong producer, a missing RPC handler, a literal input value of the wrong shape: all of it fails `tsc`, not the deploy. Values from outside the code are the exception: a root input field exists only at deploy, and a platform variable only on the platform, so a schema refinement the type does not carry and a missing platform variable a service needs surface as early deploy-time refusals instead (see Two channels below). Typecheck, then build, then deploy; don't use the cloud to find out whether the wiring is correct.

Composer itself is target-agnostic: `@prisma/composer` carries authoring, testing, and the CLI, coupled to no platform. A deploy target is an extension registered in the deploy config; `@prisma/composer-prisma-cloud` is the Prisma Cloud target and the one this skill's deploy sections assume. Its root exports `compute`, `rawPostgres`, `bucket`, `publicUrl`, `variable`, `generatedParam` and `serviceOrigin`; the ORM vocabulary (`postgres`, `dataContract`) lives under the `/orm` subpath, alongside the shared `/cron`, `/storage`, `/streams`, `/auth`, and `/email` modules. These are the only two Composer packages a basic Prisma Cloud app needs, and nothing installs them for you: a fresh project starts with neither, so add both as dependencies first. An extension adds its own `prisma-composer-*` package alongside them. Compose an existing Module before implementing a capability yourself; wiring one in is a couple of lines.

Within the entry graph (everything reachable from `module.ts`), write
relative imports with explicit `.ts` extensions (`./service.ts`, with
`allowImportingTsExtensions` in tsconfig): that form resolves everywhere.
`prisma deploy` and `prisma dev` also map `./service.js` and extensionless
`./service` to the `.ts` source, but other tools may not.

## The service node is the only doorway

Your runtime code receives everything from the service declaration it
imports:

1. `service.load()`: dependencies (typed RPC clients, database bindings).
2. `service.input()`: the whole input as one schema-validated object;
   credentials in it are redacting `SecretString` boxes.
3. `service.port()`: the reserved port to bind (default 3000).

A service declaration is pure data; the server entry is what your build
produces and the platform boots:

```ts
// service.ts
export default compute({
  name: 'auth',
  deps: { db: rawPostgres() },
  build: node({ module: import.meta.url, entry: '../dist/server.mjs' }),
  expose: { rpc: authContract },
});

// server.ts
const { db } = service.load(); // { url }: you construct your own client
const handler = serve(service, {
  rpc: { verify: async ({ token }) => ({ ok: token.length > 0 }) },
});
Bun.serve({ port: service.port(), hostname: '0.0.0.0', fetch: handler });
```

The consumer declares `deps: { auth: rpc(authContract) }` and gets a typed
client back from `load()`.

## Two channels: dependencies and input

| The value is… | Declare | Provide | Read |
| --- | --- | --- | --- |
| produced by another node | `deps: { db: rawPostgres() }` | wire at `provision()` | `load()` |
| anything else (config or credential) | one field of the `input` schema | bind at `provision()`: literal, root input field, platform variable node's value, or a `resolve()` value | `input()` |

The service declares its whole incoming configuration, plain values and credentials together, as **one [Standard Schema](https://standardschema.dev)** (arktype is the house choice). A credential is a field typed as `secretString()` from `@prisma/composer/arktype` (or `@prisma/composer/zod` for a Zod schema; the app installs `arktype` 2 or `zod` 4 itself, and Composer uses that copy); conditional legality ("no stripe key unless billing is on") is an ordinary schema union. The binding at `provision()` mirrors the schema's shape.

A value you supply, rather than write in code, arrives in one of two ways:

- **A value the deploy reads** is a **root input field**: a field of the app root's `input` schema, filled by the `config` adapters (by default the deploying shell), checked by the root's schema before anything is created. The root passes it on by name. Only these can be listed in `resolve()` or put in a resource's props.
- **A value the service reads at boot** is a **platform variable node**, provisioned in the app root: `provision(variable({ name: 'EMAIL_FROM' }))` for a plain value, `provision(variable.secret({ name: 'STRIPE_SECRET_KEY' }))` for a secret. `provision()` returns the value with `id`, the node's address, on it; pass it down through module inputs to the services that read it. The node names the variable and never carries its value; the operator sets the value on the platform.

```ts
export default appRoot('shop', { input: type({ EMAIL_FROM: 'string' }) }, ({ input, provision }) => {
  const stripeKey = provision(variable.secret({ name: 'STRIPE_SECRET_KEY' }));
  provision(billing, { input: { from: input.EMAIL_FROM, stripeKey } });
});
```

**Only `appRoot()` can provision a platform variable node.** A variable's name is one space per deployed app, and the root is the app. In a `module()` body (a nested module or a `module()` root) `provision(variable(…))` fails to compile, with an error naming `appRoot()`. A module that needs the value declares a field in its `input`. The node creates nothing on the platform and stays out of the application topology and the deploy report; the loaded graph lists it and, in `graph.valueReads`, each service that reads it. Its default id is the name in camel case (`EMAIL_FROM` is `shop.emailFrom`); two nodes whose names give one id fail with an error naming both, so pass `{ id }`.

Rules that bite:

1. **Secretness is checked by the binding's type and by the deploy.** A `provision()` binding, a service's or a module's, is typed from the schema: a literal or a `SecretBox` where the schema expects `SecretString`, or a platform secret's value in a text field, fails to compile, and the deploy refuses it where the schema has no types. An ArkType schema with a `SecretString` field cannot also transform its input: a morph anywhere in it (`'string.trim'`, `.pipe()`, `field(type('string.integer.parse'))`) or `'+': 'delete'` copies the input, the copied secret loses its value, and the deploy refuses it. Transform in the service code instead; a Zod schema keeps the box.
2. **A plain platform variable's value is known only at boot: text, or the type its `schema` declares.** Bind it to a field wrapped with `field()`. A platform variable's value goes into a field of an `input` only. A compute service has one per-key param, the reserved `port`, which takes a literal or a root input field and no source, because the deploy needs the port before the service exists; every other value is a field of its `input`. A field of a narrower type, such as `email()`'s `deliveryMode`, takes a root input field declared with that type instead, for `email()` from the exported `emailDeliveryModes`; the deploy reads a root input field from the app configuration on every deploy and writes its value into the input document. A platform secret fits a `secretString()` field only. A platform variable's value always lives on the platform. The operator sets it there with `prisma project env add 'NAME=<value>' --project <id> --role production`. Use `--role preview` for every preview environment, or `--branch <environment>` for one. The deploy does not copy local values (`.env`, the shell) to platform variables. The deploy fails only when a variable that a service's schema requires has no value. The error names the variable and the command that sets it. The other variables with no value print under `Platform variables with no value:`. Prisma Cloud reports a service that exits at boot as running and promotes it; read the error with `prisma service logs <service>`.
3. **The schema decides whether a field may be absent.** A field bound to a platform variable that is unset or empty is left out at boot. That is allowed only if the schema allows it, for example with an optional field or a union member. An optional root input field that the adapters do not supply is left out at deploy. The deploy report prints the serialized input document (each secret shown as `$platform VAR`) and every key that resolved absent. On Prisma Cloud the deploy writes the input document into the service's artifact, not into a `COMPOSER_*` variable, so it is not limited to a variable's 8 KB, and a changed document redeploys exactly that service.
4. **The reserved `port` is outside the schema.** Read it through
   `service.port()`, never `process.env`. The framework also exports `PORT`
   for Next.js standalone, which binds it itself.
5. **A Module passes a secret on without learning the platform name.** Declare a `secretString()` field in the Module's `input` and pass `input.<field>` on as a binding leaf; the app root provisions `variable.secret({ name: 'NAME' })` and binds its value. A module has no `params` or `secrets` slots: `module()` and `provision()` refuse both, naming `input`. A service's `params` stay.
6. `input.apiKey.expose()` is the only way to a secret's value; the box
   redacts everywhere else (logs, JSON, errors).
7. **Platform variable names are upper case**: `^[A-Z][A-Z0-9_]*$`. `COMPOSER_…`, `DATABASE_URL`, `DATABASE_URL_POOLED`, `PORT`, `PATH` and `HOME` are reserved, each name is declared by one node, and one name cannot be both a platform variable and a root input field. A node's value bound as a service's whole input is refused too. Each fails before anything is created, naming the variable and the addresses.
8. **A field bound to a plain platform variable, `serviceOrigin()` or a plain `generatedParam()` is wrapped**: `field(type('string'))`. At deploy the schema sees a pointer, and a plain `'string'` field refuses it: a compile error in a service's or a module's binding, and a deploy error where the schema has no types. `service.input()` and `mockService`'s input double read the field as its inner type.
9. **A platform variable holds text; `schema` says what the text means.** `variable({ name: 'SMTP_PORT', schema: type('number') })` (any Standard JSON Schema library: ArkType, Zod) gives a runtime value of type `number`, which fits `field(type('number'))` and not `field(type('string'))`; without `schema` the value is the text and the reverse holds. An object schema fits a `field()` of the same object type. A schema that accepts only text gives the text exactly, untrimmed; any other schema reads the text as JSON (`587`, `true`, `{"host":"h"}`, `null` under `number | null`). A schema that accepts both, such as `string | number`, `z.unknown()` or `string | null`, is refused when the root body runs; for an optional text variable declare the text type and make the service's field optional. `variable.secret()` takes no schema.
10. **Boot decodes and validates the text against the variable's JSON Schema, then the service's schema runs.** A failure fails boot, not the deploy: read it with `prisma service logs <service>`. Messages name the variable and never hold its text: `The platform variable "SMTP_PORT" does not hold a number. Its schema is not a text type, so its text must be JSON, such as 587.`, `... does not fit its schema: it fails "minimum" at #/minimum.` A whole number above 9007199254740991 is refused: keep an identifier as text. A value nested more than 100 levels deep is refused too. `prisma dev` runs the same check before any service starts and adds `prisma dev cannot start, because service "<address>" reads it.`
11. **No library code runs on a variable's value; only the JSON Schema the library emits is checked.** A transform or a default the JSON Schema shows (`.transform()`, `string.numeric.parse`, a default inside an object) is refused at the root body; put defaults on the service's field. ArkType throws for `.narrow()` and `string.url`. Zod drops `.refine()`, and `.trim()`, `.toLowerCase()`, `z.coerce`, `z.preprocess()` and `.catch()` are accepted and do not run. An undeclared object key is not removed (`z.object()`, ArkType `'+': 'delete'`) and reaches the service's field. Regex flags are dropped and a pattern must be valid under the `u` flag (no `\-` outside a character class). `format` is checked for `date`, `time`, `date-time`, `duration`, `uri`, `uri-reference`, `uri-template`, `url`, `email`, `hostname`, `ipv4`, `ipv6`, `regex`, `uuid` and the three JSON Pointer formats; others, such as `z.jwt()`, are unchecked. `z.number().optional()` does not fit `field(z.number())`: make the service's field optional. A hand-written schema that contradicts itself fails every boot. Put any other check or change in the service's own schema.

### Values that differ per environment

The graph is the same in every environment; only configuration may differ.

- A module declares `input` (one Standard Schema) as a service does; `provision(module, { input })` binds it, and the body receives `input`, a dictionary of values: it passes each field on by name into a binding or, for a plain field, lists it in `resolve()`. Passing the whole `input` on fails to compile, and the deploy refuses it. A root's `input` is the app configuration, and a module's `input` takes every source a service's does.
- `field(inner)` from `@prisma/composer/arktype` or `@prisma/composer/zod` wraps one field's schema (`field(type('string'))`, `field(z.string())`) so it also accepts a plain pointer, which is what a value known only at boot such as `serviceOrigin()` is at deploy. In the body the field is `Value<string | Pointer<string>>`: pass it into another wrapped field or a service's input, never a plain `string` field (compile error). A wrapped field holds the whole value one source supplies, which may be an object or array when a platform variable's schema says so, so `field(type({ host: 'string' }))` is fine. An ArkType default goes outside: `field(type('string')).default('x')`. Other schema libraries: `Pointer`, `PlainPointer`, `isPlainPointer()` (narrows to `PlainPointer`) and `isSecretPointer()` from `@prisma/composer`. Wrap every field of a reusable module's schema other than a `secretString()` field, unless a `resolve()` lists it; keep a root's fields plain. `field(secretString())` is wrong: it accepts a plain pointer into a secret field, and the service fails at boot.
- `composer({ config: [...], secrets: [...] })` lists config adapters; each gets the environment's name and returns values, later wins by top-level key. Both default to `[environmentVariables()]` (the shell); a list you write replaces the default. `dotenv()` reads `.env`, `.env.local`, `.env.<environment>`, `.env.<environment>.local`, later wins. The app configuration fills the root's input (under `prisma dev` it also gives each plain platform variable a service reads its value, under the variable's name); pass the root's input fields on by name, as every module does; its whole `input` would be the whole app configuration, by default every shell variable. The app secrets give `prisma dev` its secrets; a deploy reads them only to redact. It does not fill a platform variable from them, and never reads them as the root's input. Both import from `@prisma/composer/config`. Credentials (`PRISMA_SERVICE_TOKEN`) still come from the shell. `dotenv()` reads `.env`, `.env.local`, `.env.<environment>`, `.env.<environment>.local` through `dotenv-flow` (no `.env.local` for `test`); remove `import 'dotenv/config'` when you list it. Composer redacts the values under the names of the graph's platform secrets, in either list; the lists' other values are not secrets and print as they are, apart from values that look like credentials. Under `prisma deploy` the engine's output is redacted too; under `prisma dev` it is not yet.
- A field exists only under a plain object: a path into a string, an array or a secret, such as `input.tags[0]`, fails the deploy naming the path.
- A truthiness check such as `if (input.enabled)` is not caught: the field is an object, so the branch always runs, in every environment. A module's structure cannot depend on its input; to provision something only sometimes, let the parent decide whether to provision it.
- The module body receives `environment`; `environment.name` is a value standing for the name `--environment` gave (`production` for `prisma deploy`, `dev` for `prisma dev` by default).
- `resolve([deps], ([values]) => …)` from `@prisma/composer` returns a computed value; `fn` receives the dependencies' real values as one tuple.
- A value is accepted as a leaf of a service's or a module's `input` binding, at any depth, as a service param (a deploy-time value only), as one of a `resource()` node's `props`, or as a public URL's `url`. Never as a provision id or a `deps` entry.
- A value is opaque in the body: you cannot read, compare or branch on it. List it as a `resolve()` dependency instead.
- Calling `provision()` inside `fn` fails the load: `fn` computes configuration, never graph structure.
- `fn` is pure and synchronous and returns plain data (no `undefined`, Promise, value or source); a deploy and `destroy` both run it, in two processes. To retire an environment, keep its case in every `fn` until `destroy` for it has finished.
- Sources are values. `resolve([input.X], ([x]) => …)` over a root input field receives its data. A dependency must be a deploy-time value: a platform variable's value, `generatedParam()`, `serviceOrigin()`, a field wrapped with `field()` and a `secretString()` field cannot be listed (a compile error saying so; for a field typed `unknown` or a cast, the deploy fails naming the field). Bind those directly; to compute with a field, declare it plain. For a different secret per environment, use one name with a different value on each environment.

## Contracts and RPC

An RPC contract is the typed interface through which services communicate. It
lives with the service that owns it, typed by any Standard Schema validator,
and both provider (`serve()`, exhaustive over the contract's methods at
compile time) and consumer (`rpc(contract)`) reference the same value. Calls
travel as RPC over HTTP. Two behaviours are provisioned for you and must not
be reimplemented:

1. **Service keys.** At deploy, Composer mints a distinct unguessable key per
   consumer→provider binding; `serve()` returns `401` to anything else before
   the handler runs. Nothing in your code declares it. Consequences: don't
   build your own service-to-service auth, and don't `curl` a deployed
   `/rpc/<method>` to check it works. An unwired caller always gets `401`,
   which looks like a broken deploy and isn't. Debug through a consumer, or
   locally, where nothing is enforced. Keys are per binding (one leaking
   can't impersonate another consumer), service-scoped (any valid key
   reaches every method; split services to gate separately), rotated only by
   removing the binding or destroying the stack and redeploying, and stored
   in deploy-owned `COMPOSER_*` variables you never hand-edit.
2. **Idempotency and retries.** Every generated-client call carries an
   `Idempotency-Key`; dropped calls retry with backoff, and `serve()` runs
   one call per key, replaying the completed answer to late retries. Every
   method is therefore safely retryable and no contract declares anything
   about it (there is no "is this idempotent" flag; don't invent one). A
   handler may take an optional third argument `(input, deps, ctx)` and read
   `ctx.idempotencyKey` (`string | undefined`) if it needs exactly-once
   beyond one instance's memory; most don't. Locally and in tests nothing is
   provisioned, so `serve()` passes every call through: never supply a key
   in test inputs.

## Raw HTTP connections

For a server Composer does not generate (a reverse proxy's upstreams, a
Next.js app, a static file server), import `rawHttp` and `rawHttpContract`
from `@prisma/composer/http`. The provider declares
`expose: { http: rawHttpContract }`; the caller declares
`deps: { site: rawHttp() }`; the Module wires
`provision(gateway, { deps: { site: siteRef.http } })`. `gateway.load().site`
is `{ url, fetch(path, init) }`, where `fetch` resolves `path` against `url`.
The client never leaves its provider's origin by itself: `fetch` rejects a
path that resolves to another host (`//other.example/x`, an absolute URL), and
returns redirects to the caller instead of following them, unless `init` sets
`redirect: 'follow'`.

Composer checks only that the provider declared an HTTP port: TypeScript and
Load reject a bare service ref or a port of another kind. The caller is
responsible for knowing the provider's paths, methods and headers. Raw HTTP
has no service key, retry or idempotency key; authentication, if needed, is
the app's. Each dependency shows in the application topology as a call, also
through module boundaries; a URL passed as `input` (`serviceOrigin()`)
does not, so declare a dependency for every service you call. The auth
module's `api` port is a raw HTTP port: wire it with `rawHttp()`.

**Public URLs.** A service is reachable from the internet only through a
public URL the app declares:
`provision(publicUrl({ id: 'site', url, target: web.http }))`, where `id`
sets the address (`shop.site`) and changing it replaces the URL, and where
`web` exposes `http: rawHttpContract` (an RPC interface as `target` fails
`tsc`; a module's forwarded HTTP interface lands on the service inside it).
`url` is required and is one of two strategies: `publicUrl.prismaBuild()`
serves at the service's `prisma.build` hostname and creates nothing;
`publicUrl.hostname('shop.com')`, or the bare string `'shop.com'`, attaches
that hostname to the service as a custom domain. One hostname per public URL.
A per-environment `url` is a `resolve()` value returning either strategy or a
string; anything else fails deploy and dev before any of the app's resources
are created or changed. Before
a deploy names a hostname, the TXT record `_prisma-verification.<hostname>`
and a CNAME to the platform must be published, or the deploy fails with the
platform's error (`domain-ownership-required` for the TXT record); don't
work around it, publish the records or use `publicUrl.prismaBuild()` there. A
change from a serving hostname to one that is not ready fails the deploy and
the old hostname keeps serving. `prisma dev` ignores a named hostname and
warns once per public URL that names a hostname. A service with no public URL is still reachable at
its `prisma.build` hostname today.

## Builds are yours

You build, the framework assembles. For a plain server process, `entry`
points at the ESM file your build produced. By default
(`dependencies: 'bundled'`) deploy copies exactly that and never ships
`node_modules`, so everything except runtime built-ins (`bun`, `bun:*`,
`node:*`) must be inlined, or it fails at boot, not at deploy. Rules that
bite:

1. **Two services in one package means two separate builds**, one per entry.
   A single multi-entry build splits shared code into a chunk neither output
   contains.
2. **A directory build uses `dir` + `entry`** (`dir` relative to the service
   module, `entry` a file inside `dir`; `../` is an error). The tree is
   copied verbatim, so the server must resolve siblings against
   `import.meta.url`, not the working directory. The tree must contain no
   symlinks: the packager rejects them, names the link, and assembly fails.
3. **A build that leaves packages external sets `dependencies: 'external'`**
   (either form). Deploy then traces `entry` and stages the installed
   packages it imports, which can take minutes on a large build. Astro's Node
   adapter, SvelteKit's `adapter-node` and React Router's server build leave
   packages external by default. The default, `'bundled'`, copies exactly
   what was built. A service that fails to start with
   `Cannot find package 'x'` needs `x` bundled, or `dependencies: 'external'`.
4. **Next.js**: `next build` with `output: 'standalone'` is the whole build;
   `nextjs({ module, appDir })` names the app root. Any page or action that
   calls `load()` needs `export const dynamic = 'force-dynamic'`, because
   the runtime environment variables don't exist at build time and Next ignores
   runtime env for prerendered routes. `prisma dev` needs no build for it: it
   runs `next dev` instead (see Local development).
5. **Always build before `deploy`, and before `dev` for a service without a
   dev server.** Neither builds for you. `node({ ..., dev: ['bun', '--watch',
   'server.ts'] })` gives a node service a dev server: `prisma dev` runs that
   command (in the authoring module's directory, nothing appended; it must
   listen on `PORT`) instead of the built `entry`.

Deploy configuration is the `composer` section of `prisma.config.ts`, and
nothing else. It names the entry module, the file whose default export is the
app root (`entry`, relative to the config file; `--entry <path>` overrides it
for one run), and registers extensions (`prismaCloud()`, `nodeBuild()`,
`nextjsBuild()` when the app has a Next.js service) and the deploy-state
backend (`prismaState()`):

```ts
// prisma.config.ts
import { defineConfig as composer } from '@prisma/composer/config';
import { nodeBuild } from '@prisma/composer/node/control';
import { prismaCloud, prismaState } from '@prisma/composer-prisma-cloud/control';
import { definePrismaConfig } from 'prisma/config';

export default definePrismaConfig({
  composer: composer({
    entry: './module.ts',
    extensions: [prismaCloud(), nodeBuild()],
    state: prismaState(),
  }),
});
```

The commands find `prisma.config.ts` from the directory they run in, walking up
to the repository root; the nearest file that declares `composer` wins, and its
section is used whole, never merged key by key. Only `entry`, `extensions` and `state`
are allowed; any other key is an error. App code never imports the file.

A separate `prisma-composer.config.ts` is no longer read, and the old setup is
refused, never silently ignored: `CONFIG.SECTION_MISSING` when no loaded
`prisma.config.ts` declares a `composer` section, `CONFIG.FIELD_RETIRED` when
the section still has `configPath`, `CONFIG.FILE_RETIRED` when a
`prisma-composer.config.*` sits next to the declaring `prisma.config.ts`; all
three under the CLI's `CLI.CONFIG_SECTION_INVALID`. `SECTION_MISSING` is fixed by
adding the `composer` section to `prisma.config.ts`. `FIELD_RETIRED` and
`FILE_RETIRED` are fixed by moving the old file's `extensions` and `state` into
the section, then removing `configPath` or deleting the old file.
`@prisma/composer-cli/family` no longer exports `ComposerSection`; the
section's type is `PrismaAppConfig` from `@prisma/composer/config`.

## Databases and migrations

Two kinds of Postgres dependency:

1. **`rawPostgres()`**: the binding is `{ url }` and the app owns its client.
2. **`postgres(...)`**: a Prisma-ORM-typed database. The binding is
   `{ url, connection, client, clientWith }` (ADR-0040, ADR-0055): the raw
   connection URL, the connection pool, the typed client Composer constructs
   from your data contract lazily on first access, and `clientWith(options)`,
   which builds a typed client with Prisma ORM runtime options. Queries go
   through `binding.client` and are compile-time checked. Both `postgres` and `dataContract` import from
   `@prisma/composer-prisma-cloud/orm`, not the package root. One
   `dataContract`-wrapped value (emitted from `contract.prisma` by
   `prisma contract emit`) is referenced by both the dependency end
   (`deps: { db: postgres(catalogData) }`) and the resource end, which also
   names the `prisma.config.ts` path so the deploy's migration step can
   reload the emitted `contract.json` and find `migrations/`.
   Client options never go on the dependency declaration. A contract that
   uses an extension type (for example `pgvector.Vector(length: 1024)`)
   needs the pack's runtime extension when the client is built:
   `export const orm = db.clientWith({ extensions: [pgvectorRuntime] })`,
   where `pgvectorRuntime` is the default export of
   `@prisma/orm-extension-pgvector/runtime`; other runtime options, such as
   `middleware`, go in the same object. Install the pack at exactly the
   `@prisma/orm-postgres` version: the pack pins the ORM's shared packages
   to its own version, so a mismatch installs two copies that silently
   reject each other's values. Composer never looks extensions up itself;
   with `binding.client` instead, the first access throws
   "Contract requires extension pack(s) 'pgvector'".

**Deploys are replay-only**: they apply the migrations committed under
`migrations/` and never create schema themselves. Every schema change,
including the first schema of a new database, follows one loop:

1. Edit `contract.prisma`.
2. `prisma contract emit` regenerates `contract.json` + `contract.d.ts`.
3. `prisma migration plan --name <slug>` authors the migration (on an empty
   graph this authors the baseline).
4. Commit `migrations/` with the change, then deploy. A fresh database
   replays the whole path from empty.

Every service that uses the database deploys only after its migration
completes: a failed migration means the new code does not ship. The old
code serves against the new schema until the new deployment is live, so
keep each migration compatible with the code it replaces.

If no authored path reaches the target contract, deploy (and `dev` against a
stale local database) refuses with `MIGRATION_PATH_NOT_FOUND`; its message
lists the two ways out: author the missing migration, or, when iterating
against a local
database only, `prisma db update`. The tracked migration resource persists only
compact contract identity in deploy state; if the emitted contract artifact
named by `prisma.config.ts` is missing, unreadable, or no longer matches the
declared `dataContract(...)` value, deploy fails before touching the database.
Never skip step 3 before a deploy. See `examples/store/modules/catalog` for the
complete pattern.

## Deploy model: converge, don't script

Deploy compares the declared topology against recorded deploy state and
applies only the difference. Re-deploying with nothing changed is a no-op;
removing a node removes its deployed resource. `prisma deploy` needs a signed-in
identity: `prisma auth login` stores a session on a developer machine, and
`PRISMA_SERVICE_TOKEN` overrides it in CI. The `/control` operations, and so
a destroy script, never use that session: `deploy` and `destroy` read
`PRISMA_SERVICE_TOKEN` and `PRISMA_WORKSPACE_ID` from environment variables (both
in the workspace's Console settings); `dev` and `log` read neither. The
`prisma` bin starts under Node; use `pnpm prisma …` or `npx prisma …` by
default. Composer starts Alchemy with Node, but Alchemy's launcher moves to
Bun under `bunx` or `bun run`: `bunx prisma` gives Node then Bun,
`bunx --bun prisma` Bun then Bun. When the modules `module.ts` imports use
Bun APIs, `bun node_modules/prisma/dist/prisma.js deploy` from a
shell runs `prisma` under Bun with Alchemy on Node.

A node's **address** is the app name followed by the provision ids down to it
(`shop.auth.api`); the root's address is the app name, or `--name` when given.
Every surface uses this full form: `serviceOrigin('shop.api')`,
`prisma dev url shop.api`, the `log` operation's `address`, errors and reports.
Services, managed Postgres databases and buckets record their address as
`logicalId` on their Branch. Console uses that address to match topology nodes
to resources and compare them with main. Existing environments receive the
identity on their next deploy. A deploy interrupted after creating a resource
resumes on the next deploy, which finds the resource by its address. Local dev
creates no platform rows. Changing a node's address (its name without an
explicit `id`, its `id`, or its module) makes a new entity: the next deploy
deletes the old rows, and a database's or bucket's data with them.

**Progress.** `prisma deploy` prints each step as it starts and finishes, with its duration (`✔ assemble web (3m 42s)`), and ends with the real total (`Deployed <app> to <environment> in 5m 25s.`). Steps: load config and app, one assemble per service, connect to project and branch, check environment variables, plan and apply (one step: alchemy does both in one process), record result. A slow assemble is usually a Node service with `dependencies: 'external'`, whose runtime dependencies are being traced. With `--json`, each step is a `step-started`/`step-finished` line whose `data` holds `durationMs` plus whatever the build adapter or deploy target reported; those extra fields vary, so don't parse them as a stable format. The `deploy` operation's `onEvent` receives the same steps, its result's `durationMs` is the total, and its `summary.findings` lists the platform variables with no value.

**Environments.** An environment is a named place the app runs, chosen with
`--environment` at deploy time, never written in the topology. The identical
graph deploys everywhere. `prisma deploy` without the flag deploys
`production`; `prisma dev` runs as `dev` and takes no flag. On the Prisma Cloud
target, a Prisma App is one Project and an environment is a Branch of it, with
its own running services, its own empty database, its own configuration:
`production` is the Project's default Branch, any other name is the Branch
with that `gitName`, created if absent. The default Branch's own name (such as
`main`) is refused, since it would be production under a second name. A name
must be a valid git ref name, or the deploy fails with
`DEPLOY.ENVIRONMENT_INVALID`.

**Seeing what is deployed.** `prisma deploy list [--environment <name>]` lists every
node of the topology the last deploy recorded, with its kind, platform ID and,
for a service, its URL; the root's ID is the Project's, and a module has none.
It finds the app as `deploy` does (`--name`, `--entry`) and fails with
`DEPLOY.TARGET_NOT_FOUND` when the environment has nothing deployed. Piped:
address, kind, platform ID, URL per line; `--json`: `[{ address, kind, platformId, url }]`. It needs
a `prisma` CLI release that includes it; 8.0.0-rc.26 does not.

**Using an address with platform commands.** A `prisma project|service|postgres|bucket`
command takes `@<environment>:<address>` in place of the platform ID
(`prisma service logs @pr-42:shop.api`); no environment means production. It
acts on that one row. Deleting a service, database or bucket this way leaves
the deploy state alone, so the next deploy recreates it; deleting the Project
removes its deploy state too. It needs a `prisma` CLI release newer than
8.0.0-rc.28.

**Removing an app** with every environment is a platform command: find the Project
id with `prisma project list`, then `prisma project delete <id> --confirm <id>`,
and check `prisma project list` again to confirm it is gone. It works while the
app's services are running. Don't write a script for this.

**Destroying one environment** is the `destroy` operation, and its
`environment` is required, even for production; it has no default and a call
without it fails with `DEPLOY.ENVIRONMENT_REQUIRED`:

```ts
await destroy({ entry: 'module.ts', environment: 'pr-42', config });
await destroy({ entry: 'module.ts', environment: 'production', config });
```

Destroying any environment other than production
deletes its Branch after removing its resources. Destroying production
removes only the resources inside the production Branch, never the Branch
itself directly; once the Project is empty it is deleted too, and that
deletion takes the production Branch with it. A Project still holding
another environment's resources is kept. Destroy never creates anything:
destroying a
never-deployed environment fails rather than standing one up.

**Upgrading from stages.** `--stage <name>` is now `--environment <name>`;
`destroy({ target })` is now `destroy({ environment })`, with production as
`'production'`; the `--report` file's `stage` field is now `environment`, at
`version` 2. Keep `@prisma/composer-prisma-cloud` on the same Composer version
as the Composer that runs the deploy. An older extension would read every
environment as production, so deploy and destroy refuse it with
`DEPS.EXTENSION_INCOMPATIBLE`.

**The engine underneath is alchemy.** Convergence is executed by [alchemy](https://alchemy.run), a third-party infrastructure-as-code engine that arrives as an ordinary, exactly-pinned npm dependency of `@prisma/composer` (2.0.0-beta.87 at this library version). Your code never imports or configures it; consult alchemy's own docs for the engine itself. What matters operationally:

`prisma deploy` runs alchemy inside the `prisma` process through alchemy's programmatic API: no generated file and no child process. Its progress prints as one step per resource, and a failure is `DEPLOY.ENGINE_FAILED` carrying the engine's own errors (credentials redacted, capped at 1000 characters), or `DEPLOY.INTERRUPTED` after Ctrl-C, which releases the environment's lease. `prisma dev` runs alchemy in the `prisma` process too, each converge in a new worker thread, so an edit to your app definition applies on the next rebuild. Three kinds of edit need `prisma dev` restarted, and it says so: adding or removing a node, making the root pass on an input field it did not pass on at start, and changing which platform variables the app reads. The `destroy` operation runs alchemy inside the process that calls it, the same way as deploy. The alchemy that runs is the one installed beside the app's `@prisma/composer`, so the app needs no direct `alchemy` dependency, and no global Alchemy installation is needed.

1. No command writes a stack file or starts the alchemy CLI. An engine failure surfaces as `DEPLOY.ENGINE_FAILED` carrying the engine's own errors (credentials redacted, capped at 1000 characters), for deploy and destroy alike.
2. Destroy runs the same preparation as deploy, assembly included, so **an app must be built before it can be torn down**.
3. alchemy is why the `effect` pin exists: it resolves the `effect`
   constellation, and a hoisted newer `effect` halts every command (failure
   mode 1 below).

**The deploy report** ends with the app's own topology: authored names, the
platform resource each became, and public URLs. Read ids out of it rather
than hunting in the Console. A URL appears only where the address is
genuinely public: a service prints one, a database never does, and a
node whose product is secret material reports no resource line at all.

**Connection contract refusals.** A connection declares the values it needs
by name; a producer that omits one fails the deploy, naming the edge, the
param, and what the producer did supply:

```text
Connection input "auth.db" declares param "url", but its producer "db" did not
supply it — the producer's outputs carry [host].
```

This is a deploy-time refusal, not a broken deploy, and it can appear on an
app whose code didn't change (the gap used to pass silently as `undefined`
and crash the consumer at boot). Fix whichever end is wrong; don't mark the
param `optional` unless absent really is legal. Only reachable if you
authored the connection or an extension on one side.

**Driving deploys from code.** A script imports only
`@prisma/composer/control`; the extensions' `/control` entries are imported
only by `prisma.config.ts` (ADR-0017). `@prisma/composer/control` exposes typed
`deploy`, `destroy`, `dev`, `devUrl`, `devStop`, and `log` returning structured
results; `prisma deploy`, `prisma dev`, `prisma dev url` and `prisma dev stop`
render `deploy`, `dev`, `devUrl` and `devStop`. Each takes
a required `config: { value, file }` (`ComposerConfigSource`): the `composer`
export of your `prisma.config.ts` and that file's path; a relative `file`
resolves against `cwd`, so build it from `import.meta.url`. The operations
never look for a config file, but refuse what the CLI refuses before any work
starts (`CONFIG.FIELD_UNKNOWN` for the whole export instead of its `composer`
property, `CONFIG.FILE_RETIRED`, `CONFIG.FILE_MISSING`); the deploy re-imports
`file`, so `value` must be its `composer` export. Failures come back as
`{ ok: false, failure }` with a dotted `failure.code` from a closed registry
(e.g. `ASSEMBLE.BUILD_FAILED`, `DEPLOY.ENGINE_FAILED`,
`DEPS.EXECUTOR_UNLOADABLE`); branch on the code, not the message. A
non-structured rejection out of an operation is a bug in composer, not an
expected failure.

## Local development

`prisma dev` runs the whole app on this machine, wired as it deploys,
against local emulators. No cloud credentials are needed or read. Concepts
that surprise:

1. It runs the same pipeline as deploy, so **build first**, exactly like
   deploy, except for a service that runs a dev server (below). It watches
   built output and restarts a service when its build changes.
   **Dev servers.** A service whose build adapter declares one runs it in
   place of its artifact, with no flag: every `nextjs()` service runs
   `next dev` (the app's own `next`, resolved from `appDir`), and a `node()`
   service runs its `dev` argv when it has one. It runs on the service's
   instance and URL, with the deployment's environment variables: `service.load()`,
   `service.input()` and `service.port()` work exactly as deployed, so never add a
   `process.env` fallback for plain `next dev`. It also keeps the shell's
   environment variables; Composer's values win. `dev` prints ``<address>: runs
   `<command>` in <dir>`` before the app comes up and streams the dev
   server's output prefixed `[<address>]` (other services' logs are not
   streamed). Source edits are the dev server's own hot reload; `dev` watches
   the entry and every app file it imports, applies an edit to them on the
   next rebuild (adding or removing a node, passing on a new root input field, or changing which platform variables the app reads needs `dev` restarted, and it says so), and restarts a dev server only when its environment variables changed
   (``<address>: its environment changed; `<command>` restarted``). It has no
   terminal (no colours or key shortcuts). The standalone build is not run
   locally, so a standalone-only bug surfaces at `prisma deploy`. Next.js
   refuses a second `next dev` for the same app: use the service URL.
   `prisma dev url <address> --json` reports `runs: "dev-server"` or
   `"artifact"`. Errors: a dev server that never listens on its `PORT` fails
   with `DEV.SERVICE_START_FAILED` plus `A dev server must listen on the port
   in its PORT variable.`; `DEV.DEV_SERVER_UNAVAILABLE` (e.g. `next` not
   installed in `appDir`); `DEV.DEV_SERVER_UNSUPPORTED` (the service's package
   is too old; the message names it).
   `ready` prints only once every service accepts connections on its port, except a service declared `compute({ ..., listens: false })` (one that never listens, like the cron scheduler), which counts as running once its process starts. A service that exits before it listens, or does not listen within 30 seconds, fails `dev` (and stops the app's other services) with a message naming the service, its port, and its log file: on a first start it is in the deploy engine's output, before the error that the deploy engine exited (`DEV.CONVERGE_FAILED` from the `dev` operation); on a warm start it is the `DEV.SERVICE_START_FAILED` message. `PRISMA_COMPOSER_SERVICE_READY_TIMEOUT_MS` raises the 30-second limit (milliseconds); the compute emulator reads it when it starts, so a running emulator keeps its old value until its process ends. An emulator that does not accept connections fails `dev` and `log` with `DEV.EMULATOR_UNREACHABLE` after a few seconds of retries; nothing else is retried.
2. Ctrl-C (or `dev` ending on SIGTERM or a failure) stops the app's service processes and its local Postgres servers and keeps their data and ports: the next `dev` is a warm start. Starting clean, wiping this app's local instances and data in this environment first, is an explicit opt-in flag (`--fresh`). On a fresh start, each service gets the lowest free port from 3000 up, in dependency order: a service before the services that call it, otherwise provision order. A warm start keeps the ports services already have.
   Services, databases and buckets belong to the directory `dev` runs in: two checkouts of one app (two git worktrees) run separate processes on separate ports, with separate databases and buckets, and never restart or write into each other's. `.prisma-composer/dev/<environment>/emulator-instances.json` records which local instance backs each node. A service or database keeps its port in its directory across runs, even while stopped. If a local instance is gone (a Composer upgrade discarded an emulator's state), the next `dev` re-creates it, empty, and asks for the old port, and a Prisma ORM database's (`postgres()`) committed migrations run again (a `rawPostgres()` database stays empty); when another directory has taken the port, the instance gets the lowest free one and `dev` prints `[dev] service "<address>" now uses port <new>: its previous port <old> is in use` (`database "<address>"` for a database). `dev` runs as the environment `dev`; `--environment <name>` runs a complete, separate local copy with its own services, databases, buckets and ports, beside any other. Running a different app or environment stops nothing. For tests that must not touch working data, use `prisma dev --environment test --fresh --detach`, and pass the same `--environment` to `dev url` and `dev stop`. `--fresh` wipes only the app it starts, in its environment. Names that differ only in case share one folder on a case-insensitive filesystem (macOS), so a name that differs from the one the folder records is refused with `DEV.ENVIRONMENT_NAME_MISMATCH`. Everything local to one copy lives in `.prisma-composer/dev/<environment>/`; the first `dev`, `dev url`, `dev stop` or `log` after upgrading from a version with one copy per directory moves the existing local state into `dev`, keeping its data. An older `@prisma/composer-prisma-cloud` is refused with `DEPS.EXTENSION_INCOMPATIBLE`. A stopped instance keeps its port reserved and a database its data, so a deleted checkout's instances keep theirs; there is no command to remove them yet.
3. `dev` does not print the logs of services that run their artifact. The
   `log` operation follows the already-running app's merged logs; it never
   builds, provisions, starts, or stops anything:

   ```ts
   const attached = await log({ entry: 'module.ts', config, tail: 20, signal });
   if (attached.ok) for await (const { service, line } of attached.value.lines) console.log(service, line);
   ```
   Don't hard-code a local port; ports differ per directory. `prisma dev url
   <address>` (run in the same directory as `dev`; `--environment`, default `dev`, picks the copy; the address's first segment names the app, and no entry is loaded) prints where a running node
   answers: a service's `http://localhost:<port>`, a database's connection
   string, a bucket's S3 endpoint plus `/<bucket>`. The URL alone goes to
   stdout, piped or not, so scripts use `url=$(prisma dev url shop.gateway) && curl "$url"`
   (`dev url`, `dev stop` and `emulator list` first ship in the `prisma`
   release after 8.0.0-rc.23).
   `--json` gives the full result or the error with its code. It fails with
   `DEV.NOT_STARTED_HERE` (that app never ran in that environment here), `DEV.ADDRESS_UNKNOWN` (lists
   the known addresses), `DEV.EMULATOR_UNREACHABLE`, or `DEV.NOT_RUNNING` (the
   node is stopped, a service is crash-looping and its log is named, or the
   emulator lost the node and the next `dev` creates it again).
   `prisma dev stop` stops the app's services and database servers in one
   environment (`--environment`, default `dev`; the app comes from the entry
   or `--name`) when `dev` was killed without doing it; data and ports stay. It lists what it
   stopped, and says so and still succeeds when nothing was running.
   `prisma emulator list`
   shows every local emulator and its instances, from any directory; one that
   runs but cannot be listed carries an `error` in its own entry. Piped, it
   writes one tab-separated line per instance: emulator kind, instance id,
   URL, state, node address, directory, environment.
   `prisma emulator start` and `stop` are planned.
   Prisma 7's `dev ls`, `dev rm` and `dev start` fail with `CLI.V7_COMMAND`,
   and `--port`, `--db-port`, `--shadow-db-port` and `--debug` on `dev` (and
   `--debug` on `dev stop`) with `CLI.V7_FLAG`, both exit 2 and say why:
   use `emulator list` for `dev ls`, `dev --detach` for `dev start`, and
   `dev --fresh` (deletes the app's local services, databases and buckets in
   one environment, and their data) for `dev rm`; the flags point to the
   command's help. Each error also says how to keep using Prisma 7: install
   its CLI with `npm install --save-dev @prisma/prisma7@7` and run the
   Prisma 7 command as `prisma7 …`, with a placeholder for each value it
   needs (e.g. `prisma7 dev rm <name>`). Ports cannot be set; ask
   `dev url` where a node answers.
   For agents, scripts and CI, `prisma dev --detach` runs the app in
   the background: it exits 0 once every service answers and prints the URLs,
   does not watch for changes, and leaves the app running until
   `prisma dev stop`. Use it, then `prisma dev stop`, instead of keeping a
   foreground `prisma dev` alive. A failure before ready stops the whole
   app, including one an earlier `--detach` left running (a failed redeploy
   has already replaced that service's process), and exits non-zero: fix the
   build and run `prisma dev --detach` again.
4. `dev` reads `prisma.config.ts` once, at start, and watches it: after an
   edit it says so and pauses rebuilds until you restart `dev`.
5. `dev` reads secrets only from the `secrets` adapters. Put them where a `secrets` adapter reads them: the shell by default, or `.env.dev` with `secrets: [dotenv(), environmentVariables()]`. A required secret that is unset or empty stops `dev` with an error naming it; an optional one reaches the service as absent. A changed value takes effect on the next `prisma dev`. A `.env` that only the framework loads (Next.js) does not count: Composer reads secrets before the dev server starts. A plain platform variable (`variable({ name })`) comes from the `config` adapters, under the variable's name, read at start: set it in `.env.dev` or the shell. A value that is not text stops `dev`, and so does a typed variable's text that does not decode or fit its schema. If a rebuild changes which platform variables the app reads, or where, `dev` warns that the platform variables the app reads changed and pauses rebuilds until you restart it. An edit to `module.ts` or a file it imports is applied by the next rebuild; one that adds or removes a node fails that rebuild and says to restart `dev`.
6. The emulators are machine-wide daemons shared by every `dev`, registered
   under `~/.prisma-composer/emulators`. Set `PRISMA_COMPOSER_EMULATORS_DIR`
   to an absolute directory to give a checkout or CI job its own compute,
   Postgres and buckets daemons, registry and state; a relative path (or an
   unexpanded `~`) fails with `DEV.EMULATORS_DIR_INVALID`. A local database's
   data is kept by `@prisma/dev` in its own data directory under a name unique
   to the database, whatever the variable says. `emulatorRegistryRoot()` from
   `@prisma/composer-prisma-cloud/local-target` returns the directory in
   effect.
7. Windows isn't supported yet.

Local Postgres runs on `@prisma/dev`, which `@prisma/composer-prisma-cloud`
declares as its own dependency (`^0.25.2`) and resolves from its own package.
Nothing needs adding to the app, and an app's own `@prisma/dev` (for example the
`^0.20.0` alchemy pulls in, which crashes on any Postgres message over 64 KiB) is
ignored. If the emulator reports that `@prisma/dev` did not resolve, the install
is broken: reinstall dependencies rather than adding `@prisma/dev` or `prisma`.
Cloud deployment and local apps without Postgres never load this runtime.

## Testing is a dependency-injection seam

A test decides what `load()` and `input()` return, never by editing the code
under test.

| You want to… | Use | From |
| --- | --- | --- |
| Test a page / action / handler in isolation | `mockService` | `@prisma/composer/testing` |
| Run the real boot + request path against a fake dependency | `bootstrapService` | `@prisma/composer-prisma-cloud/testing` |

`mockService` returns a copy of the service whose `load()` yields your
doubles (type-checked against the declared deps) and whose `input()` yields
the object passed under the reserved `input` key (required exactly when the
service declares an input schema, typed as `service.input()` returns, with no pointers; handed over as-is, not validated). Wiring
the module substitution is your runner's job (`vi.mock` in Vitest,
`mock.module` in bun test).

`bootstrapService` boots the service's real built entry in-process against a
config you choose; drive it over real HTTP. Gotchas:

1. `service.port` must be concrete: the entry self-listens, and no
   OS-assigned port is reported back.
2. There is no `close()`; run each integration-test file in its own process
   (bun test does).
3. Next.js services take a third argument, a boot thunk, resolved with
   `standaloneServerPath` from `@prisma/composer/nextjs/control`.
4. A service with an input schema takes `input` in the config, a binding
   exactly like `provision()`'s, run through the real serialize/read path.

A dependency's type is its contract, so any value of that shape is a valid
double: a bare object, the real client over an in-memory handler, or a real
local server. Ship a dependency's fake from its own package as a `/fake`
entry point, outside `src/`, so the fake and the real service share one
contract.

## Building blocks and extensions

First-party Modules ship inside `@prisma/composer-prisma-cloud` and
provision exactly like your own:

| Import | What it provisions | Exposes |
| --- | --- | --- |
| `cron` from `/cron` | An always-on scheduler (it holds Compute's keep-awake guard) firing your schedule at your runner service; `input` on `cron()` binds the runner's input schema | nothing |
| `storage` from `/storage` | An S3-backed blob store (own Postgres + minted credentials) | `store` |
| `streams` from `/streams` | Durable append-only event streams over a `store` | `streams` |
| `auth` from `/auth` | Signup, login, sessions, and JWT verification (Better Auth in one service, own database). `auth({ signUp: 'closed' })` makes Better Auth refuse self-service sign-up; operator-created accounts go through `admin.createUser({ email, name, password?, emailVerified? })` from a service wired to `admin` (it throws on a duplicate email and sends no mail); a signed-in user deletes their own account with Better Auth's `POST /api/auth/delete-user` through the proxy (password, or a session < 24 h old); operators delete with `admin.removeUser({ userId })`; either way your own rows follow your `auth:User` FK's `onDelete` (`Cascade` deletes them, `Restrict` refuses the deletion). Bind `input: { baseUrl }`, the public app origin: `serviceOrigin('<app>.<service>')`, a root input field or a literal. | `api`, `session`, `admin` |
| `email` from `/email` | Transactional email with a stored outbox (own service and database). Bind `input: { deliveryMode, from, deliveryCredential }`; the credential with a platform secret's value (`provision(variable.secret({ name: 'EMAIL_DELIVERY_CREDENTIAL' }))` in the root), required even when `deliveryMode` is `none`. `deliveryMode` is one of `emailDeliveryModes`; bind a literal or a root input field declared from it (`type.enumerated(...emailDeliveryModes)`, `z.enum(emailDeliveryModes)`). | `send`, `outbox` |

`bucket()` (imported alongside `rawPostgres`) is a raw S3-compatible bucket:
the dependency end receives `{ url, bucket, accessKeyId, secretAccessKey }`,
shape-compatible with `/storage`'s `s3()` dependency, so a service wired to
`s3()` can be rewired to a `bucket` resource unchanged.

An extension (a package bringing its own Modules, resources, or deploy
target) is published on npm as `prisma-composer-*`. The ecosystem is new:
today the blocks above plus your own Modules are the whole set, so verify a
`prisma-composer-*` package exists on npm before reaching for it.

## Failure modes quick reference

1. **`prisma deploy` and `prisma dev` stop with `CLI.CONFIG_UNREADABLE` on an
   `effect` version conflict** (`prisma.config.ts could not be evaluated:`
   followed by a module error from inside alchemy, such as
   `Schema.TaggedError is not a function`). The extensions in the `composer`
   section import alchemy, and the app, or one of its dependencies, pins a
   different `effect` that the package manager hoisted over Composer's pin. Match the app's own
   `effect` to `@prisma/composer`'s exact pin, or force it, then reinstall:
   npm: `"overrides": { "effect": "<pin>" }` in `package.json`; pnpm 11+:
   an `overrides:` block in `pnpm-workspace.yaml`; pnpm 10 and earlier:
   `pnpm.overrides` in `package.json`; Yarn: `resolutions` in `package.json`. A plain Composer
   app never hits this: the public packages pin every `effect`-family
   package alchemy would float.
2. **A deployed `/rpc/<method>` returns `401` to anything but a wired
   peer.** Not a broken deploy; see Contracts above.
3. **Scale-to-zero closes idle database connections.** A persistent client
   crashes into a 502 restart loop unless the pool is small and
   reconnect-friendly (`new SQL({ url, max: 1, idleTimeout: 10 })` for Bun)
   and the process logs `uncaughtException`/`unhandledRejection` instead of
   dying. Under `dev`, add `prepare: false` as well: the local Postgres
   is one session shared by every connection and it outlives your
   processes, so a restarted process collides on prepared-statement
   names (42P05) and crash-loops.
4. **Cold starts reset service-to-service connections.** A call into a
   scaled-to-zero service can get `ECONNRESET`; retry it.
5. **Bind `0.0.0.0`, not loopback.** The platform routes external HTTP to
   the VM; a loopback-only listener is unreachable.
6. **The ingress buffers streaming responses.** An open SSE tail delivers
   nothing and times out at 60s; don't build on streamed HTTP responses.
7. **Naming rules fail at load, not typecheck.** Provision ids and declared
   node names must be ASCII letters and digits only (`[A-Za-z0-9]`): they
   derive config keys and address segments, so a hyphenated name like
   `my-db` passes `tsc` and then fails the load. The root module's name is
   the app name and may also contain `-` and `_`. Every platform name is the
   node's full address, so short provision ids are fine: `db` in the app
   `shop` names its platform rows `shop.db`. Only a full address over its
   kind's limit fails the deploy: 52 characters for a database's
   Connection, 100 for a bucket, 256 for a service. The platform's minimums
   (3 for a Connection, 1 otherwise) are always met, because the shortest
   address below the root, such as `a.b`, has 3 characters. A service
   whose name equals its enclosing Module's reads as `shop.auth.auth` unless
   given an explicit `id`.
8. **`MIGRATION_PATH_NOT_FOUND`**: see Databases above; author the missing
   migration, don't skip the plan step.
9. **Date/time columns hand back `Temporal.*` values on read.** Bun and
   stock Node ship no global `Temporal`, so a service with `DateTime`
   contract columns compiles and deploys, then fails on the first timestamp
   read. Provide the global at the server entry
   (`import 'temporal-polyfill/global'`) or use string column types.
10. **The auth module's `/api/auth/*` returns `403 MISSING_OR_NULL_ORIGIN`
    to a Node script.** It is the browser surface: Better Auth origin-checks
    any request carrying a cookie, an `Origin`/`Referer`, or a `Sec-Fetch-*`
    header, and Node's built-in `fetch` sends `Sec-Fetch-Mode` on every
    request (the same `curl` passes). Send an `Origin` equal to the module's
    `baseUrl`, or, for provisioning, don't use that surface at all: call
    `admin.createUser` from a service wired to the `admin` port. A deployed
    stack's rpc ports are reachable only from inside its graph, so the app
    exposes its own operator route that makes that call.
11. **`prisma deploy` stops at `ERR_UNKNOWN_FILE_EXTENSION` naming the app's own `.ts` entry.** Node is too old to strip TypeScript types. Composer supports Node.js 22.18 or newer on the 22 line, 24.11 or newer on the 24 line, or 26 or newer, with the npm that Node release ships (npm 10 on Node 22); its packages declare `engines.node` as `^22.18.0 || ^24.11.0 || >=26.0.0`. Upgrade Node.

## What Composer doesn't do yet

Name the gap instead of inventing an API:

1. **No `prisma` command for removing one environment, or for logs.** Remove a whole
   app with `prisma project delete <id> --confirm <id>`. For one environment and for
   logs, use the `destroy` and `log` operations of `@prisma/composer/control`
   from a script. A destroy script
   cannot use the `prisma auth login` session; it needs `PRISMA_SERVICE_TOKEN`
   and `PRISMA_WORKSPACE_ID` as environment variables.
2. **No in-memory contract bindings.** A dependency can't yet be wired to a
   co-located handler without HTTP; use `bootstrapService` with a loopback
   fake.
3. **Service RPC and raw HTTP are the only service-to-service kinds.** No
   gRPC, WebSocket, or streaming contracts, and no typed contract for an
   HTTP server's routes.

For anything else missing, check `examples/`, `docs/design/10-domains/`, and
`docs/design/90-decisions/` in the prisma/composer repo, then file an issue
there rather than guessing.
