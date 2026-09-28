import { cloneDeepWith } from 'lodash'

/**
 * lodash cloneDeep destroys zod v4 schema instances.
 *
 * zod v4 stores its engine on a non-enumerable `_zod` property, and lodash
 * only copies enumerable own properties. The clone therefore looks like a
 * schema (has safeParse/def/type) but has no `_zod` internals, and any zod
 * internal that touches `schema._zod.*` detonates with:
 *   "undefined is not an object (evaluating 'schema._zod.def')"
 *
 * This deep-clones plain data (descriptions, maps, arrays) exactly like
 * cloneDeep, but passes zod schema instances through by reference so their
 * internals survive.
 */
export function cloneDeepKeepingZod<T>(value: T): T {
  const cloned = cloneDeepWith(value, (node) => {
    if (isZodSchemaInstance(node)) {
      // Pass the live schema through untouched.
      return node as T
    }
    // Fall through to lodash's default deep clone.
    return undefined
  })
  return cloned as T
}

function isZodSchemaInstance(node: unknown): boolean {
  if (typeof node !== 'object' || node === null) {
    return false
  }
  const candidate = node as { _zod?: unknown }
  return typeof candidate._zod === 'object' && candidate._zod !== null
}
