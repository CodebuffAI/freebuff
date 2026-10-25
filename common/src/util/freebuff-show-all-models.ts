import { FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID } from '../constants/freebuff-model-ids'
import { compiledFreebuffModelIdOfRow } from './freebuff-catalog-compiled-model'

import type { FreebuffModelCatalog } from '../types/freebuff-model-catalog'

/**
 * Settings → General → Show all models, on Desktop and Web. The server
 * decides who has the switch and where it starts (the catalog's
 * `showAllModels`). On, the picker lists the whole catalog. Off, it lists one
 * model, DeepSeek V4.1 Flash, and a one-model catalog is drawn as that
 * model's thinking levels (Fast / Default / Max, `getFreebuffModelPresets`).
 * Only what is listed changes: prices and admission never read this setting.
 */

/**
 * Where the switch stands for this viewer: undefined when the catalog does
 * not offer it (no switch, and every model is listed), else the viewer's own
 * `choice`, or the catalog's default until they make one.
 */
export function showAllModelsSwitch(
  catalog: Pick<FreebuffModelCatalog, 'showAllModels'> | null | undefined,
  choice: boolean | undefined,
): boolean | undefined {
  const option = catalog?.showAllModels
  return option ? (choice ?? option.default) : undefined
}

/**
 * `catalog` as the picker lists it. With the switch off, only DeepSeek V4.1
 * Flash's row, which is also the recommended and fallback row; the whole
 * catalog when that row is missing or locked, so the picker is never left
 * empty or holding only a row nobody can start.
 */
export function pickerFreebuffCatalog(
  catalog: FreebuffModelCatalog,
  choice: boolean | undefined,
): FreebuffModelCatalog {
  if (showAllModelsSwitch(catalog, choice) !== false) return catalog
  const row = catalog.rows.find(
    (candidate) =>
      compiledFreebuffModelIdOfRow(candidate) ===
      FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID,
  )
  if (!row || row.access !== 'open') return catalog
  return {
    ...catalog,
    // Clients redraw when the version changes.
    version: `${catalog.version}.one`,
    rows: [row],
    recommendedKey: row.key,
    fallbackKey: row.key,
  }
}
