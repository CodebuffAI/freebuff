import { describe, expect, test } from 'bun:test'

import {
  formatDesktopRolloutMarker,
  planDesktopReleaseRollout,
  readDesktopRolloutMarker,
  writeDesktopRolloutMarker,
} from './desktop-rollout'

const NOTES = '## Freebuff Desktop v0.1.0\n\n### Downloads\n'

describe('desktop rollout marker', () => {
  test('round-trips through release notes and stays a single hidden line', () => {
    const body = writeDesktopRolloutMarker(NOTES, {
      since: '0.1.0',
      percent: 10,
    })
    expect(body).toBe(
      `${NOTES.trimEnd()}\n\n<!-- freebuff-desktop-rollout {"since":"0.1.0","percent":10} -->\n`,
    )
    expect(readDesktopRolloutMarker(body)).toEqual({
      since: '0.1.0',
      percent: 10,
    })

    const ramped = writeDesktopRolloutMarker(body, {
      since: '0.1.0',
      percent: 20,
    })
    expect(ramped.match(/freebuff-desktop-rollout/g)).toHaveLength(1)
    expect(readDesktopRolloutMarker(ramped)).toEqual({
      since: '0.1.0',
      percent: 20,
    })
  })

  test('notes without a marker are no rollout', () => {
    expect(readDesktopRolloutMarker(NOTES)).toBeNull()
    expect(readDesktopRolloutMarker(null)).toBeNull()
  })

  test('a marker it cannot read throws rather than reading as no rollout', () => {
    for (const marker of [
      '<!-- freebuff-desktop-rollout {"since":"0.1.0"} -->',
      '<!-- freebuff-desktop-rollout {"since":"0.1.0","percent":101} -->',
      '<!-- freebuff-desktop-rollout {"since":"0.1.0","percent":12.5} -->',
      '<!-- freebuff-desktop-rollout {"since":"v0.1.0","percent":10} -->',
      '<!-- freebuff-desktop-rollout {since:0.1.0} -->',
      `${formatDesktopRolloutMarker({ since: '0.1.0', percent: 10 })}\n${formatDesktopRolloutMarker({ since: '0.1.0', percent: 20 })}`,
    ])
      expect(() => readDesktopRolloutMarker(`${NOTES}${marker}`)).toThrow()
  })
})

describe('planning a release rollout', () => {
  test('no rollout under way and none asked for: out to everyone', () => {
    expect(
      planDesktopReleaseRollout({
        version: '0.1.0',
        requested: null,
        previous: null,
      }),
    ).toBeNull()
    expect(
      planDesktopReleaseRollout({
        version: '0.1.0',
        requested: 100,
        previous: null,
      }),
    ).toBeNull()
  })

  test('a requested percentage starts a rollout at this release', () => {
    expect(
      planDesktopReleaseRollout({
        version: '0.1.0',
        requested: 10,
        previous: null,
      }),
    ).toEqual({
      since: '0.1.0',
      percent: 10,
    })
    expect(
      planDesktopReleaseRollout({
        version: '0.1.0',
        requested: 0,
        previous: null,
      }),
    ).toEqual({
      since: '0.1.0',
      percent: 0,
    })
  })

  test('a fix cut mid-rollout carries it on, keeping the original since', () => {
    const previous = { since: '0.1.0', percent: 10 }
    expect(
      planDesktopReleaseRollout({
        version: '0.1.1',
        requested: null,
        previous,
      }),
    ).toEqual(previous)
    expect(
      planDesktopReleaseRollout({ version: '0.1.1', requested: 20, previous }),
    ).toEqual({
      since: '0.1.0',
      percent: 20,
    })
  })

  test('a finished rollout is not carried on', () => {
    const previous = { since: '0.1.0', percent: 100 }
    expect(
      planDesktopReleaseRollout({
        version: '0.1.5',
        requested: null,
        previous,
      }),
    ).toBeNull()
    expect(
      planDesktopReleaseRollout({ version: '0.2.0', requested: 10, previous }),
    ).toEqual({
      since: '0.2.0',
      percent: 10,
    })
  })
})
