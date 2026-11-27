import { z } from 'zod/v4'

export const ACCOUNT_INSTRUCTIONS_PATH = '/api/v1/cloud/account-instructions'
export const ACCOUNT_INSTRUCTIONS_LIMIT = 16_000
export const ACCOUNT_INSTRUCTIONS_BODY_LIMIT =
  ACCOUNT_INSTRUCTIONS_LIMIT * 12 + 2048
const text = z.string().max(ACCOUNT_INSTRUCTIONS_LIMIT)
export const accountInstructionsSnapshot = z
  .object({ accountId: z.string().min(1), instructions: text })
  .strict()
export const accountInstructionsUpdate = z
  .object({
    expectedAccountId: z.string().min(1).max(256),
    expected: text,
    instructions: text,
  })
  .strict()

export const accountInstructionsImport = z
  .object({
    expectedAccountId: z.string().min(1).max(256),
    sourceKey: z.string().regex(/^[0-9a-f]{64}$/),
    instructions: text.min(1),
  })
  .strict()
