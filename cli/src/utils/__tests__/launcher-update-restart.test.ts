import { describe, expect, test } from 'bun:test'

import { isLauncherUpdateTermination } from '../launcher-update-restart'

const alive = () => true
const dead = () => false

describe('isLauncherUpdateTermination', () => {
  test('a SIGTERM while the live launcher is our parent is an update restart', () => {
    expect(
      isLauncherUpdateTermination({
        launcherPid: 4242,
        parentPid: 4242,
        isProcessRunning: alive,
      }),
    ).toBe(true)
  })

  test('without a launcher (direct binary, dev) it is an ordinary kill', () => {
    for (const launcherPid of [NaN, 0, -1, 1.5]) {
      expect(
        isLauncherUpdateTermination({
          launcherPid,
          parentPid: 4242,
          isProcessRunning: alive,
        }),
      ).toBe(false)
    }
  })

  test('an orphan whose launcher already died is not being restarted', () => {
    // Reparented: the launcher is gone, so nothing will relaunch us.
    expect(
      isLauncherUpdateTermination({
        launcherPid: 4242,
        parentPid: 1,
        isProcessRunning: alive,
      }),
    ).toBe(false)
    expect(
      isLauncherUpdateTermination({
        launcherPid: 4242,
        parentPid: 4242,
        isProcessRunning: dead,
      }),
    ).toBe(false)
  })
})
