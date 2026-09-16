import { describe, expect, test } from 'bun:test'

import {
  advertiserClickIdFromLink,
  ADVERTISER_LINK_PLACEHOLDER,
  procedureDeclaresAdvertiserLink,
  sponsoredProcedureRuntimeInputsSection,
  SPONSORED_RUNTIME_INPUTS_HEADING,
} from './sponsored-procedure-inputs'

/**
 * Runtime inputs to a sponsored procedure (COD-512). The property under test
 * is the consent contract: the reviewed procedure text is never rewritten,
 * and the link reaches the run as a separate section only when the procedure
 * asked for it.
 */

const LINK = 'https://acme.example/signup?bfcid=bfc_1.p.s'
const DECLARING = [
  'Wire Acme into this repo.',
  'Write .env.example with a comment: # Sign up at {{advertiserLink}}',
  'In the PR body include: Get started: {{advertiserLink}}',
].join('\n')
const SILENT = 'Wire Acme into this repo and open no links.'

describe('procedureDeclaresAdvertiserLink', () => {
  test('is exactly the placeholder being present', () => {
    expect(procedureDeclaresAdvertiserLink(DECLARING)).toBe(true)
    expect(procedureDeclaresAdvertiserLink(SILENT)).toBe(false)
    expect(procedureDeclaresAdvertiserLink('advertiserLink')).toBe(false)
    expect(procedureDeclaresAdvertiserLink('{{ advertiserLink }}')).toBe(false)
    expect(ADVERTISER_LINK_PLACEHOLDER).toBe('{{advertiserLink}}')
  })
})

describe('command-scoped advertiser attribution', () => {
  const procedure =
    "SPECIFIC_FREEBUFF_BFCID='{{advertiserClickId}}' specific login\nSPECIFIC_FREEBUFF_BFCID='{{advertiserClickId}}' specific claim"

  test('supplies the click ID without rewriting consent or exposing an unrequested URL', () => {
    const section = sponsoredProcedureRuntimeInputsSection(procedure, {
      advertiserLink: LINK,
    })!
    expect(section).toContain('- advertiserClickId: bfc_1.p.s')
    expect(section).not.toContain(LINK)
    expect(section).toContain('command-scoped environment variable')
    expect(section).toContain('never export it globally')
    expect(procedure).toContain('{{advertiserClickId}}')
    expect(
      sponsoredProcedureRuntimeInputsSection(DECLARING, {
        advertiserLink: LINK,
      }),
    ).not.toContain('- advertiserClickId:')
  })

  test('can declare both runtime values independently', () => {
    const section = sponsoredProcedureRuntimeInputsSection(
      `${DECLARING}\n${procedure}`,
      { advertiserLink: LINK },
    )!
    expect(section).toContain(`- advertiserLink: ${LINK}`)
    expect(section).toContain('- advertiserClickId: bfc_1.p.s')
  })

  test('accepts live and test IDs and preserves their bytes', () => {
    for (const token of ['bfc_1.ab_C-12.sig_34', 'bfc_test_1.ab_C-12.sig_34']) {
      expect(
        advertiserClickIdFromLink(
          `https://specific.dev/?other=1&bfcid=${token}#start`,
        ),
      ).toBe(token)
    }
  })

  test('refuses absent, ambiguous, oversized and shell-unsafe IDs without leaking them', () => {
    for (const link of [
      undefined,
      null,
      '',
      'not a URL',
      'http://specific.dev/?bfcid=bfc_1.p.s',
      'https://specific.dev/',
      'https://specific.dev/?bfcid=spct_placeholder',
      'https://specific.dev/?bfcid=bfc_1.p.s&bfcid=bfc_1.p.s',
      `https://specific.dev/?bfcid=bfc_1.${'p'.repeat(512)}.s`,
      'https://specific.dev/?bfcid=bfc_1.p.s%27%3Btouch%20bad',
      'https://specific.dev/?bfcid=bfc_1.p.s%0Aecho%20bad',
    ]) {
      expect(advertiserClickIdFromLink(link)).toBeNull()
      const section = sponsoredProcedureRuntimeInputsSection(procedure, {
        advertiserLink: link,
      })!
      expect(section).toContain('advertiserClickId: unavailable')
      expect(section).toContain('Skip commands')
      expect(section).not.toContain('bfc_1.')
    }
  })

  test('a command-scoped assignment reaches the child but not the next command', async () => {
    const token = advertiserClickIdFromLink(LINK)!
    // A harmless child process stands in for Specific; no login or network activity.
    const child = Bun.spawn(
      [
        '/bin/sh',
        '-c',
        `SPECIFIC_FREEBUFF_BFCID='${token}' sh -c 'printf "%s" "$SPECIFIC_FREEBUFF_BFCID"'; printf "|%s" "${'$'}{SPECIFIC_FREEBUFF_BFCID-unset}"`,
      ],
      { env: { PATH: '/usr/bin:/bin' }, stdout: 'pipe', stderr: 'pipe' },
    )
    expect(await new Response(child.stdout).text()).toBe(`${token}|unset`)
    expect(await child.exited).toBe(0)
  })
})

describe('sponsoredProcedureRuntimeInputsSection', () => {
  test('a procedure that declares nothing gets no section, link or not', () => {
    expect(
      sponsoredProcedureRuntimeInputsSection(SILENT, { advertiserLink: LINK }),
    ).toBeNull()
    expect(sponsoredProcedureRuntimeInputsSection(SILENT, {})).toBeNull()
  })

  test('a declaring procedure gets the link verbatim, under the non-instruction heading', () => {
    const section = sponsoredProcedureRuntimeInputsSection(DECLARING, {
      advertiserLink: LINK,
    })!
    expect(section.startsWith(SPONSORED_RUNTIME_INPUTS_HEADING)).toBe(true)
    expect(section).toContain(`- advertiserLink: ${LINK}`)
    expect(section).toContain(ADVERTISER_LINK_PLACEHOLDER)
    expect(section).toContain('.env.example')
    expect(section).toContain('pull request body')
  })

  test('a declaring procedure with no link yet is told to omit the line, never to keep the placeholder', () => {
    for (const inputs of [
      {},
      { advertiserLink: null },
      { advertiserLink: '' },
      { advertiserLink: '  ' },
    ]) {
      const section = sponsoredProcedureRuntimeInputsSection(DECLARING, inputs)!
      expect(section).toContain('- advertiserLink: unavailable for this run')
      expect(section).toContain('omit that line entirely')
      expect(section).not.toContain('https://')
    }
  })

  test('never touches the procedure text itself', () => {
    // The section is a return value; the caller appends it. Nothing here can
    // reach the procedure string, which is what keeps its SHA-256 the one the
    // user consented to.
    const before = DECLARING
    sponsoredProcedureRuntimeInputsSection(DECLARING, { advertiserLink: LINK })
    expect(DECLARING).toBe(before)
    expect(DECLARING).toContain(ADVERTISER_LINK_PLACEHOLDER)
  })
})
