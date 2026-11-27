import { afterEach, expect, test } from 'bun:test'
import {
  mkdtemp,
  realpath,
  mkdir,
  writeFile,
  readFile,
  symlink,
  rm,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanAgentSetup, applyAgentSetup, type SetupImportSinks } from './index'
import { mcpConfig } from './formats'
import { importHookOff } from './local-sinks'
import { resolveImportedMcp, sealImportedMcp } from './mcp-secrets'

const dirs: string[] = []
async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'freebuff-import-')))
  dirs.push(home)
  return {
    home,
    claudeDir: join(home, '.claude'),
    codexDir: join(home, '.codex'),
    cursorDir: join(home, '.cursor'),
  }
}
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true })
})
const decline: SetupImportSinks = {
  skill: async () => 'declined',
  hook: async () => 'declined',
  mcp: async () => 'declined',
  instructions: async () => 'declined',
}

test('selection is bound to reviewed bytes, credentials remain out of the hosted inventory, and an error on one item permits the next', async () => {
  const options = await fixture()
  await mkdir(options.codexDir)
  await writeFile(join(options.codexDir, 'AGENTS.md'), 'Keep it short')
  await writeFile(
    join(options.codexDir, 'config.toml'),
    '[mcp_servers.example]\nurl="https://example.test/api"\n[mcp_servers.example.http_headers]\nAuthorization="fictional-private-value"\n',
  )
  await mkdir(join(options.cursorDir, 'commands'), { recursive: true })
  await writeFile(join(options.cursorDir, 'commands', 'tidy.md'), 'Clean up')
  const inventory = await scanAgentSetup(options)
  expect(JSON.stringify(inventory)).not.toContain('fictional-private-value')
  expect(JSON.stringify(inventory)).not.toContain(options.home)
  const instruction = inventory.items.find((x) => x.kind === 'instructions')!
  const mcp = inventory.items.find((x) => x.kind === 'mcp')!
  const command = inventory.items.find((x) => x.kind === 'command')!
  await writeFile(join(options.codexDir, 'AGENTS.md'), 'Changed text')
  const { results } = await applyAgentSetup(
    options,
    [instruction.id, mcp.id, command.id, command.id],
    {
      ...decline,
      mcp: async () => {
        throw new Error('fictional-private-value')
      },
      skill: async (skill) => {
        expect(skill.name).toBe('tidy')
        return 'imported'
      },
    },
  )
  expect(results.map((x) => x.status)).toEqual(['stale', 'failed', 'imported'])
  expect(JSON.stringify(results)).not.toContain('fictional-private-value')
})

test('linked resources never become account data; redirection and conditional settings cannot silently broaden', async () => {
  const options = await fixture()
  await mkdir(join(options.claudeDir, 'skills', 'example'), { recursive: true })
  await writeFile(
    join(options.claudeDir, 'skills', 'example', 'SKILL.md'),
    '---\nname: example\ndescription: Example\n---\nHello',
  )
  await writeFile(join(options.home, 'outside'), 'private')
  await symlink(
    join(options.home, 'outside'),
    join(options.claudeDir, 'skills', 'example', 'data'),
  )
  await writeFile(
    join(options.home, '.claude.json'),
    JSON.stringify({
      mcpServers: { restricted: { command: 'echo', enabled_tools: ['read'] } },
    }),
  )
  await mkdir(join(options.cursorDir, 'rules'), { recursive: true })
  await writeFile(
    join(options.cursorDir, 'rules', 'python.mdc'),
    '---\nglobs: "*.py"\nalwaysApply: false\n---\nReadable code',
  )
  expect((await scanAgentSetup(options)).items.map((x) => x.status)).toEqual([
    'unsupported',
    'unsupported',
    'unsupported',
  ])
})

test('offline imported hooks have a fresh approval identity; duplicate and concurrent attempts add at most one record', async () => {
  const { home } = await fixture()
  const hook = {
    event: 'PreToolUse' as const,
    matcher: 'Bash',
    command: 'echo sample',
  }
  const [a, b] = await Promise.all([
    importHookOff(home, hook),
    importHookOff(home, hook),
  ])
  expect([a, b]).toContain('imported')
  expect(await importHookOff(home, hook)).toBe('unchanged')
  const file = join(home, '.agents', 'hooks.json')
  const saved = JSON.parse(await readFile(file, 'utf8'))
  expect(saved.hooks.PreToolUse).toHaveLength(1)
  expect(saved.hooks.PreToolUse[0].hooks[0].freebuffImportId).toMatch(
    /^[0-9a-f-]{36}$/,
  )
  await writeFile(file, 'broken')
  await expect(importHookOff(home, hook)).rejects.toThrow()
  expect(await readFile(file, 'utf8')).toBe('broken')
})

test('credential references are locally entered, destination-bound, cancellable and never serialized as plaintext', async () => {
  const saved = new Map<string, string>()
  const vault = {
    get: async ({ name }: { name: string }) => saved.get(name) ?? null,
    set: async ({ name, value }: { name: string; value: string }) => {
      saved.set(name, value)
    },
    delete: async ({ name }: { name: string }) => saved.delete(name),
  }
  const source = {
    type: 'http' as const,
    url: 'https://example.test/api',
    headers: { Authorization: 'Bearer ${DEMO}' },
  }
  expect(
    await sealImportedMcp('demo', source, async () => null, vault),
  ).toBeNull()
  expect(saved.size).toBe(0)
  const output = await sealImportedMcp(
    'demo',
    source,
    async (variable) => (variable === 'DEMO' ? 'fixture-value' : null),
    vault,
  )
  expect(output).not.toBeNull()
  expect(JSON.stringify(output!.config)).not.toContain('fixture-value')
  expect(JSON.stringify(output!.config)).not.toContain('/api')
  expect(await resolveImportedMcp('demo', output!.config, vault)).toEqual({
    ...source,
    headers: { Authorization: 'Bearer fixture-value' },
  })
  if (output!.config.type !== 'http') throw new Error()
  await expect(
    resolveImportedMcp(
      'demo',
      { ...output!.config, url: 'https://elsewhere.test' },
      vault,
    ),
  ).rejects.toThrow()
  await expect(
    resolveImportedMcp('different', output!.config, vault),
  ).rejects.toThrow()
  const argumentSecret = {
    type: 'stdio' as const,
    command: 'sample',
    args: ['--token', 'private-argument'],
    env: {},
  }
  const argsOutput = await sealImportedMcp(
    'local',
    argumentSecret,
    async () => null,
    vault,
  )
  expect(JSON.stringify(argsOutput!.config)).not.toContain('private-argument')
  expect(await resolveImportedMcp('local', argsOutput!.config, vault)).toEqual(
    argumentSecret,
  )
  await argsOutput!.discard()
  await output!.discard()
  expect(saved.size).toBe(0)
})

test('server URLs get Desktop normal form before binding credentials', async () => {
  const parsed = mcpConfig(
    { url: 'https://example.test#x', headers: { Authorization: 'fixture' } },
    'claude',
  )
  expect(parsed).toEqual({
    type: 'http',
    url: 'https://example.test/',
    headers: { Authorization: 'fixture' },
  })
})

test('Codex env_vars and positional references request user input without reading the environment', async () => {
  const config = mcpConfig(
    {
      command: 'demo',
      args: ['--token', '${TEST_ACCESS}'],
      env_vars: ['TEST_ACCESS'],
    },
    'codex',
  )
  const values = new Map<string, string>()
  const vault = {
    get: async ({ name }: { name: string }) => values.get(name) ?? null,
    set: async ({ name, value }: { name: string; value: string }) => {
      values.set(name, value)
    },
    delete: async ({ name }: { name: string }) => values.delete(name),
  }
  const asked: string[] = []
  const result = await sealImportedMcp(
    'demo',
    config,
    async (key) => {
      asked.push(key)
      return 'typed-fixture'
    },
    vault,
  )
  expect(asked).toEqual(['TEST_ACCESS'])
  expect(await resolveImportedMcp('demo', result!.config, vault)).toEqual({
    type: 'stdio',
    command: 'demo',
    args: ['--token', 'typed-fixture'],
    env: { TEST_ACCESS: 'typed-fixture' },
  })
})
