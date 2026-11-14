import { describe, expect, test } from 'bun:test'
import type { AdReport } from '@codebuff/common/ads/ad-report'
import { createAdReportRegistry } from '../ad-reports'

const AD = {
  title: 'First ad',
  url: 'https://example.com/first',
  surface: 'cli',
  impUrl: 'first',
}
const REASON = 'This ad makes a misleading claim.'

describe('report targets and state', () => {
  test('an account boundary removes history and invalidates the original report callback', async () => {
    let account: string | null = 'first-account'
    const sent: AdReport[] = []
    const registry = createAdReportRegistry(
      async (ad) => {
        sent.push(ad)
      },
      () => account,
    )
    const entry = registry.register(AD)
    registry.open(entry, async (ad) => {
      sent.push(ad)
    })
    const originalPrompt = registry.getPrompt()!
    const generation = registry.getGeneration()
    account = 'second-account'
    expect(await registry.submit(entry, REASON, originalPrompt.send)).toBe(
      'error',
    )
    expect(registry.getPrompt()).toBeNull()
    expect(registry.getGeneration()).toBeGreaterThan(generation)
    expect(await registry.command('')).toBe(
      'No ads have been shown in this session.',
    )
    registry.open(entry)
    expect(registry.getPrompt()).toBeNull()
    expect(sent).toEqual([])

    const next = registry.register(AD)
    expect(next).not.toBe(entry)
    registry.open(next)
    account = null
    registry.syncAccount()
    expect(registry.getPrompt()).toBeNull()
    expect(await registry.command(String(next.id))).toContain('Ad not found')
    expect(await registry.submit(next, REASON)).toBe('error')
    expect(sent).toEqual([])
  })

  test('reset does not undo an in-flight send or let its completion close another account’s form', async () => {
    let account = 'first-account'
    let finish!: () => void
    const sent: AdReport[] = []
    const tokens: (string | undefined)[] = []
    const registry = createAdReportRegistry(
      async (ad, expectedToken) => {
        sent.push(ad)
        tokens.push(expectedToken)
        await new Promise<void>((resolve) => {
          finish = resolve
        })
      },
      () => account,
    )
    const original = registry.register(AD)
    registry.open(original)
    const sending = registry.submit(original, REASON)
    expect(original.status).toBe('sending')
    account = 'second-account'
    registry.syncAccount()
    const replacement = registry.register(AD)
    registry.open(replacement)
    finish()
    expect(await sending).toBe('sent')
    expect(sent).toEqual([{ ...AD, reason: REASON }])
    expect(tokens).toEqual(['first-account'])
    expect(replacement.status).toBe('idle')
    expect(registry.getPrompt()?.entry).toBe(replacement)
    registry.reset()
    expect(registry.getPrompt()).toBeNull()
    expect(await registry.submit(replacement, REASON)).toBe('error')
  })

  test('keyboard opens the original numbered snapshot after rotation; only explicit submission sends', async () => {
    const sent: AdReport[] = []
    const registry = createAdReportRegistry(async (ad) => {
      sent.push(ad)
    })
    const original = { ...AD }
    const first = registry.register(original)
    original.title = 'mutated later'
    registry.register({ ...AD, title: 'Second ad', impUrl: 'second' })
    expect(await registry.command('')).toContain(`${first.id}: First ad`)
    expect(await registry.command(String(first.id))).toBeNull()
    expect(registry.getPrompt()?.entry).toBe(first)
    expect(sent).toEqual([])
    await registry.submit(first, `  ${REASON}  `)
    expect(sent).toEqual([{ ...AD, reason: REASON }])
    expect(registry.getPrompt()).toBeNull()
    expect(await registry.command('999')).toContain('Ad not found')
  })

  test('duplicates are blocked while sending and after success; failures allow retry', async () => {
    let finish!: () => void
    let calls = 0
    const registry = createAdReportRegistry(async () => {
      calls++
      if (calls === 1) throw new Error('offline')
      await new Promise<void>((resolve) => {
        finish = resolve
      })
    })
    const entry = registry.register(AD)
    expect(registry.register({ ...AD })).toBe(entry)
    registry.open(entry)
    expect(await registry.submit(entry, REASON)).toBe('error')
    expect(registry.getPrompt()?.entry).toBe(entry)
    const retry = registry.submit(entry, REASON)
    expect(entry.status).toBe('sending')
    expect(await registry.submit(entry, REASON)).toBe('sending')
    registry.cancel()
    expect(registry.getPrompt()?.entry).toBe(entry)
    finish()
    expect(await retry).toBe('sent')
    expect(await registry.submit(entry, REASON)).toBe('sent')
    expect(calls).toBe(2)
  })

  test('cancel sends nothing and validation cannot be bypassed by whitespace or oversized text', async () => {
    const sent: AdReport[] = []
    const registry = createAdReportRegistry(async (ad) => {
      sent.push(ad)
    })
    const entry = registry.register({ ...AD, reason: REASON })
    expect(entry.snapshot.reason).toBeUndefined()
    registry.open(entry)
    for (const reason of ['', ' '.repeat(20), 'short', 'a'.repeat(2001)]) {
      await expect(registry.submit(entry, reason)).rejects.toThrow()
    }
    expect(entry.status).toBe('idle')
    registry.cancel()
    expect(registry.getPrompt()).toBeNull()
    expect(sent).toEqual([])
  })

  test('an open form keeps its selected snapshot and custom proposal submission', async () => {
    const sent: AdReport[] = []
    const registry = createAdReportRegistry(async () => {
      throw new Error('wrong sender')
    })
    const first = registry.register(AD)
    const second = registry.register({ ...AD, impUrl: 'second' })
    registry.open(first, async (ad) => {
      sent.push(ad)
    })
    registry.open(second)
    const prompt = registry.getPrompt()!
    expect(prompt.entry).toBe(first)
    await registry.submit(prompt.entry, REASON, prompt.send)
    expect(sent).toEqual([{ ...AD, reason: REASON }])
  })

  test('history is bounded without evicting mounted controls', async () => {
    const registry = createAdReportRegistry(async () => {})
    expect(await registry.command('')).toContain('No ads')
    const mounted = registry.register(AD)
    mounted.mounted++
    const recent = registry.register({ ...AD, impUrl: 'old' })
    for (let index = 0; index < 110; index++)
      registry.register({ ...AD, impUrl: String(index) })
    expect(await registry.command(String(mounted.id))).toBeNull()
    expect(registry.getPrompt()?.entry).toBe(mounted)
    expect(await registry.command(String(recent.id))).toContain('Ad not found')
  })
})
