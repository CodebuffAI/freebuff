/** Gravity exclusivity: credentials and routing overrides cannot enable other networks. */
export function isAdProviderEnabled(provider: string): boolean {
  return (
    provider === 'gravity' || provider === 'first_party' || provider === 'house'
  )
}
