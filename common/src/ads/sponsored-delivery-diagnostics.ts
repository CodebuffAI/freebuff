import { clientUserAgentFields } from '../util/client-user-agent'
import type {
  CapabilityInspection,
  SponsoredCapability,
} from './sponsored-capability'

/** Report client claims only. These fields never authorize delivery or execution. */
export function sponsoredDeliveryClientDiagnostics(input: {
  userAgent?: string | null
  reportedOs?: string
  sponsoredCapability?: SponsoredCapability
  capabilityInspection?: CapabilityInspection
  hasLegacyCapability?: boolean
}) {
  const client = clientUserAgentFields(input.userAgent)
  const os = ['macos', 'windows', 'linux'].includes(input.reportedOs ?? '')
    ? input.reportedOs!
    : 'not_reported'
  const product = client.client_ua_product
  const inferredSurface =
    product === 'freebuff-desktop' && os !== 'not_reported'
      ? `desktop_${os}`
      : product === 'freebuff-cli' && os !== 'not_reported'
        ? `cli_${os}`
        : 'not_reported'
  return {
    ...client,
    client_os: os,
    execution_surface:
      input.sponsoredCapability?.execution.surface ?? inferredSurface,
    capability_contract: input.sponsoredCapability
      ? 'v2'
      : input.capabilityInspection
        ? 'v2_inspection_only'
        : input.hasLegacyCapability
          ? 'v1'
          : 'not_reported',
    capability_inspection: input.capabilityInspection?.status ?? 'not_reported',
  }
}
