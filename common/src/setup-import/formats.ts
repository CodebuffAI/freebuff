import { z } from 'zod/v4'
import { cloudSkillSchema } from '../desktop-cloud/project-settings'
import { parseSkillFileContent } from '../util/parse-skill'
import { hookAddInput } from '../desktop-cloud/hooks-host'
import type { SetupImportMcp, SetupImportSource } from './types'

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected object')
  return value as Record<string, unknown>
}
export { record }
const stringMap = z.record(z.string(), z.string())
const variable = /^[A-Za-z_][A-Za-z0-9_]*$/

// Only equivalent transports and filters may be imported. In particular dropping a source tool
// allowlist would expose additional tools, and resolving env references here would leak values.
export function mcpConfig(
  raw: unknown,
  source: SetupImportSource,
): SetupImportMcp {
  const config = record(raw)
  const codex = source === 'codex'
  const allowed = [
    'type',
    'command',
    'args',
    'env',
    'url',
    'headers',
    ...(codex
      ? ['http_headers', 'env_http_headers', 'bearer_token_env_var', 'env_vars']
      : []),
  ]
  if (Object.keys(config).some((k) => !allowed.includes(k)))
    throw new Error('Additional settings')
  if (config.command !== undefined) {
    if (
      config.url ||
      config.headers ||
      config.http_headers ||
      config.env_http_headers ||
      config.bearer_token_env_var ||
      (config.type && config.type !== 'stdio')
    )
      throw new Error('Mixed config')
    const cmd = z.string().trim().min(1).parse(config.command)
    if (/\$\{?[A-Za-z_]/.test(cmd)) throw new Error('Variable in executable')
    const env = stringMap.parse(config.env ?? {})
    for (const ref of z
      .array(z.string().regex(variable))
      .parse(config.env_vars ?? [])) {
      if (Object.hasOwn(env, ref))
        throw new Error('Conflicting environment bindings')
      env[ref] = '${' + ref + '}'
    }
    return {
      type: 'stdio',
      command: cmd,
      args: z.array(z.string()).parse(config.args ?? []),
      env,
    }
  }
  if (
    config.args ||
    config.env_vars ||
    config.env ||
    (config.type && !['http', 'streamable-http'].includes(String(config.type)))
  )
    throw new Error('Unsupported transport')
  const endpoint = z.string().min(1).parse(config.url)
  if (/\$\{?[A-Za-z_]/.test(endpoint)) throw new Error('Variable in endpoint')
  const url = new URL(endpoint)
  if (
    url.username ||
    url.password ||
    (url.protocol !== 'https:' &&
      !(
        url.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      ))
  )
    throw new Error('Unusable URL')
  const headers = stringMap.parse(config.headers ?? config.http_headers ?? {})
  if (config.headers && config.http_headers)
    throw new Error('Conflicting headers')
  for (const [name, ref] of Object.entries(
    stringMap.parse(config.env_http_headers ?? {}),
  )) {
    if (
      !variable.test(ref) ||
      Object.keys(headers).some((k) => k.toLowerCase() === name.toLowerCase())
    )
      throw new Error('Invalid reference')
    headers[name] = '${' + ref + '}'
  }
  if (config.bearer_token_env_var !== undefined) {
    const ref = z.string().regex(variable).parse(config.bearer_token_env_var)
    if (Object.keys(headers).some((k) => k.toLowerCase() === 'authorization'))
      throw new Error('Conflicting authorization')
    headers.Authorization = 'Bearer ${' + ref + '}'
  }
  return { type: 'http', url: url.origin + url.pathname + url.search, headers }
}

export function markdown(text: string) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(text)
  if (!match) return { meta: {} as Record<string, unknown>, body: text }
  return { meta: record(Bun.YAML.parse(match[1]) ?? {}), body: match[2] }
}

export function skillValue(
  name: string,
  text: string,
  files?: Array<{ path: string; contents: string }>,
) {
  // autorun is Desktop's special Mission skill and must retain its existing device scope.
  if (name === 'autorun') throw new Error('Reserved skill')
  if (files) {
    const skill = parseSkillFileContent(text, {
      directoryName: name,
      filePath: 'SKILL.md',
    })
    if (!skill) throw new Error('Unusable skill package')
    return cloudSkillSchema.parse({
      name,
      description: skill.description,
      instructions: text,
      files,
    })
  }
  const { meta, body } = markdown(text)
  if (
    Object.keys(meta).some(
      (k) => !['description', 'argument-hint', 'name'].includes(k),
    ) ||
    (meta.name && meta.name !== name) ||
    /!`|^!\s/m.test(body) ||
    /\$[0-9]+/.test(body)
  )
    throw new Error('Command requires unavailable features')
  const description = meta.description ?? 'Imported command ' + name
  const instructions = body
    .replace(
      /\$ARGUMENTS\b/g,
      'the arguments the user supplies when invoking this skill',
    )
    .trim()
  if (!instructions) throw new Error('Empty command')
  return cloudSkillSchema.parse({
    name,
    description,
    instructions: `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n${instructions}`,
  })
}

export function hookValue(
  event: string,
  matcher: unknown,
  raw: unknown,
  cursor: boolean,
) {
  const hook = record(raw)
  if (
    Object.keys(hook).some(
      (key) =>
        ![
          'type',
          'command',
          'timeout',
          ...(cursor ? ['matcher'] : []),
        ].includes(key),
    )
  )
    throw new Error('Unsupported hook option')
  if (hook.type !== 'command' && !(cursor && hook.type === undefined))
    throw new Error('Unsupported hook type')
  const input = {
    event,
    matcher: matcher ?? '',
    command: hook.command,
    ...(hook.timeout === undefined ? {} : { timeout: hook.timeout }),
  }
  const parsed = hookAddInput.parse(input)
  if (parsed.command !== input.command || parsed.matcher !== input.matcher)
    throw new Error('Command or matcher requires editing')
  return parsed
}
