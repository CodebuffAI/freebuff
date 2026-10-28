import { expect, test } from 'bun:test'
import {
  CLOUD_RESOURCE_MESSAGE,
  CLOUD_RESOURCE_FILES_WHERE,
  CLOUD_RESOURCE_PENDING,
  cloudResourceExplanation,
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
  const web = cloudResourceExplanation('processes', true, false)
  expect(web).toBe(
    'Cloud stopped this turn because the project is running too many processes. Your files are saved. They are kept for this chat only, and only the Freebuff Desktop app can get them back. A new chat does not start from them, and deleting this chat deletes them. Dev servers and watchers left running are the usual cause; stop the ones you no longer need before running this project in Cloud again.',
  )
  expect(cloudResourceExplanation('cpu', false, false)).toContain(
    `this can take a few minutes. ${CLOUD_RESOURCE_FILES_WHERE}`,
  )
  expect(isCloudResourceMessage(web)).toBe(false)
})
