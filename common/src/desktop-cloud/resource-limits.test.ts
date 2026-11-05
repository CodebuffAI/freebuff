import { expect, test } from 'bun:test'
import {
  CLOUD_RESOURCE_MESSAGE,
  CLOUD_RESOURCE_FILES_WHERE,
  CLOUD_RESOURCE_PENDING,
  CLOUD_RESOURCE_RESTART_MESSAGE,
  CLOUD_RESOURCE_RESTART_WHERE,
  cloudResourceExplanation,
  cloudResourceRestarts,
  cloudResourceUsage,
  isCloudResourceMessage,
  type CloudResourceKind,
} from './resource-limits'

test('the explanation names the limit, says whether the files are safe, and what to clean up', () => {
  expect(cloudResourceExplanation('disk', true)).toBe(
    "Cloud stopped this turn because the project's disk is almost full (under 2 GB free). Your files are saved. Build output and large folders such as node_modules usually take the space; remove what you no longer need before running this project in Cloud again.",
  )
  expect(cloudResourceExplanation('memory', false)).toContain(
    'used up its memory. Your files are being saved for recovery; this can take a few minutes. A dev server',
  )
  for (const kind of [
    'disk',
    'memory',
    'cpu',
    'processes',
    'files',
    'time',
  ] as CloudResourceKind[]) {
    const text = cloudResourceExplanation(kind, true)
    expect(text.startsWith('Cloud stopped this turn because')).toBe(true)
    expect(text).toContain('Your files are saved.')
    // The note explains; the fixed error line stays the sentence Desktop compares against.
    expect(isCloudResourceMessage(text)).toBe(false)
  }
  expect(isCloudResourceMessage(CLOUD_RESOURCE_MESSAGE)).toBe(true)
  expect(isCloudResourceMessage(CLOUD_RESOURCE_PENDING)).toBe(true)
})

test('a web run is told where its saved files are, and that a new chat will not have them', () => {
  // Desktop moves the chat locally right away; its note is unchanged.
  expect(cloudResourceExplanation('processes', true, true)).toBe(
    cloudResourceExplanation('processes', true),
  )
  expect(cloudResourceExplanation('processes', true)).not.toContain(
    CLOUD_RESOURCE_FILES_WHERE,
  )
  // Web: "Your files are saved" alone sent users to a new chat, which starts
  // from the project's source and was empty.
  const web = cloudResourceExplanation('disk', true, false)
  expect(web).toBe(
    "Cloud stopped this turn because the project's disk is almost full (under 2 GB free). Your files are saved. They stay with this chat, and the Freebuff Desktop app can continue from them on your computer (open the chat there and choose Local). A new chat starts from your project, not from these files, and deleting this chat deletes them. Build output and large folders such as node_modules usually take the space; remove what you no longer need before running this project in Cloud again.",
  )
  expect(cloudResourceExplanation('cpu', false, false)).toContain(
    `this can take a few minutes. ${CLOUD_RESOURCE_FILES_WHERE}`,
  )
  expect(isCloudResourceMessage(web)).toBe(false)
})

test('a process-level trip restarts in Cloud from its saved copy; disk and CPU still do not', () => {
  expect((['files', 'processes', 'memory'] as const).every(cloudResourceRestarts)).toBe(true)
  expect((['disk', 'cpu', 'time', 'archive', 'local_handoff', undefined] as const).some(cloudResourceRestarts)).toBe(false)
  // Web: the dead end "open this chat in Desktop" was all a browser user heard (Lescence, Brendan).
  expect(cloudResourceExplanation('files', true, false)).toBe(
    `Cloud stopped this turn because a process has too many files open. Your files are saved. ${CLOUD_RESOURCE_RESTART_WHERE} A file watcher over a huge folder is the usual cause; stop it before running this project in Cloud again.`,
  )
  expect(cloudResourceExplanation('files', true, false)).not.toContain(CLOUD_RESOURCE_FILES_WHERE)
  // Desktop moves locally as before, and the run error is not the sentence it acts on.
  expect(cloudResourceExplanation('files', true, true)).not.toContain(CLOUD_RESOURCE_RESTART_WHERE)
  expect(isCloudResourceMessage(CLOUD_RESOURCE_RESTART_MESSAGE)).toBe(false)
})

test('the note says how much of the limit was in use, when the runner read it', () => {
  const gb = 1024 ** 3
  expect(cloudResourceExplanation('processes', true, true, { projectPids: 1020, projectPidLimit: 1024, pids: 900, pidLimit: 2048 })).toContain(
    'too many processes. Its limit is 1,024 processes and threads, and 1,020 were running at the last check. Your files are saved.',
  )
  // Without a project limit, the chat's own.
  expect(cloudResourceUsage('processes', { pids: 10, pidLimit: 512 })).toBe('Its limit is 512 processes and threads.')
  expect(cloudResourceUsage('memory', { memory: 7.8 * gb, memoryInactiveFile: 0.3 * gb, memoryLimit: 8 * gb })).toBe(
    'Its memory limit is 8.0 GB, and 7.5 GB was in use at the last check.',
  )
  // After an OOM kill the memory is already free: name the limit only.
  expect(cloudResourceUsage('memory', { memory: 1 * gb, memoryLimit: 16 * gb })).toBe('Its memory limit is 16 GB.')
  expect(cloudResourceUsage('disk', { available: 1.4 * gb })).toBe('At the last check it had 1.4 GB free.')
  expect(cloudResourceUsage('files', { fdPercent: 97, fdComm: 'node <script>' })).toBe(
    'At the last check the process “nodescript” had 97% of its open-file limit in use.',
  )
  expect(cloudResourceUsage('files', { fdPercent: 0 })).toBeNull()
  for (const kind of ['cpu', 'time'] as CloudResourceKind[]) expect(cloudResourceUsage(kind, { available: gb })).toBeNull()
  // No reading: the note is exactly as before.
  expect(cloudResourceExplanation('disk', true, false, undefined)).toBe(cloudResourceExplanation('disk', true, false))
  expect(cloudResourceUsage('memory', null)).toBeNull()
})
