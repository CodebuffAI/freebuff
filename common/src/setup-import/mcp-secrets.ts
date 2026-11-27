import { createHash, randomUUID } from 'node:crypto'
import type { SetupImportMcp } from './types'

const service = 'Freebuff setup import'
const reference = /^freebuff-keychain:([0-9a-f-]{36})$/
const variables = () =>
  /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g
const fields = (config: SetupImportMcp) =>
  config.type === 'stdio' ? config.env : config.headers
const replaceFields = (
  config: SetupImportMcp,
  values: Record<string, string>,
): SetupImportMcp =>
  config.type === 'stdio'
    ? { ...config, env: values }
    : { ...config, headers: values }

function normalized(config: SetupImportMcp) {
  const values = Object.entries(fields(config)).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )
  return config.type === 'stdio'
    ? ['stdio', config.command, config.args, values]
    : ['http', config.url, values]
}
export const sameImportedMcp = (left: SetupImportMcp, right: SetupImportMcp) =>
  JSON.stringify(normalized(left)) === JSON.stringify(normalized(right))
const binding = (name: string, config: SetupImportMcp, field: string) =>
  createHash('sha256')
    .update(JSON.stringify([name, normalized(config), field]))
    .digest('hex')
const pathPrefix = '/.freebuff/imported-mcp/'
const urlMarker = (url: string) => {
  const entry = new URL(url)
  return entry.pathname.startsWith(pathPrefix) && !entry.search
    ? entry.pathname.slice(pathPrefix.length)
    : ''
}
export const hasImportedMcpSecrets = (config: SetupImportMcp) =>
  Object.values(fields(config)).some((value) => reference.test(value)) ||
  (config.type === 'stdio'
    ? config.args.some((value) => reference.test(value))
    : reference.test(urlMarker(config.url)))

export const listMcpVariables = (config: SetupImportMcp) => [
  ...new Set(
    [
      ...Object.values(fields(config)),
      ...(config.type === 'stdio' ? config.args : []),
    ].flatMap((value) =>
      [...value.matchAll(variables())].map((match) => match[1] ?? match[2]),
    ),
  ),
]

export function interpolateImportedMcp(
  raw: SetupImportMcp,
  bindings: Map<string, string>,
) {
  const replace = (value: string) =>
    value.replace(
      variables(),
      (_, a: string, b: string) => bindings.get(a ?? b)!,
    )
  const result = replaceFields(
    raw,
    Object.fromEntries(
      Object.entries(fields(raw)).map(([key, value]) => [key, replace(value)]),
    ),
  )
  return result.type === 'stdio'
    ? { ...result, args: result.args.map(replace) }
    : result
}

type Vault = {
  get(options: { service: string; name: string }): Promise<string | null>
  set(options: { service: string; name: string; value: string }): Promise<void>
  delete(options: { service: string; name: string }): Promise<boolean>
}

export async function resolveImportedMcp(
  name: string,
  config: SetupImportMcp,
  vault: Vault = Bun.secrets,
): Promise<SetupImportMcp> {
  async function resolve(field: string, value: string) {
    const match = reference.exec(value)
    if (!match) return value
    const raw = await vault.get({ service, name: match[1] })
    if (!raw)
      throw new Error(
        'This connector credential is unavailable on this computer.',
      )
    const entry = JSON.parse(raw)
    if (
      entry.binding !== binding(name, config, field) ||
      typeof entry.value !== 'string'
    )
      throw new Error('This connector changed. Review its credentials again.')
    return entry.value as string
  }
  const values = Object.fromEntries(
    await Promise.all(
      Object.entries(fields(config)).map(async ([field, value]) => [
        field,
        await resolve(field, value),
      ]),
    ),
  )
  if (config.type === 'stdio') {
    const args = await Promise.all(
      config.args.map((value, index) => resolve('argv/' + index, value)),
    )
    return { ...config, args, env: values }
  }
  const marker = urlMarker(config.url)
  const url = reference.test(marker)
    ? await resolve('http/url', marker)
    : config.url
  return { ...config, url, headers: values }
}

export async function sealImportedMcp(
  name: string,
  raw: SetupImportMcp,
  promptVariable: (name: string) => Promise<string | null>,
  vault: Vault = Bun.secrets,
) {
  // Variable references in a URL or executable cannot safely share the credential-field model.
  if (
    (raw.type === 'stdio' ? [raw.command] : [raw.url]).some((value) =>
      variables().test(value),
    )
  )
    throw new Error('Variable outside a credential field.')
  const bindings = new Map<string, string>()
  for (const variable of listMcpVariables(raw)) {
    const answer = await promptVariable(variable)
    if (answer === null) return null
    bindings.set(variable, answer)
  }
  const records: { field: string; value: string; key: string }[] = []
  function seal(field: string, value: string) {
    const key = randomUUID()
    records.push({ field, value, key })
    return 'freebuff-keychain:' + key
  }
  const materialized = interpolateImportedMcp(raw, bindings)
  const values = fields(materialized)
  const safeValues = Object.fromEntries(
    Object.entries(values).map(([field, value]) => [field, seal(field, value)]),
  )
  let config: SetupImportMcp
  if (materialized.type === 'stdio') {
    config = {
      ...materialized,
      env: safeValues,
      args: materialized.args.map((value, i) => seal('argv/' + i, value)),
    }
  } else {
    const url = new URL(materialized.url)
    const opaqueUrl =
      url.pathname === '/' && !url.search
        ? url.origin + '/'
        : url.origin + pathPrefix + seal('http/url', materialized.url)
    config = { ...materialized, headers: safeValues, url: opaqueUrl }
  }
  const saved: string[] = []
  async function discard() {
    await Promise.all(saved.map((key) => vault.delete({ service, name: key })))
  }
  try {
    for (const { field, value, key } of records) {
      saved.push(key)
      await vault.set({
        service,
        name: key,
        value: JSON.stringify({ binding: binding(name, config, field), value }),
      })
    }
  } catch {
    await discard().catch(() => {})
    throw new Error('Could not store credentials on this computer.')
  }
  return { config, discard }
}
