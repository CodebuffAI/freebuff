import { describe, expect, test } from 'bun:test'

import {
  adLinkUtmCampaign,
  adLinkUtmTags,
  advertiserLinkDomains,
  tagSponsoredProcedureLinks,
  withDefaultAdLinkUtm,
} from './ad-link-utm'

const TAGS = 'utm_source=freebuff&utm_medium=paid&utm_campaign=secrets'
const DEFAULT_TAGS = adLinkUtmTags({ id: 'c1', name: 'Secrets' })

describe('withDefaultAdLinkUtm', () => {
  test('tags an untagged link and keeps its path, query and fragment', () => {
    expect(
      withDefaultAdLinkUtm(
        'https://acme.example/signup?ref=a#top',
        DEFAULT_TAGS,
      ),
    ).toBe(`https://acme.example/signup?ref=a&${TAGS}#top`)
  })

  test('leaves a link the advertiser already tagged byte-identical', () => {
    const tagged = 'https://acme.example/?UTM_Source=newsletter&x=1'
    expect(withDefaultAdLinkUtm(tagged, DEFAULT_TAGS)).toBe(tagged)
  })

  test('returns unparseable and non-http input unchanged', () => {
    expect(withDefaultAdLinkUtm('not a url', DEFAULT_TAGS)).toBe('not a url')
    expect(withDefaultAdLinkUtm('mailto:a@acme.example', DEFAULT_TAGS)).toBe(
      'mailto:a@acme.example',
    )
  })
})

describe('adLinkUtmTags', () => {
  test("adopts the advertiser's own campaign tags from its landing URL", () => {
    expect(
      adLinkUtmTags({
        id: 'c1',
        name: 'Secrets Management',
        landingUrl:
          'https://get.acme.example/lp/?utm_source=freebuff&utm_medium=cpc&utm_campaign=secrets_management&utm_content=text-ad',
      }),
    ).toEqual([
      ['utm_source', 'freebuff'],
      ['utm_medium', 'cpc'],
      ['utm_campaign', 'secrets_management'],
    ])
  })

  test('uses ours when the landing URL names no utm_source', () => {
    expect(
      adLinkUtmTags({
        id: 'c1',
        name: 'Secrets Management',
        landingUrl: 'https://acme.example/?utm_campaign=orphan',
      }),
    ).toEqual([
      ['utm_source', 'freebuff'],
      ['utm_medium', 'paid'],
      ['utm_campaign', 'secrets-management'],
    ])
  })
})

describe('adLinkUtmCampaign', () => {
  test('slugs the campaign name', () => {
    expect(
      adLinkUtmCampaign({ id: 'c1', name: '  Secrets Management!  ' }),
    ).toBe('secrets-management')
    expect(adLinkUtmCampaign({ id: 'c1', name: 'Café Déploy' })).toBe(
      'cafe-deploy',
    )
  })

  test('falls back to the id when the name has no usable characters', () => {
    expect(adLinkUtmCampaign({ id: 'c1', name: '***' })).toBe('c1')
    expect(adLinkUtmCampaign({ id: 'c1', name: null })).toBe('c1')
  })
})

describe('advertiserLinkDomains', () => {
  test('reduces every URL to its registrable domain', () => {
    expect(
      advertiserLinkDomains([
        'https://get.acme.example/landing',
        'https://www.acme.example/',
        'https://shop.acme.co.uk/x',
        null,
        'garbage',
      ]).sort(),
    ).toEqual(['acme.co.uk', 'acme.example'])
  })
})

describe('tagSponsoredProcedureLinks', () => {
  const input = { domains: ['acme.example'], tags: DEFAULT_TAGS }

  test('tags pages the user opens on any subdomain, keeping sentence punctuation', () => {
    const procedure = [
      'Direct the user to sign up at https://app.acme.example.',
      'Install per https://acme.example/docs/cli/overview, then continue.',
      'See [the guide](https://acme.example/docs/guide) for details.',
    ].join('\n')
    expect(tagSponsoredProcedureLinks(procedure, input)).toBe(
      [
        `Direct the user to sign up at https://app.acme.example/?${TAGS}.`,
        `Install per https://acme.example/docs/cli/overview?${TAGS}, then continue.`,
        `See [the guide](https://acme.example/docs/guide?${TAGS}) for details.`,
      ].join('\n'),
    )
  })

  test('leaves code, commands, API and file URLs untouched', () => {
    const procedure = [
      'Fetch https://acme.example/docs/llms.txt first.',
      'Run `curl https://acme.example/docs/page` to check.',
      '```sh',
      'open https://app.acme.example/settings',
      '```',
      'Or run curl -fsSL https://get.acme.example/install | sh on Linux.',
      'Call https://api.acme.example/v1/projects or https://app.acme.example/api/v2/keys.',
    ].join('\n')
    expect(tagSponsoredProcedureLinks(procedure, input)).toBe(procedure)
  })

  test('a command earlier in another clause does not suppress a prose link', () => {
    expect(
      tagSponsoredProcedureLinks(
        'If the project uses bun, sign up at https://app.acme.example.',
        input,
      ),
    ).toBe(
      `If the project uses bun, sign up at https://app.acme.example/?${TAGS}.`,
    )
  })

  test("leaves other companies' links and already-tagged links alone", () => {
    const procedure =
      'Read https://github.com/acme/cli and https://acme.example/?utm_source=x.'
    expect(tagSponsoredProcedureLinks(procedure, input)).toBe(procedure)
  })

  test('is idempotent', () => {
    const once = tagSponsoredProcedureLinks(
      'Sign up at https://app.acme.example and read https://acme.example/docs.',
      input,
    )
    expect(tagSponsoredProcedureLinks(once, input)).toBe(once)
  })

  test('does nothing without advertiser domains', () => {
    const procedure = 'Sign up at https://app.acme.example.'
    expect(
      tagSponsoredProcedureLinks(procedure, {
        domains: [],
        tags: DEFAULT_TAGS,
      }),
    ).toBe(procedure)
  })
})
