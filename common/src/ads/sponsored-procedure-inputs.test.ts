import { describe, expect, test } from 'bun:test'

import {
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
