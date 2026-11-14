/**
 * Edit distance (insert, delete, substitute; each costs 1). Shared by the
 * domain-blacklist typosquat check (`packages/internal/src/domain-blacklist-sweep.ts`)
 * and the sponsored `install_package` typosquat check (COD-965).
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let corner = prev[0]
    prev[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]
      prev[j] = Math.min(
        prev[j] + 1,
        prev[j - 1] + 1,
        corner + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
      corner = tmp
    }
  }
  return prev[b.length]
}
