export type SiteDomainState =
  | 'pending_dns'
  | 'verification_required'
  | 'pending_tls'
  | 'ready'
  | 'active'
  | 'removing'
  | 'error'
export interface SiteDomain {
  id: string
  hostname: string
  cnameTarget: string
  verificationName: string
  verificationValue: string
  state: SiteDomainState
  ownershipVerified: boolean
  dnsReady: boolean
  tlsReady: boolean
  message: string | null
  checkedAt: string | null
}
export interface SiteDomains {
  domains: SiteDomain[]
  primaryHostname: string | null
  defaultHostname: string
  /** Present on backends that support editing the Freebuff address. */
  platformDomain?: string
}
export type SiteDomainAction = 'connect' | 'verify' | 'primary' | 'remove'
export interface SiteDomainResult {
  operation: {
    id: string
    state: 'running' | 'succeeded' | 'failed' | 'unknown'
    result: Record<string, unknown> | null
  }
}
