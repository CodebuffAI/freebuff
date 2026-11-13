import seedrandom from 'seedrandom'

export function sampleSizeWithSeed<T>(
  array: T[],
  size: number,
  seed: string,
): T[] {
  const safeSize = Number.isFinite(size) && size >= 0 ? Math.floor(size) : 0
  const rng = seedrandom(seed)
  const result = array.slice()
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[result[i], result[j]] = [result[j], result[i]]
  }
  return result.slice(0, safeSize)
}
