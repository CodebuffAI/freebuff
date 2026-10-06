import { compact, flattenDeep } from 'lodash'

type Falsey = false | undefined | null | 0 | ''
type FalseyValueArray<T> = T | Falsey | FalseyValueArray<T>[]

export function buildArray<T>(...params: FalseyValueArray<T>[]) {
  return compact(flattenDeep(params)) as T[]
}
