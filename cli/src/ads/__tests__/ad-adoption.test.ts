import { describe, expect, test } from 'bun:test'

import {
  AD_MS_CAP,
  parseAdEngagement,
} from '@codebuff/common/types/ad-client-context'

import {
  ADOPTION_MAX_WATCHES,
  createAdoptionWatcher,
  parseInstalledPackages,
  vendorsInstalledBy,
} from '../ad-adoption'

import type { EngagementStatus } from '../ad-engagement'
import type { AdEngagement } from '@codebuff/common/types/ad-client-context'

describe('parseInstalledPackages', () => {
  test('the four package managers and their install verbs', () => {
    expect(parseInstalledPackages('npm i stripe')).toEqual(['stripe'])
    expect(parseInstalledPackages('npm install --save-dev @sentry/node@8')).toEqual(
      ['@sentry/node@8'],
    )
    expect(parseInstalledPackages('bun add @supabase/supabase-js zod')).toEqual([
      '@supabase/supabase-js',
      'zod',
    ])
    expect(parseInstalledPackages('pnpm add -D prisma')).toEqual(['prisma'])
    expect(parseInstalledPackages('yarn add "resend"')).toEqual(['resend'])
    expect(
      parseInstalledPackages('pnpm --filter web add @clerk/nextjs'),
    ).toEqual(['@clerk/nextjs'])
  })

  test('chains, env prefixes and sudo', () => {
    expect(
      parseInstalledPackages(
        'cd app && NODE_ENV=dev npm i convex; sudo npm i -g vercel | tee log',
      ),
    ).toEqual(['convex', 'vercel'])
  })

  test('not installs: lockfile installs, other verbs, paths, urls and runners', () => {
    expect(parseInstalledPackages('npm install')).toEqual([])
    expect(parseInstalledPackages('bun install --frozen-lockfile')).toEqual([])
    expect(parseInstalledPackages('npm run build')).toEqual([])
    expect(parseInstalledPackages('npx stripe login')).toEqual([])
    expect(parseInstalledPackages('yarn install')).toEqual([])
    expect(parseInstalledPackages('pip install stripe')).toEqual([])
    expect(
      parseInstalledPackages(
        'npm i ./local-pkg ../x ~/y https://x.dev/a.tgz github:me/repo file:../z',
      ),
    ).toEqual([])
    expect(parseInstalledPackages('echo npm i stripe')).toEqual([])
  })

  test('vendorsInstalledBy maps only tracked vendors', () => {
    expect([...vendorsInstalledBy('bun add @supabase/ssr stripe left-pad')].sort()).toEqual(
      ['stripe', 'supabase'],
    )
    expect(vendorsInstalledBy('npm i left-pad').size).toBe(0)
  })
})

function harness(status: (impUrl: string) => EngagementStatus = () => 'flushed') {
  let now = 1_000
  const sent: AdEngagement[] = []
  const watcher = createAdoptionWatcher({
    now: () => now,
    send: (record) => sent.push(record),
    status,
  })
  return {
    watcher,
    sent,
    advance: (ms: number) => {
      now += ms
    },
  }
}

describe('adoption watcher', () => {
  test('a vendor install after a click sends one merge record of booleans and ms', () => {
    const { watcher, sent, advance } = harness()
    watcher.armClick('imp-1', 'https://www.supabase.com/pricing?utm_source=x')
    advance(90_000)
    watcher.agentCommand('npm i left-pad')
    expect(sent).toHaveLength(0)
    advance(10_000)
    watcher.agentCommand('bun add @supabase/supabase-js@2.45.0')
    watcher.agentCommand('bun add @supabase/ssr')
    expect(sent).toEqual([
      {
        v: 1,
        impUrl: 'imp-1',
        postClick: { packageInstalled: true, adoptedAtMs: 100_000 },
      },
    ])
    expect(parseAdEngagement(sent[0])).toEqual(sent[0]!)
    const raw = JSON.stringify(sent)
    for (const leak of ['supabase-js', '@supabase', 'left-pad', 'pricing'])
      expect(raw).not.toContain(leak)
    expect(watcher.size).toBe(0)
  })

  test('a landing page outside the tracked vendors arms nothing', () => {
    const { watcher, sent } = harness()
    watcher.armClick('imp-1', 'https://example.com/tool')
    watcher.armClick('imp-2', undefined)
    watcher.armClick('imp-3', 'not a url')
    expect(watcher.size).toBe(0)
    watcher.agentCommand('npm i stripe')
    expect(sent).toHaveLength(0)
  })

  test('another vendor\'s package is not adoption', () => {
    const { watcher, sent } = harness()
    watcher.armClick('imp-1', 'https://stripe.com')
    watcher.agentCommand('npm i @sentry/node')
    expect(sent).toHaveLength(0)
  })

  test('held while the main record is live, released when it goes out', () => {
    let status: EngagementStatus = 'live'
    const { watcher, sent } = harness(() => status)
    watcher.armClick('imp-1', 'https://neon.tech')
    watcher.agentCommand('pnpm add @neondatabase/serverless')
    expect(sent).toHaveLength(0)
    status = 'flushed'
    watcher.mainRecordSent('imp-1')
    expect(sent).toHaveLength(1)
    expect(sent[0]!.postClick).toEqual({ packageInstalled: true, adoptedAtMs: 0 })
    expect(watcher.size).toBe(0)
  })

  test('an impression never tracked sends at once: no main record is coming', () => {
    const { watcher, sent } = harness(() => 'unknown')
    watcher.armClick('imp-1', 'https://vercel.com')
    watcher.agentCommand('npm i -g vercel')
    expect(sent).toHaveLength(1)
  })

  test('the watch ends at AD_MS_CAP', () => {
    const { watcher, sent, advance } = harness()
    watcher.armClick('imp-1', 'https://convex.dev')
    advance(AD_MS_CAP + 1)
    watcher.agentCommand('npm i convex')
    expect(sent).toHaveLength(0)
    expect(watcher.size).toBe(0)
  })

  test('bounded: the oldest watch is dropped past the cap', () => {
    const { watcher, sent } = harness()
    for (let i = 0; i <= ADOPTION_MAX_WATCHES; i++)
      watcher.armClick(`imp-${i}`, 'https://resend.com')
    expect(watcher.size).toBe(ADOPTION_MAX_WATCHES)
    watcher.agentCommand('npm i resend')
    expect(sent.map((r) => r.impUrl)).not.toContain('imp-0')
    expect(sent).toHaveLength(ADOPTION_MAX_WATCHES)
  })

  test('a throwing sender or status never throws out of the watcher', () => {
    const watcher = createAdoptionWatcher({
      now: () => 0,
      send: () => {
        throw new Error('offline')
      },
      status: () => {
        throw new Error('broken')
      },
    })
    watcher.armClick('imp-1', 'https://stripe.com')
    expect(() => watcher.agentCommand('npm i stripe')).not.toThrow()
  })
})
