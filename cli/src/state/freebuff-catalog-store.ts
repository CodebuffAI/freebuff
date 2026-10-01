import { listableFreebuffCatalogRows } from '@codebuff/common/types/freebuff-model-catalog'
import { create } from 'zustand'

import {
  catalogFreebuffModelDirectory,
  compiledFreebuffModelDirectory,
} from '../utils/freebuff-model-directory'

import type { FreebuffModelDirectory } from '../utils/freebuff-model-directory'
import type { FreebuffModelCatalog } from '@codebuff/common/types/freebuff-model-catalog'

/**
 * The server model catalog this process holds, if any
 * (docs/freebuff-model-catalog.md). In memory only: a catalog carries handles,
 * which are minted per account and rotate, so none of it is ever written to
 * disk.
 *
 * `catalog !== null` IS catalog mode. Everything that differs between the two
 * modes reads `directory`, which is the compiled directory whenever there is
 * no catalog, so fallback mode is the pre-catalog behaviour by construction.
 *
 * Deliberately dependency-free (no settings, no session, no model store): the
 * model store and the session API read it, and the fetch controller
 * (utils/freebuff-model-catalog.ts) is the only writer.
 */
interface FreebuffCatalogStore {
  catalog: FreebuffModelCatalog | null
  directory: FreebuffModelDirectory
  /**
   * Refetch the catalog after the server answered `freebuff_catalog_stale`.
   * Resolves true when a fresh catalog is now held (retry with the new
   * handle), false otherwise (surface the error). Registered by the
   * controller while it runs; null means nobody can refresh.
   */
  refreshAfterStale: (() => Promise<boolean>) | null
}

export const useFreebuffCatalogStore = create<FreebuffCatalogStore>(() => ({
  catalog: null,
  directory: compiledFreebuffModelDirectory,
  refreshAfterStale: null,
}))

/** Replace the held catalog (null returns to fallback mode). Only the fetch
 *  controller and tests call this; it does not reconcile any selection.
 *
 *  Rows that have not opened yet (scheduled launches) are dropped here, before
 *  anything can read them, so the held catalog only ever has rows this client
 *  may list, select and send. A row that opens later appears with the next
 *  fetch (the server schedules one by `refreshAt`). */
export function setFreebuffCatalog(catalog: FreebuffModelCatalog | null): void {
  const now = Date.now()
  const held = catalog ? withoutUnopenedRows(catalog, now) : null
  useFreebuffCatalogStore.setState({
    catalog: held,
    directory: held
      ? catalogFreebuffModelDirectory(held, now)
      : compiledFreebuffModelDirectory,
  })
}

function withoutUnopenedRows(
  catalog: FreebuffModelCatalog,
  now: number,
): FreebuffModelCatalog {
  const rows = listableFreebuffCatalogRows(catalog, now)
  return rows.length === catalog.rows.length ? catalog : { ...catalog, rows }
}

export function getFreebuffCatalog(): FreebuffModelCatalog | null {
  return useFreebuffCatalogStore.getState().catalog
}

export function isFreebuffCatalogMode(): boolean {
  return useFreebuffCatalogStore.getState().catalog !== null
}

/** Imperative read for non-React callers. */
export function getFreebuffModelDirectory(): FreebuffModelDirectory {
  return useFreebuffCatalogStore.getState().directory
}

/** The directory for render code; re-renders when the mode or catalog changes. */
export function useFreebuffModelDirectory(): FreebuffModelDirectory {
  return useFreebuffCatalogStore((s) => s.directory)
}
