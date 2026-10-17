import { describe, test, expect, beforeEach } from 'bun:test'

import {
  requestShellApproval,
  submitShellApproval,
  cancelAllShellApprovals,
  getActiveShellApproval,
  __resetShellApprovalBridge,
} from '../shell-approval-bridge'

function req(id: string, extra: Partial<Parameters<typeof requestShellApproval>[0]> = {}) {
  return { id, command: 'echo hi', cwd: '/tmp/p', processType: 'SYNC' as const, ...extra }
}

describe('shell-approval-bridge', () => {
  beforeEach(() => __resetShellApprovalBridge())

  test('approve resolves only the matching id', async () => {
    const p = requestShellApproval(req('a'))
    expect(getActiveShellApproval()?.id).toBe('a')
    expect(submitShellApproval('wrong', 'approve')).toBe(false)
    expect(submitShellApproval('a', 'approve')).toBe(true)
    expect(await p).toBe('approve')
  })

  test('deny resolves deny', async () => {
    const p = requestShellApproval(req('a'))
    submitShellApproval('a', 'deny')
    expect(await p).toBe('deny')
  })

  test('timeout resolves deny without any submit', async () => {
    const p = requestShellApproval(req('a'), { timeoutMs: 10 })
    expect(await p).toBe('deny')
  })

  test('abort resolves deny', async () => {
    const controller = new AbortController()
    const p = requestShellApproval(req('a', { signal: controller.signal }))
    controller.abort()
    expect(await p).toBe('deny')
  })

  test('already-aborted signal denies without queueing', async () => {
    const controller = new AbortController()
    controller.abort()
    const p = requestShellApproval(req('a', { signal: controller.signal }))
    expect(await p).toBe('deny')
    expect(getActiveShellApproval()).toBeNull()
  })

  test('two concurrent requests: neither is lost; FIFO order', async () => {
    const p1 = requestShellApproval(req('a'))
    const p2 = requestShellApproval(req('b'))
    // First is active, second queued.
    expect(getActiveShellApproval()?.id).toBe('a')
    submitShellApproval('a', 'approve')
    expect(await p1).toBe('approve')
    // Second becomes active after the first settles.
    expect(getActiveShellApproval()?.id).toBe('b')
    submitShellApproval('b', 'deny')
    expect(await p2).toBe('deny')
  })

  test('a submit for a queued id is ignored (cannot approve a non-active request)', async () => {
    const p1 = requestShellApproval(req('a'))
    const p2 = requestShellApproval(req('b'))
    expect(submitShellApproval('b', 'approve')).toBe(false)
    submitShellApproval('a', 'approve')
    await p1
    // b is now active and still unresolved until explicitly decided.
    expect(submitShellApproval('b', 'approve')).toBe(true)
    expect(await p2).toBe('approve')
  })

  test('cancelAll denies every pending request (UI shutdown)', async () => {
    const p1 = requestShellApproval(req('a'))
    const p2 = requestShellApproval(req('b'))
    cancelAllShellApprovals()
    expect(await p1).toBe('deny')
    expect(await p2).toBe('deny')
    expect(getActiveShellApproval()).toBeNull()
  })

  test('stale approval after settle does not re-resolve', async () => {
    const p = requestShellApproval(req('a'))
    submitShellApproval('a', 'deny')
    expect(await p).toBe('deny')
    // A late UI action for the same id is ignored.
    expect(submitShellApproval('a', 'approve')).toBe(false)
  })
})
