/**
 * One side of the native BYOK credential qualification. This deliberately uses
 * the production store instead of a test secret-store adapter so a source Bun
 * process and a Bun-compiled executable exercise the same OS credential API.
 *
 * Arguments contain only a temporary metadata directory, a non-secret run id,
 * and connection ids/revisions. Synthetic credential material is generated in
 * this process and is never printed, passed in an environment variable, or
 * written to a file.
 */
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  BYOK_SECRET_SERVICE,
  createBunByokConnectionStore,
  type ByokConnection,
} from '../src/byok'

type Action =
  | 'create'
  | 'read-v1'
  | 'replace'
  | 'confirm-v1-erased'
  | 'read-v2'
  | 'reject-stale-v1'
  | 'delete'
  | 'confirm-erased'
  | 'cleanup'

type Result = {
  action: Action
  id?: string
  revision?: number
  credentialRef?: string
}

const [action, directory, runId, suppliedId] = process.argv.slice(2) as [
  Action | undefined,
  string | undefined,
  string | undefined,
  string | undefined,
]

function syntheticCredential(version: 1 | 2): string {
  // This is intentionally synthetic. The hash makes each run unique while
  // keeping material deterministic across independent runtimes.
  const digest = createHash('sha256')
    .update(`freebuff-byok-native-qualification:${runId}:${version}`)
    .digest('hex')
  return `qualification-${version}-${digest}`
}

function connectionName(): string {
  return `Native credential qualification ${runId}`
}

function result(connection: ByokConnection, action: Action): Result {
  return {
    action,
    id: connection.id,
    revision: connection.revision,
    credentialRef: connection.credentialRef,
  }
}

async function getConnection(
  store: ReturnType<typeof createBunByokConnectionStore>,
): Promise<ByokConnection> {
  const matches = (await store.list()).filter(
    (connection) => connection.name === connectionName(),
  )
  if (matches.length !== 1)
    throw new Error('qualification connection is missing or ambiguous')
  const [connection] = matches
  if (!connection) throw new Error('qualification connection is missing')
  if (suppliedId && connection.id !== suppliedId)
    throw new Error('qualification connection identity changed unexpectedly')
  return connection
}

async function assertMetadataExcludesCredentials(): Promise<void> {
  const metadata = await fs.readFile(path.join(directory!, 'connections.json'), 'utf8')
  for (const material of [syntheticCredential(1), syntheticCredential(2)]) {
    if (metadata.includes(material))
      throw new Error('credential material was written to metadata')
  }
  if (metadata.includes('"apiKey"'))
    throw new Error('credential-shaped metadata field was written')
}

async function run(): Promise<Result> {
  if (!action || !directory || !runId)
    throw new Error('missing qualification arguments')
  const store = createBunByokConnectionStore({ directory })

  switch (action) {
    case 'create': {
      if ((await store.list()).some((item) => item.name === connectionName()))
        throw new Error('qualification connection already exists')
      const connection = await store.create({
        name: connectionName(),
        provider: 'openai-compatible',
        baseUrl: 'https://qualification.invalid/v1',
        model: 'qualification-model',
        apiKey: syntheticCredential(1),
      })
      await assertMetadataExcludesCredentials()
      return result(connection, action)
    }
    case 'read-v1':
    case 'read-v2': {
      const connection = await getConnection(store)
      const expected = syntheticCredential(action === 'read-v1' ? 1 : 2)
      const resolved = await store.resolve(connection)
      if (resolved.apiKey !== expected)
        throw new Error('credential contents did not survive cross-process read')
      await assertMetadataExcludesCredentials()
      return result(connection, action)
    }
    case 'replace': {
      const existing = await getConnection(store)
      if (existing.revision !== 1)
        throw new Error('qualification replacement did not start at revision one')
      const connection = await store.update({
        id: existing.id,
        revision: existing.revision,
        patch: { apiKey: syntheticCredential(2) },
      })
      if (connection.revision !== 2)
        throw new Error('credential replacement did not advance the revision')
      await assertMetadataExcludesCredentials()
      return result(connection, action)
    }
    case 'reject-stale-v1': {
      const current = await getConnection(store)
      if (current.revision !== 2)
        throw new Error('stale revision check requires revision two')
      let rejected = false
      try {
        await store.resolve({ id: current.id, revision: 1 })
      } catch {
        rejected = true
      }
      if (!rejected) throw new Error('stale credential revision remained readable')
      return result(current, action)
    }
    case 'confirm-v1-erased': {
      const connection = await getConnection(store)
      if (connection.revision !== 2)
        throw new Error('old-secret erasure check requires revision two')
      const retained = await Bun.secrets.get({
        service: BYOK_SECRET_SERVICE,
        name: `connection:${connection.id}:1`,
      })
      if (retained !== null)
        throw new Error('replaced credential remains in native storage')
      return result(connection, action)
    }
    case 'delete': {
      const connection = await getConnection(store)
      if (connection.revision !== 2)
        throw new Error('qualification deletion requires revision two')
      await store.remove(connection)
      return result(connection, action)
    }
    case 'confirm-erased': {
      if (!suppliedId) throw new Error('missing connection id for erasure check')
      if ((await store.list()).some((item) => item.name === connectionName()))
        throw new Error('deleted connection remains in metadata')
      for (const revision of [1, 2]) {
        const retained = await Bun.secrets.get({
          service: BYOK_SECRET_SERVICE,
          name: `connection:${suppliedId}:${revision}`,
        })
        if (retained !== null)
          throw new Error('deleted credential remains in native storage')
      }
      return { action, id: suppliedId }
    }
    case 'cleanup': {
      const connections = (await store.list()).filter(
        (item) => item.name === connectionName(),
      )
      for (const connection of connections)
        await store.remove({ id: connection.id, revision: connection.revision })
      return { action }
    }
  }
}

try {
  // The result never includes a credential or synthetic credential fingerprint.
  process.stdout.write(JSON.stringify(await run()) + '\n')
} catch (error) {
  // Do not risk emitting an upstream/native error that could contain a value.
  const code = (error as { code?: unknown })?.code
  const detail =
    typeof code === 'number'
      ? `native-code-${code}`
      : error instanceof Error
        ? error.name
        : 'unknown-error'
  process.stderr.write(
    `BYOK native credential qualification worker failed (${detail})\n`,
  )
  process.exitCode = 1
}
