/** In-memory KV double for the worker tests — the subset of the Workers KV
 *  API the license backend actually uses. */

import type { KVLike } from '../src/store'

export class MemoryKV implements KVLike {
  readonly store = new Map<string, string>()
  readonly expirations = new Map<string, number>()

  async get(key: string): Promise<string | null> {
    const expiry = this.expirations.get(key)
    if (expiry !== undefined && expiry * 1000 <= Date.now()) {
      this.store.delete(key)
      this.expirations.delete(key)
      return null
    }
    return this.store.get(key) ?? null
  }

  async put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void> {
    this.store.set(key, value)
    if (options?.expirationTtl) {
      this.expirations.set(
        key,
        Math.floor(Date.now() / 1000) + options.expirationTtl,
      )
    }
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key)
    this.expirations.delete(key)
  }

  async list(options?: {
    prefix?: string
  }): Promise<{ keys: { name: string }[] }> {
    const prefix = options?.prefix ?? ''
    return {
      keys: [...this.store.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((name) => ({ name })),
    }
  }
}
