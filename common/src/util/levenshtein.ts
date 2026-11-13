/**
 * Edit distance (insert, delete, substitute; each costs 1). Shared by the
 * domain-blacklist typosquat check (`packages/internal/src/domain-blacklist-sweep.ts`)
 * and the sponsored `install_package` typosquat check (COD-965).
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  // Compare code points, not UTF-16 units: an emoji or any other astral
  // character is one edit here rather than two, which keeps the typosquat
  // distance for a name containing one honest.
  const left = Array.from(a)
  const right = Array.from(b)
  const prev = Array.from({ length: right.length + 1 }, (_, i) => i)
  for (let i = 1; i <= left.length; i++) {
    let corner = prev[0]
    prev[0] = i
    for (let j = 1; j <= right.length; j++) {
      const tmp = prev[j]
      prev[j] = Math.min(
        prev[j] + 1,
        prev[j - 1] + 1,
        corner + (left[i - 1] === right[j - 1] ? 0 : 1),
      )
      corner = tmp
    }
  }
  return prev[right.length]
}
