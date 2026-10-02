/**
 * RFC 9562 version-7 UUID: 48 bits of Unix milliseconds, then 74 random bits.
 *
 * Use it for primary keys of append-heavy tables. A v4 id lands on a random
 * btree page, so every insert dirties a different page and, after each
 * checkpoint, writes that whole page to the WAL again. A v7 id sorts by
 * creation time, so inserts append to the rightmost pages instead
 * (`agent_run`, COD-751). The string is an ordinary UUID: Postgres `uuid`
 * columns, zod's `.uuid()` and every validator that accepts versions 1-8
 * take it unchanged.
 *
 * Ids minted in the same millisecond are unique but not ordered among
 * themselves; nothing here needs a strict sequence.
 */
export function uuidv7(
  now: number = Date.now(),
  random: (bytes: Uint8Array) => Uint8Array = (bytes) =>
    crypto.getRandomValues(bytes),
): string {
  const bytes = random(new Uint8Array(16))
  const ms = Math.max(0, Math.floor(now))
  // 48-bit big-endian timestamp. Division, not bit shifts: JS shifts truncate
  // to 32 bits.
  bytes[0] = Math.floor(ms / 2 ** 40) & 0xff
  bytes[1] = Math.floor(ms / 2 ** 32) & 0xff
  bytes[2] = Math.floor(ms / 2 ** 24) & 0xff
  bytes[3] = Math.floor(ms / 2 ** 16) & 0xff
  bytes[4] = Math.floor(ms / 2 ** 8) & 0xff
  bytes[5] = ms & 0xff
  bytes[6] = (bytes[6]! & 0x0f) | 0x70 // version 7
  bytes[8] = (bytes[8]! & 0x3f) | 0x80 // variant 10xx

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
