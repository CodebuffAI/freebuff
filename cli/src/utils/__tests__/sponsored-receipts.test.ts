/**
 * The receipts are three things at once -- the verdict, the outcomes and the
 * undo -- so the pieces each of those reads are pinned here directly.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  SponsoredEditRecorder,
  addedLines,
  readSponsoredLedger,
  sponsoredOutcomesFromReceipts,
  sponsoredReceiptStore,
  undoSponsoredReceipts,
} from '../sponsored-receipts'

import type { SponsoredEditReceipt } from '../sponsored-receipts'

const PARENT = mkdtempSync(join(tmpdir(), 'sponsored-receipts-'))
afterAll(() => rmSync(PARENT, { recursive: true, force: true }))

const RUN_ID = '00000000-0000-4000-8000-00000000000a'

const snapshot = (text: string) => ({
  sha256: 'unused',
  bytes: Buffer.from(text).toString('base64'),
})

describe('added lines', () => {
  test('are the lines the file gained, not a diff', () => {
    const receipt: SponsoredEditReceipt = {
      path: '.env.example',
      before: snapshot('A=1\nB=2\n'),
      after: snapshot('A=1\nB=2\nSUPABASE_URL=\nSUPABASE_ANON_KEY=\n'),
    }
    expect(addedLines(receipt)).toBe('SUPABASE_URL=\nSUPABASE_ANON_KEY=')
  })

  test('a created file adds every line', () => {
    const receipt: SponsoredEditReceipt = {
      path: 'src/db.ts',
      before: null,
      after: snapshot('export const db = 1'),
    }
    expect(addedLines(receipt)).toBe('export const db = 1')
  })

  test('a binary file adds nothing a rule could read', () => {
    const receipt: SponsoredEditReceipt = {
      path: 'logo.png',
      before: null,
      after: {
        sha256: 'x',
        bytes: Buffer.from([0x89, 0x50, 0x00, 0x01]).toString('base64'),
      },
    }
    expect(addedLines(receipt)).toBeNull()
  })
})

describe('outcomes', () => {
  test('nothing is credited that the procedure did not declare', () => {
    const receipt: SponsoredEditReceipt = {
      path: '.env.example',
      before: null,
      after: snapshot('SUPABASE_URL=\nSUPABASE_ANON_KEY=\n'),
    }
    expect(
      sponsoredOutcomesFromReceipts('Set up Supabase.', [receipt]),
    ).toEqual({})
  })
})

describe('the default store', () => {
  test('writes private files outside the project, keyed by run id', () => {
    const store = sponsoredReceiptStore(join(PARENT, 'store'))
    store.write(RUN_ID, '{"runId":"x","receipts":[]}')
    const file = join(PARENT, 'store', `${RUN_ID}.json`)
    expect(readFileSync(file, 'utf8')).toContain('receipts')
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(() => store.write('../escape', '{}')).toThrow()
  })
})

describe('recording and undoing', () => {
  test('the before-image is the user’s, however many times the run edits', async () => {
    const root = join(PARENT, 'project-a')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'a.ts'), 'original\n')
    const store = sponsoredReceiptStore(join(PARENT, 'store-a'))
    const recorder = new SponsoredEditRecorder(
      {
        runId: RUN_ID,
        proposalId: 'p',
        advertiserName: 'Acme',
        projectRoot: root,
      },
      store,
    )
    for (const draft of ['first\n', 'second\n', 'final\n']) {
      await recorder.around('a.ts', async () => {
        writeFileSync(join(root, 'a.ts'), draft)
      })
    }
    const ledger = readSponsoredLedger(store, RUN_ID)!
    const result = undoSponsoredReceipts(ledger, store)
    expect(result.restored).toEqual(['a.ts'])
    expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe('original\n')
    expect(readSponsoredLedger(store, RUN_ID)!.undoneAt).toBeNumber()
    expect(
      undoSponsoredReceipts(readSponsoredLedger(store, RUN_ID)!, store),
    ).toMatchObject({ alreadyUndone: true })
  })

  test('a write that is put back by the run itself is not a change', async () => {
    const root = join(PARENT, 'project-b')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'b.ts'), 'same\n')
    const recorder = new SponsoredEditRecorder(
      {
        runId: '00000000-0000-4000-8000-00000000000b',
        proposalId: 'p',
        advertiserName: 'Acme',
        projectRoot: root,
      },
      sponsoredReceiptStore(join(PARENT, 'store-b')),
    )
    await recorder.around('b.ts', async () => {
      writeFileSync(join(root, 'b.ts'), 'changed\n')
    })
    await recorder.around('b.ts', async () => {
      writeFileSync(join(root, 'b.ts'), 'same\n')
    })
    expect(recorder.changed()).toEqual([])
  })
})
