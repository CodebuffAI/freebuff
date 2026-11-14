import { expect, test } from 'bun:test'
import {
  DESKTOP_RECEIPT_PLATFORMS,
  extractDesktopAcquisitionReceipt,
  parseDesktopAcquisitionReceipt,
} from './desktop-acquisition-receipt'

const ID = '9ba081d8-8090-489e-a445-5a604cd144af'
const ISSUED = Math.floor(Date.parse('2026-10-18T20:00:00Z') / 1_000)
const token = (platform = 'windows') =>
  `v1.${ID}.${ISSUED.toString(36)}.${platform}.${'a'.repeat(43)}`

test('the public syntax parser accepts each release key without pretending to verify its HMAC', () => {
  for (const platform of DESKTOP_RECEIPT_PLATFORMS) {
    expect(parseDesktopAcquisitionReceipt(token(platform))).toEqual({
      acquisition_id: ID,
      issued_at: ISSUED,
      platform,
      token: token(platform),
    })
  }
})

test('receipt syntax rejects identity strings, noncanonical timestamps and trailing data', () => {
  for (const malformed of [
    undefined,
    {},
    'person@example.com',
    token('unsupported'),
    `${token()}\n`,
    `${token()} `,
    token().replace(ID, '00000000-0000-0000-0000-000000000000'),
    token().replace(ISSUED.toString(36), `0${ISSUED.toString(36)}`),
    token().slice(0, -1),
    `${token()}=`,
    token().replace('v1.', 'v0.'),
  ]) {
    expect(parseDesktopAcquisitionReceipt(malformed)).toBeNull()
  }
})

test('filename receipts survive browser collision suffixes across installer formats', () => {
  for (const extension of ['exe', 'app', 'zip', 'AppImage', 'deb']) {
    for (const collision of ['', ' (1)', ' (42)']) {
      const basename = `Freebuff Installer--fb_${token()}${collision}.${extension}`
      expect(
        extractDesktopAcquisitionReceipt(`/downloads/${basename}`),
      ).toEqual(parseDesktopAcquisitionReceipt(token()))
      expect(
        extractDesktopAcquisitionReceipt(
          `C:\\Users\\Person\\Downloads\\${basename}`,
        ),
      ).toEqual(parseDesktopAcquisitionReceipt(token()))
    }
  }
  expect(extractDesktopAcquisitionReceipt('Freebuff Installer.exe')).toBeNull()
  expect(
    extractDesktopAcquisitionReceipt(`Freebuff--fb_${token()}.exe.untrusted`),
  ).toBeNull()
})
