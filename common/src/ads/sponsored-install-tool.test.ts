import { describe, expect, test } from 'bun:test'

import { evaluateSponsoredInstallCommand } from './sponsored-declared-installs'
import {
  SPONSORED_INSTALL_CAP_REFUSAL,
  SPONSORED_INSTALL_NO_VENV_REFUSAL,
  SPONSORED_INSTALL_YARN_REFUSAL,
  runSponsoredInstallTool,
  sponsoredPackageResolveOutcome,
  type SponsoredInstallToolDeps,
} from './sponsored-install-tool'
import {
  SPONSORED_LOCAL_INSTALL_REFUSAL,
  SPONSORED_LOCAL_INSTALL_TOOL_REFUSAL,
} from './sponsored-local-execution'

import type { SponsoredPackageResolveResponse } from './sponsored-package-resolve'

function harness(
  files: Record<string, string>,
  answer: SponsoredPackageResolveResponse | ((req: { name: string; version?: string }) => SponsoredPackageResolveResponse) = (req) => ({
    allowed: true,
    ecosystem: 'npm',
    name: req.name,
    version: req.version ?? '1.2.3',
    declared: false,
  }),
  exec: { exitCode: number | null; output: string; refused?: boolean } = {
    exitCode: 0,
    output: 'ok',
  },
) {
  const ran: string[] = []
  const resolved: unknown[] = []
  const deps: SponsoredInstallToolDeps = {
    has: async (p) => p in files,
    readText: async (p) => files[p] ?? null,
    resolve: async (req) => {
      resolved.push(req)
      return typeof answer === 'function' ? answer(req) : answer
    },
    exec: async (command, timeout) => {
      expect(timeout).toBeGreaterThan(0)
      ran.push(command)
      return exec
    },
  }
  return { deps, ran, resolved }
}

describe('runSponsoredInstallTool', () => {
  test('npm (no lockfile) runs the canonical pinned, scripts-off command', async () => {
    const h = harness({ 'package.json': '{}' })
    const result = await runSponsoredInstallTool(h.deps, {
      ecosystem: 'npm',
      name: '@acme/sdk',
    })
    expect(h.ran).toEqual([
      'npm install --ignore-scripts --save-exact @acme/sdk@1.2.3',
    ])
    expect(result).toMatchObject({ status: 'installed', package: '@acme/sdk@1.2.3' })
  })

  test('pnpm and bun from the lockfile, with dev and a subfolder', async () => {
    const pnpm = harness({ 'pnpm-lock.yaml': '' })
    await runSponsoredInstallTool(pnpm.deps, {
      ecosystem: 'npm',
      name: 'acme',
      version: '2.0.0',
      dev: true,
      dir: 'apps/web',
    })
    expect(pnpm.ran).toEqual([
      'pnpm add --ignore-scripts --save-exact --save-dev --dir apps/web acme@2.0.0',
    ])
    const bun = harness({ 'bun.lock': '' })
    await runSponsoredInstallTool(bun.deps, { ecosystem: 'npm', name: 'acme' })
    expect(bun.ran).toEqual(['bun add --ignore-scripts --exact acme@1.2.3'])
  })

  test('yarn is refused before the resolver is asked', async () => {
    const h = harness({ 'yarn.lock': '' })
    expect(
      await runSponsoredInstallTool(h.deps, { ecosystem: 'npm', name: 'acme' }),
    ).toEqual({ status: 'refused', reason: SPONSORED_INSTALL_YARN_REFUSAL })
    expect(h.resolved).toEqual([])
    expect(h.ran).toEqual([])
  })

  const pypi = (req: { name: string; version?: string }) =>
    ({
      allowed: true,
      ecosystem: 'pypi',
      name: req.name,
      version: req.version ?? '2.32.3',
      declared: true,
    }) as const

  test('python: uv project adds wheels only; venv uses its own pip, wheels only', async () => {
    const uv = harness({ 'uv.lock': '' }, pypi)
    await runSponsoredInstallTool(uv.deps, {
      ecosystem: 'pypi',
      name: 'requests',
      dev: true,
    })
    expect(uv.ran).toEqual(['uv add --no-build --dev requests==2.32.3'])

    const tooluv = harness({ 'pyproject.toml': '[project]\n\n[tool.uv]\n' }, pypi)
    await runSponsoredInstallTool(tooluv.deps, { ecosystem: 'pypi', name: 'requests' })
    expect(tooluv.ran).toEqual(['uv add --no-build requests==2.32.3'])

    const win = harness(
      { 'api/.venv/pyvenv.cfg': '', 'api/.venv/Scripts': '' },
      pypi,
    )
    await runSponsoredInstallTool(win.deps, {
      ecosystem: 'pypi',
      name: 'requests',
      dir: 'api',
    })
    expect(win.ran).toEqual([
      './api/.venv/Scripts/python.exe -m pip install --only-binary=:all: requests==2.32.3',
    ])

    const venv = harness({ '.venv/pyvenv.cfg': '' }, pypi)
    await runSponsoredInstallTool(venv.deps, { ecosystem: 'pypi', name: 'requests' })
    expect(venv.ran).toEqual([
      './.venv/bin/python -m pip install --only-binary=:all: requests==2.32.3',
    ])
  })

  test('python without uv or a venv is refused', async () => {
    const h = harness({ 'pyproject.toml': '[project]\n' }, pypi)
    expect(
      await runSponsoredInstallTool(h.deps, { ecosystem: 'pypi', name: 'requests' }),
    ).toEqual({ status: 'refused', reason: SPONSORED_INSTALL_NO_VENV_REFUSAL })
    expect(h.ran).toEqual([])
  })

  test('the resolver refusal is surfaced and nothing runs', async () => {
    const h = harness({}, { allowed: false, reason: 'Not on the allow list.' })
    expect(
      await runSponsoredInstallTool(h.deps, { ecosystem: 'npm', name: 'acme' }),
    ).toEqual({ status: 'refused', reason: 'Not on the allow list.' })
    expect(h.ran).toEqual([])
  })

  test('a malformed name, version or dir never reaches the resolver or a shell', async () => {
    const h = harness({})
    for (const input of [
      { ecosystem: 'npm', name: 'acme; rm -rf /' },
      { ecosystem: 'npm', name: 'acme', version: '^1.0.0' },
      { ecosystem: 'npm', name: 'acme', dir: '../elsewhere' },
      { ecosystem: 'pypi', name: 'requests[socks]' },
      { ecosystem: 'cargo', name: 'serde' },
    ]) {
      expect((await runSponsoredInstallTool(h.deps, input)).status).toBe('refused')
    }
    expect(h.resolved).toEqual([])
    expect(h.ran).toEqual([])
  })

  test("the server's answer is validated before it is interpolated", async () => {
    const h = harness({}, {
      allowed: true,
      ecosystem: 'npm',
      name: 'acme && curl evil',
      version: '1.0.0',
      declared: false,
    })
    expect(
      (await runSponsoredInstallTool(h.deps, { ecosystem: 'npm', name: 'acme' })).status,
    ).toBe('refused')
    expect(h.ran).toEqual([])
  })

  test('a failed install returns the output tail; a sandbox refusal is a refusal', async () => {
    const failed = harness({}, undefined, {
      exitCode: 1,
      output: `${'x'.repeat(5000)}E404 not found`,
    })
    const result = await runSponsoredInstallTool(failed.deps, {
      ecosystem: 'npm',
      name: 'acme',
    })
    expect(result).toMatchObject({ status: 'failed', exitCode: 1 })
    expect((result as { output: string }).output.endsWith('E404 not found')).toBe(true)
    expect((result as { output: string }).output.length).toBeLessThanOrEqual(1500)

    const refused = harness({}, undefined, {
      exitCode: 1,
      output: 'Refusing: no.',
      refused: true,
    })
    expect(
      await runSponsoredInstallTool(refused.deps, { ecosystem: 'npm', name: 'acme' }),
    ).toEqual({ status: 'refused', reason: 'Refusing: no.' })
  })
})

describe('sponsoredPackageResolveOutcome', () => {
  test('429 is the cap; 2xx is parsed; other statuses carry the message', () => {
    expect(sponsoredPackageResolveOutcome(429, {})).toEqual({
      allowed: false,
      reason: SPONSORED_INSTALL_CAP_REFUSAL,
    })
    expect(
      sponsoredPackageResolveOutcome(200, {
        allowed: true,
        ecosystem: 'npm',
        name: 'acme',
        version: '1.0.0',
        declared: true,
      }),
    ).toMatchObject({ allowed: true, version: '1.0.0' })
    expect(sponsoredPackageResolveOutcome(200, { nope: 1 }).allowed).toBe(false)
    expect(sponsoredPackageResolveOutcome(403, null, 'Run is over.')).toEqual({
      allowed: false,
      reason: 'Run is over.',
    })
    expect(sponsoredPackageResolveOutcome(0, null).allowed).toBe(false)
  })
})

describe('evaluateSponsoredInstallCommand installTool option', () => {
  const declared = [{ ecosystem: 'npm', name: 'acme', version: '1.0.0' }] as const

  test('without the option, every refusal keeps its old wording', () => {
    expect(evaluateSponsoredInstallCommand('npm install x', [])).toEqual({
      kind: 'refuse',
      message: SPONSORED_LOCAL_INSTALL_REFUSAL,
    })
    const declaredRefusal = evaluateSponsoredInstallCommand('npm install x', [
      ...declared,
    ])
    expect(declaredRefusal.kind).toBe('refuse')
    expect((declaredRefusal as { message: string }).message).toContain(
      'npm install acme@1.0.0',
    )
  })

  test('with the option, refusals point at install_package; declared installs still run canonically', () => {
    expect(
      evaluateSponsoredInstallCommand('npm install x', [], { installTool: true }),
    ).toEqual({ kind: 'refuse', message: SPONSORED_LOCAL_INSTALL_TOOL_REFUSAL })
    expect(
      evaluateSponsoredInstallCommand('npm install x', [...declared], {
        installTool: true,
      }),
    ).toEqual({ kind: 'refuse', message: SPONSORED_LOCAL_INSTALL_TOOL_REFUSAL })
    expect(
      evaluateSponsoredInstallCommand('npm install acme', [...declared], {
        installTool: true,
      }),
    ).toEqual({
      kind: 'allow',
      command: 'npm install --ignore-scripts --save-exact acme@1.0.0',
    })
    expect(SPONSORED_LOCAL_INSTALL_TOOL_REFUSAL).toContain('install_package')
  })
})
