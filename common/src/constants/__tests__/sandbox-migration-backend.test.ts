import { describe, expect, test } from 'bun:test'

import {
  SANDBOX_MIGRATION_BACKEND,
  SANDBOX_MIGRATION_BACKENDS,
  sandboxMigrationMirrored,
  sandboxMigrationReadsFromPostgres,
} from '../sandbox-migration-backend'

describe('SANDBOX_MIGRATION_BACKEND', () => {
  test('allows convex, shadow and postgres, and ships at an allowed value', () => {
    expect([...SANDBOX_MIGRATION_BACKENDS]).toEqual(['convex', 'shadow', 'postgres'])
    expect(SANDBOX_MIGRATION_BACKENDS).toContain('postgres')
    expect(SANDBOX_MIGRATION_BACKENDS).toContain(SANDBOX_MIGRATION_BACKEND)
  })

  test('the mirror and the write-through run at shadow and at postgres', () => {
    expect(sandboxMigrationMirrored('convex')).toBe(false)
    expect(sandboxMigrationMirrored('shadow')).toBe(true)
    expect(sandboxMigrationMirrored('postgres')).toBe(true)
  })

  test('only postgres moves the Convex-reading fences onto Postgres', () => {
    expect(sandboxMigrationReadsFromPostgres('convex')).toBe(false)
    expect(sandboxMigrationReadsFromPostgres('shadow')).toBe(false)
    expect(sandboxMigrationReadsFromPostgres('postgres')).toBe(true)
  })
})
