import { describe, expect, test } from 'bun:test'

import { ensureCliTestEnv } from '../../__tests__/test-utils'

ensureCliTestEnv()

const { createExitCliCleanly } = await import('../exit-cleanly')

describe('createExitCliCleanly', () => {
  test('runs local cleanup before bounded remote cleanup and exits once', async () => {
    const events: string[] = []
    const exitCleanly = createExitCliCleanly({
      isFreebuff: false,
      cleanupLocal: () => events.push('local-cleanup'),
      stopEngagementTracking: () => events.push('stop-engagement'),
      flushAnalytics: async () => {
        events.push('flush-analytics')
      },
      drainClientLogs: async () => {
        events.push('flush-logs')
      },
      flushAdEngagement: async () => {
        events.push('flush-ad-engagement')
      },
      endFreebuffSession: async () => {
        events.push('end-session')
      },
      settleSponsoredRun: async () => null,
      writeNotice: () => {},
      waitForRemoteCleanup: async (tasks) => {
        events.push('wait-start')
        await Promise.allSettled(tasks)
        events.push('wait-finish')
      },
      exit: (code) => {
        events.push(`exit-${code}`)
      },
    })

    await exitCleanly(7)

    expect(events).toEqual([
      'flush-ad-engagement',
      'local-cleanup',
      'wait-start',
      'flush-analytics',
      'flush-logs',
      'wait-finish',
      'exit-7',
    ])
  })

  test('also stops engagement and releases the Freebuff session', async () => {
    const events: string[] = []
    const exitCleanly = createExitCliCleanly({
      isFreebuff: true,
      cleanupLocal: () => events.push('local-cleanup'),
      stopEngagementTracking: () => events.push('stop-engagement'),
      flushAnalytics: async () => {
        events.push('flush-analytics')
      },
      drainClientLogs: async () => {
        events.push('flush-logs')
      },
      flushAdEngagement: async () => {
        events.push('flush-ad-engagement')
      },
      endFreebuffSession: async () => {
        events.push('end-session')
      },
      settleSponsoredRun: async () => null,
      writeNotice: () => {},
      waitForRemoteCleanup: async (tasks) => {
        await Promise.allSettled(tasks)
      },
      exit: () => {},
    })

    await exitCleanly()

    expect(events).toEqual([
      'flush-ad-engagement',
      'local-cleanup',
      'stop-engagement',
      'flush-analytics',
      'flush-logs',
      'end-session',
    ])
  })

  test('closes ad engagement records before the renderer unmounts the cards', async () => {
    const events: string[] = []
    let releaseTransport: (() => void) | undefined
    const exitCleanly = createExitCliCleanly({
      isFreebuff: false,
      cleanupLocal: () => events.push('local-cleanup'),
      stopEngagementTracking: () => {},
      flushAnalytics: async () => {},
      drainClientLogs: async () => {},
      // closeAll is synchronous inside the flush; the transport settles later
      flushAdEngagement: () => {
        events.push('close-all')
        return new Promise<void>((resolve) => {
          releaseTransport = () => {
            events.push('transport-settled')
            resolve()
          }
        })
      },
      endFreebuffSession: async () => {},
      settleSponsoredRun: async () => null,
      writeNotice: () => {},
      waitForRemoteCleanup: async (tasks) => {
        releaseTransport?.()
        await Promise.allSettled(tasks)
      },
      exit: () => events.push('exit'),
    })

    await exitCleanly()

    expect(events).toEqual([
      'close-all',
      'local-cleanup',
      'transport-settled',
      'exit',
    ])
  })

  test('a throwing ad flush never blocks the exit', async () => {
    const exitCodes: number[] = []
    const exitCleanly = createExitCliCleanly({
      isFreebuff: false,
      cleanupLocal: () => {},
      stopEngagementTracking: () => {},
      flushAnalytics: async () => {},
      drainClientLogs: async () => {},
      flushAdEngagement: () => {
        throw new Error('boom')
      },
      endFreebuffSession: async () => {},
      settleSponsoredRun: async () => null,
      writeNotice: () => {},
      waitForRemoteCleanup: async (tasks) => {
        await Promise.allSettled(tasks)
      },
      exit: (code) => exitCodes.push(code),
    })

    await exitCleanly(3)
    expect(exitCodes).toEqual([3])
  })

  test('coalesces competing exit requests and keeps the first exit code', async () => {
    let finishRemoteCleanup: (() => void) | undefined
    let cleanupCalls = 0
    const exitCodes: number[] = []
    const exitCleanly = createExitCliCleanly({
      isFreebuff: false,
      cleanupLocal: () => cleanupCalls++,
      stopEngagementTracking: () => {},
      flushAnalytics: async () => {},
      drainClientLogs: async () => {},
      flushAdEngagement: async () => {},
      endFreebuffSession: async () => {},
      settleSponsoredRun: async () => null,
      writeNotice: () => {},
      waitForRemoteCleanup: () =>
        new Promise<void>((resolve) => {
          finishRemoteCleanup = resolve
        }),
      exit: (code) => {
        exitCodes.push(code)
      },
    })

    const first = exitCleanly(0)
    const second = exitCleanly(1)
    expect(second).toBe(first)

    await Promise.resolve()
    expect(cleanupCalls).toBe(1)
    finishRemoteCleanup?.()
    await first

    expect(exitCodes).toEqual([0])
  })
})
