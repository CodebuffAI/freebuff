import { expect, test } from 'bun:test'
import {
  CLOUD_COMPACT_FAILED,
  CLOUD_COMPACTED,
  CLOUD_NOTHING_TO_COMPACT,
  compactOutcome,
  isCloudCompactPrompt,
  isCloudCompactRequest,
} from './compact'

test('a pass that began and installed nothing failed; one that never began found nothing', () => {
  expect(compactOutcome({ started: true, compacted: true })).toBe(CLOUD_COMPACTED)
  // A ready summary is swapped in with no pass to wait for.
  expect(compactOutcome({ started: false, compacted: true })).toBe(CLOUD_COMPACTED)
  expect(compactOutcome({ started: true, compacted: false })).toBe(CLOUD_COMPACT_FAILED)
  expect(compactOutcome({ started: false, compacted: false })).toBe(CLOUD_NOTHING_TO_COMPACT)
})

test('only the bare command is one', () => {
  expect(isCloudCompactPrompt('/compact')).toBe(true)
  expect(isCloudCompactPrompt('  /compact\n')).toBe(true)
  expect(isCloudCompactPrompt('/Compact')).toBe(false)
  expect(isCloudCompactPrompt('compact')).toBe(false)
  expect(isCloudCompactPrompt('/compact the logs')).toBe(false)
})

test('a run that has another job stays that job', () => {
  const prompt = '/compact'
  expect(isCloudCompactRequest({ prompt })).toBe(true)
  for (const other of [
    { agent: 'claude-code' },
    { localHarness: 'codex' },
    { opener: true },
    { runtimeContinuation: true },
    { mission: { prompt } },
    { missionPass: 2 },
    { sponsored: { proposalId: 'p' } },
    { agenticAdLabOfferId: 'offer' },
  ])
    expect(isCloudCompactRequest({ prompt, ...other })).toBe(false)
})
