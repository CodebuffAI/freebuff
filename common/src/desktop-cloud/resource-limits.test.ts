import { expect, test } from 'bun:test'
import {
  CLOUD_RESOURCE_MESSAGE,
  CLOUD_RESOURCE_FILES_WHERE,
  CLOUD_RESOURCE_PENDING,
  CLOUD_RESOURCE_RESTART_MESSAGE,
  CLOUD_RESOURCE_RESTART_WHERE,
  cloudResourceExplanation,
  cloudResourceRestarts,
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
