import { describe, expect, test } from 'bun:test'
import { sponsoredDeliveryClientDiagnostics } from '../sponsored-delivery-diagnostics'

describe('sponsored delivery client diagnostics', () => {
  test('legacy capability does not turn a Windows request into a Mac request', () => {
    expect(
      sponsoredDeliveryClientDiagnostics({
        userAgent: 'Freebuff-Desktop/0.0.113',
        reportedOs: 'windows',
        hasLegacyCapability: true,
        capabilityInspection: {
          status: 'unavailable',
          reason: 'windows_no_containment',
        },
      }),
    ).toMatchObject({
      execution_surface: 'desktop_windows',
      client_os: 'windows',
      client_ua_version: '0.0.113',
      capability_contract: 'v2_inspection_only',
      capability_inspection: 'unavailable',
    })
  })

  test('separates old client evidence from a new client missing its report', () => {
    for (const version of ['0.0.112', '0.0.113']) {
      expect(
        sponsoredDeliveryClientDiagnostics({
          userAgent: `Freebuff-Desktop/${version}`,
          reportedOs: 'macos',
          hasLegacyCapability: true,
        }),
      ).toMatchObject({
        execution_surface: 'desktop_macos',
        client_ua_version: version,
        capability_contract: 'v1',
        capability_inspection: 'not_reported',
      })
    }
  })

  test('missing OS is unknown even with legacy project facts', () => {
    expect(
      sponsoredDeliveryClientDiagnostics({
        userAgent: 'Freebuff-Desktop/0.0.113',
        hasLegacyCapability: true,
      }).execution_surface,
    ).toBe('not_reported')
  })

  test('keeps user-agent comments and arbitrary OS text out of telemetry', () => {
    const result = sponsoredDeliveryClientDiagnostics({
      userAgent:
        'Freebuff-Desktop/0.0.113 (private@example.com /private/project)',
      reportedOs: '/private/project',
    })
    expect(result.client_ua_version).toBe('0.0.113')
    expect(result.client_os).toBe('not_reported')
    expect(JSON.stringify(result)).not.toContain('private')
  })
})
