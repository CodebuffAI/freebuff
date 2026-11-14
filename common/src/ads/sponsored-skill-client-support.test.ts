import { describe, expect, test } from 'bun:test'

import {
  compareSponsoredSkillVersions,
  renderSponsoredSkillProcedure,
  sponsoredSkillDirective,
} from './sponsored-skill'
import {
  CONVERSION_DIRECTIVE,
  SPONSORED_CONVERSION_TOOLS_VERSION,
  clientHasSponsoredConversionTools,
} from './sponsored-conversion'
import {
  SPONSORED_DESKTOP_SKILL_FETCH_MIN,
  SPONSORED_SKILL_FORMAT_2_MIN_CLIENT,
  SPONSORED_SKILL_MIN_CLIENT,
  sponsoredConversionClientRefusal,
  sponsoredSkillClientRefusal,
} from './sponsored-skill-client-support'
import { SPONSORED_SKILLS } from './sponsored-skills/registry'

const EXA_2 = { id: 'exa-web-search-feature', version: '2.0.0' }
const EXA_1_1 = { id: 'exa-web-search-feature', version: '1.1.0' }
const WITH_PACKAGES = { packages: [{ name: 'exa-js' }] }

const refusal = (
  clientVersion: string | null,
  overrides: Partial<Parameters<typeof sponsoredSkillClientRefusal>[0]> = {},
) =>
  sponsoredSkillClientRefusal({
    client: clientVersion?.startsWith('cli/') ? 'cli' : 'desktop',
    clientVersion,
    skillRef: EXA_2,
    skill: WITH_PACKAGES,
    ...overrides,
  })

describe('sponsoredSkillClientRefusal', () => {
  test('Desktop builds without declared installs or the skill fetch are refused', () => {
    expect(refusal('desktop/0.0.169')).toBe('desktop_too_old')
    expect(refusal('desktop/0.0.170')).toBe('desktop_too_old')
    expect(refusal('desktop/0.0.171')).toBe('desktop_too_old')
  })

  test('Desktop from the fetch build on runs it', () => {
    expect(refusal('desktop/0.0.172')).toBeNull()
    expect(refusal('desktop/0.0.173')).toBeNull()
    expect(refusal('desktop/0.1.0')).toBeNull()
  })

  test('a CLI before Accept delivery runs only a skill its release bundles', () => {
    expect(refusal('cli/0.2.28')).toBe('cli_too_old')
    expect(refusal('cli/0.2.27', { skillRef: EXA_1_1 })).toBe('cli_too_old')
    expect(refusal('cli/0.2.28', { skillRef: EXA_1_1 })).toBeNull()
  })

  test('a CLI with Accept delivery runs any skill', () => {
    expect(refusal('cli/0.2.29')).toBeNull()
    expect(refusal('cli/0.3.0')).toBeNull()
    // ...but only one the server could read, since that is what it delivers.
    expect(refusal('cli/0.2.29', { skill: null })).toBe('cli_too_old')
    expect(refusal('cli/0.2.29', { skillRef: EXA_1_1, skill: null })).toBeNull()
  })

  test('dev builds pass; an unreadable version does not', () => {
    expect(refusal('desktop/dev')).toBeNull()
    expect(refusal('cli/dev')).toBeNull()
    expect(refusal(null)).toBe('client_version_unknown')
    expect(refusal('desktop/nightly')).toBe('client_version_unknown')
    expect(refusal('cli/0.2.28', { client: 'desktop' })).toBe(
      'client_version_unknown',
    )
  })

  test('nothing to refuse: free text, no packages, or the web client', () => {
    expect(refusal('desktop/0.0.169', { skillRef: null })).toBeNull()
    expect(refusal('desktop/0.0.169', { skill: { packages: [] } })).toBeNull()
    expect(refusal(null, { client: 'web' })).toBeNull()
  })

  test('a named skill that could not be read is treated as declaring packages', () => {
    expect(refusal('desktop/0.0.171', { skill: null })).toBe('desktop_too_old')
    expect(refusal('desktop/0.0.172', { skill: null })).toBeNull()
    expect(refusal('cli/0.2.28', { skill: null })).toBe('cli_too_old')
  })
})

describe('SPONSORED_SKILL_MIN_CLIENT', () => {
  test('names only shipped skill versions that declare packages', () => {
    for (const key of Object.keys(SPONSORED_SKILL_MIN_CLIENT)) {
      const skill = SPONSORED_SKILLS.get(key)
      expect(skill, key).toBeDefined()
      expect(skill!.packages.length, key).toBeGreaterThan(0)
    }
  })

  test('a run-spec client is never refused for its version', () => {
    for (const clientVersion of [
      'desktop/0.0.169',
      'cli/0.2.20',
      null,
      'desktop/garbage',
    ])
      expect(refusal(clientVersion, { runSpecVersion: 1 })).toBeNull()
  })

  test('a run-spec client is refused only when the server has no skill', () => {
    expect(refusal('cli/0.2.40', { runSpecVersion: 1, skill: null })).toBe(
      'skill_unresolved',
    )
    expect(
      refusal(null, { client: 'web', runSpecVersion: 1, skill: null }),
    ).toBe('skill_unresolved')
    expect(
      refusal(null, { runSpecVersion: 1, skill: null, skillRef: null }),
    ).toBeNull()
  })

  test('an unknown runSpecVersion keeps the version rule', () => {
    expect(refusal('desktop/0.0.171', { runSpecVersion: 2 })).toBe(
      'desktop_too_old',
    )
  })

  test('never lowers Desktop below the fetch build', () => {
    for (const [key, min] of Object.entries(SPONSORED_SKILL_MIN_CLIENT)) {
      if (!min.desktop) continue
      expect(
        compareSponsoredSkillVersions(
          min.desktop,
          SPONSORED_DESKTOP_SKILL_FETCH_MIN,
        ),
        key,
      ).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('format 2 needs a build that parses it', () => {
  const ref = { id: 'acme-thing', version: '4.0.0' }
  const format2 = { packages: [], format: 2 }
  test('older Desktop and CLI builds are refused, run-spec ones included', () => {
    expect(
      sponsoredSkillClientRefusal({ client: 'desktop', clientVersion: 'desktop/0.0.173', skillRef: ref, skill: format2 }),
    ).toBe('desktop_too_old')
    expect(
      sponsoredSkillClientRefusal({ client: 'desktop', clientVersion: 'desktop/0.0.173', skillRef: ref, skill: format2, runSpecVersion: 1 }),
    ).toBe('desktop_too_old')
    expect(
      sponsoredSkillClientRefusal({ client: 'cli', clientVersion: 'cli/0.2.28', skillRef: ref, skill: format2 }),
    ).toBe('cli_too_old')
    expect(
      sponsoredSkillClientRefusal({ client: 'desktop', clientVersion: null, skillRef: ref, skill: format2 }),
    ).toBe('client_version_unknown')
  })

  test('a build at the floor, dev builds, web and format 1 are not refused for it', () => {
    expect(
      sponsoredSkillClientRefusal({
        client: 'desktop',
        clientVersion: `desktop/${SPONSORED_SKILL_FORMAT_2_MIN_CLIENT.desktop}`,
        skillRef: ref,
        skill: format2,
      }),
    ).toBeNull()
    expect(
      sponsoredSkillClientRefusal({ client: 'desktop', clientVersion: 'desktop/dev', skillRef: ref, skill: format2 }),
    ).toBeNull()
    expect(
      sponsoredSkillClientRefusal({ client: 'web', clientVersion: null, skillRef: ref, skill: format2 }),
    ).toBeNull()
    expect(
      sponsoredSkillClientRefusal({ client: 'desktop', clientVersion: 'desktop/0.0.173', skillRef: ref, skill: { packages: [], format: 1 } }),
    ).toBeNull()
  })
})

describe('a conversion skill needs a Desktop build with the conversion tools', () => {
  const ref = { id: 'acme-thing', version: '4.0.0' }
  const v1 = {
    id: 'acme-signup',
    version: 1,
    goal: 'Create an Acme account',
    criteria: [
      {
        id: 'account',
        claim: 'new_account',
        origin: 'https://acme.example',
        createdAtSelector: '[data-created-at]',
      },
    ],
  }
  const v2 = {
    id: 'acme-signup',
    version: 2,
    goal: 'Create an Acme account and API key',
    criteria: [
      {
        id: 'key',
        claim: 'new_api_key',
        origin: 'https://acme.example',
        instructions: 'The keys page lists a key created during this run.',
        credentialEnv: 'ACME_API_KEY',
      },
    ],
  }
  const conversions = { v1, v2 }
  const skillWith = (conversion: unknown, extra: { format?: number } = {}) => ({
    packages: [{ name: 'acme-sdk' }],
    conversion,
    ...extra,
  })
  const procedureWith = (conversion: unknown) =>
    [
      'skill: acme-thing@4.0.0 sha256:' + '0'.repeat(64),
      CONVERSION_DIRECTIVE + JSON.stringify(conversion),
      '',
      'Goal: x',
    ].join('\n')
  const decide = (
    client: 'desktop' | 'cli' | 'web' | null,
    clientVersion: string | null,
    rest: Partial<Parameters<typeof sponsoredSkillClientRefusal>[0]> = {},
  ) =>
    sponsoredSkillClientRefusal({
      client,
      clientVersion,
      skillRef: ref,
      skill: skillWith(v2),
      ...rest,
    })

  const TOOLS = { conversionToolsVersion: SPONSORED_CONVERSION_TOOLS_VERSION }

  test('v3 requires the onboarding-capable tool set, including procedure-only serving', () => {
    const conversion = {
      id: 'onboarding',
      version: 3,
      goal: 'Verify product onboarding',
      criteria: [
        { id: 'sign-in', claim: 'signed_in', origin: 'https://example.com' },
      ],
    }
    for (const rest of [
      { skill: skillWith(conversion as never) },
      { skill: null, procedure: procedureWith(conversion) },
    ]) {
      expect(
        decide('desktop', 'desktop/dev', {
          ...rest,
          conversionToolsVersion: 1,
        }),
      ).toBe('desktop_too_old')
      expect(
        decide('desktop', 'desktop/dev', {
          ...rest,
          conversionToolsVersion: 2,
        }),
      ).toBeNull()
    }
  })

  test('only an integer tool-set version of at least 1 counts as the tools', () => {
    expect(SPONSORED_CONVERSION_TOOLS_VERSION).toBe(2)
    for (const yes of [1, 2])
      expect(clientHasSponsoredConversionTools(yes), String(yes)).toBe(true)
    for (const no of [undefined, null, 0, -1, 0.5, 1.5, '1', true, NaN, Infinity, {}])
      expect(clientHasSponsoredConversionTools(no), String(no)).toBe(false)
  })

  for (const [name, conversion] of Object.entries(conversions)) {
    describe(`version ${name}`, () => {
      const skill = skillWith(conversion)

      test('every CLI build is refused, run-spec or not, dev included', () => {
        for (const clientVersion of [
          'cli/0.2.20',
          'cli/0.2.29',
          'cli/9.9.9',
          'cli/dev',
          null,
        ]) {
          expect(decide('cli', clientVersion, { skill }), String(clientVersion)).toBe(
            'conversion_tools_missing',
          )
          expect(
            decide('cli', clientVersion, { skill, runSpecVersion: 1 }),
            String(clientVersion),
          ).toBe('conversion_tools_missing')
        }
      })

      test('the web client is refused, run-spec or not', () => {
        expect(decide('web', null, { skill })).toBe('conversion_tools_missing')
        expect(decide('web', null, { skill, runSpecVersion: 1 })).toBe(
          'conversion_tools_missing',
        )
      })

      test('a Desktop that does not advertise the tools is refused, whatever its version', () => {
        for (const clientVersion of [
          'desktop/0.0.172',
          'desktop/0.0.190',
          // Cut from main without the tools: the number alone never passes.
          'desktop/0.0.191',
          'desktop/0.1.0',
          'desktop/dev',
          'desktop/nightly',
          null,
        ]) {
          for (const conversionToolsVersion of [undefined, 0, '1', 1.5, true])
            for (const runSpecVersion of [undefined, 1])
              expect(
                decide('desktop', clientVersion, {
                  skill,
                  conversionToolsVersion,
                  runSpecVersion,
                }),
                `${clientVersion} ${String(conversionToolsVersion)}`,
              ).toBe('desktop_too_old')
        }
      })

      test('an unknown client is refused', () => {
        expect(decide(null, null, { skill })).toBe('client_version_unknown')
        expect(decide(null, null, { skill, ...TOOLS, runSpecVersion: 1 })).toBe(
          'client_version_unknown',
        )
      })

      test('a Desktop that advertises the tools runs it, dev included', () => {
        for (const clientVersion of [
          'desktop/0.0.190',
          'desktop/0.0.191',
          'desktop/0.1.0',
          'desktop/dev',
        ]) {
          for (const conversionToolsVersion of [1, 2]) {
            expect(
              decide('desktop', clientVersion, { skill, conversionToolsVersion }),
              clientVersion,
            ).toBeNull()
            expect(
              decide('desktop', clientVersion, {
                skill,
                conversionToolsVersion,
                runSpecVersion: 1,
              }),
              clientVersion,
            ).toBeNull()
          }
          // Format 2 still has its own floor, which these all pass.
          expect(
            decide('desktop', clientVersion, {
              skill: skillWith(conversion, { format: 2 }),
              ...TOOLS,
            }),
            clientVersion,
          ).toBeNull()
        }
      })

      test('the CLI and web are refused even if they send the capability', () => {
        expect(decide('cli', 'cli/0.2.40', { skill, ...TOOLS })).toBe(
          'conversion_tools_missing',
        )
        expect(decide('web', null, { skill, ...TOOLS })).toBe(
          'conversion_tools_missing',
        )
      })

      test('a skill the server could not read is judged by its procedure text', () => {
        const procedure = procedureWith(conversion)
        expect(decide('desktop', 'desktop/0.0.191', { skill: null, procedure })).toBe(
          'desktop_too_old',
        )
        expect(decide('cli', 'cli/0.2.40', { skill: null, procedure })).toBe(
          'conversion_tools_missing',
        )
        expect(
          decide('desktop', 'desktop/0.0.191', { skill: null, procedure, ...TOOLS }),
        ).toBeNull()
        // A run-spec client still needs the skill itself.
        expect(
          decide('desktop', 'desktop/0.0.191', {
            skill: null,
            procedure,
            runSpecVersion: 1,
            ...TOOLS,
          }),
        ).toBe('skill_unresolved')
      })
    })
  }

  test('a malformed or CRLF conversion line still counts', () => {
    expect(
      decide('cli', 'cli/0.2.40', {
        skill: null,
        procedure: 'skill: acme-thing@4.0.0 sha256:x\r\nconversion-definition: {nope',
      }),
    ).toBe('conversion_tools_missing')
  })

  test('skills without a conversion are unaffected', () => {
    const plain = { packages: [{ name: 'acme-sdk' }] }
    expect(decide('cli', 'cli/0.2.29', { skill: plain })).toBeNull()
    expect(decide('cli', 'cli/0.2.20', { skill: plain, runSpecVersion: 1 })).toBeNull()
    expect(decide('web', null, { skill: plain })).toBeNull()
    expect(decide('web', null, { skill: plain, runSpecVersion: 1 })).toBeNull()
    expect(decide('desktop', 'desktop/0.0.172', { skill: plain })).toBeNull()
    expect(
      decide('desktop', 'desktop/0.0.169', { skill: plain, runSpecVersion: 1 }),
    ).toBeNull()
    expect(
      decide('desktop', 'desktop/0.0.172', {
        skill: { ...plain, conversion: undefined },
        procedure: 'skill: acme-thing@4.0.0 sha256:x\n\nGoal: x',
      }),
    ).toBeNull()
    // Free text without a conversion line is never refused here.
    expect(
      decide('cli', 'cli/0.2.20', {
        skillRef: null,
        skill: null,
        procedure: 'Add a search box.',
      }),
    ).toBeNull()
  })

  test('the conversion-only check decides from the procedure text alone', () => {
    const procedure = procedureWith(v1)
    expect(sponsoredConversionClientRefusal({ client: 'cli', procedure })).toBe(
      'conversion_tools_missing',
    )
    expect(sponsoredConversionClientRefusal({ client: 'web', procedure })).toBe(
      'conversion_tools_missing',
    )
    expect(sponsoredConversionClientRefusal({ client: null, procedure })).toBe(
      'client_version_unknown',
    )
    expect(
      sponsoredConversionClientRefusal({ client: 'desktop', procedure }),
    ).toBe('desktop_too_old')
    expect(
      sponsoredConversionClientRefusal({ client: 'desktop', procedure, ...TOOLS }),
    ).toBeNull()
    // Nothing to gate: every client passes, whatever else it lacks.
    for (const client of ['cli', 'web', 'desktop', null] as const)
      expect(
        sponsoredConversionClientRefusal({
          client,
          procedure: 'skill: acme-thing@4.0.0 sha256:x\n\nGoal: x',
          skill: { conversion: undefined },
        }),
      ).toBeNull()
  })

  test('a free-text procedure with a conversion line is gated like a skill', () => {
    const procedure = ['Do the thing.', CONVERSION_DIRECTIVE + JSON.stringify(v2)].join('\n')
    const freeText = { skillRef: null, skill: null, procedure }
    expect(decide('cli', 'cli/0.2.40', freeText)).toBe('conversion_tools_missing')
    expect(decide('web', null, freeText)).toBe('conversion_tools_missing')
    expect(decide('desktop', 'desktop/0.0.191', freeText)).toBe('desktop_too_old')
    expect(decide(null, null, freeText)).toBe('client_version_unknown')
    expect(decide('desktop', 'desktop/0.0.191', { ...freeText, ...TOOLS })).toBeNull()
  })

  test('a real skill: its rendered procedure alone decides, as the skill does', () => {
    const shipped = [...SPONSORED_SKILLS.values()][0]!
    for (const conversion of [v1, v2]) {
      const skill = { ...shipped, conversion } as typeof shipped
      const procedure = renderSponsoredSkillProcedure(skill)
      const skillRef = sponsoredSkillDirective(procedure)
      expect(skillRef).not.toBeNull()
      for (const [client, clientVersion, want, conversionToolsVersion] of [
        ['cli', 'cli/0.2.40', 'conversion_tools_missing', 1],
        ['web', null, 'conversion_tools_missing', 1],
        ['desktop', 'desktop/0.0.191', 'desktop_too_old', undefined],
        ['desktop', 'desktop/0.0.190', null, 1],
      ] as const) {
        expect(
          sponsoredSkillClientRefusal({
            client,
            clientVersion,
            skillRef,
            skill,
            conversionToolsVersion,
          }),
        ).toBe(want)
        expect(
          sponsoredSkillClientRefusal({
            client,
            clientVersion,
            skillRef,
            skill: null,
            procedure,
            conversionToolsVersion,
          }),
        ).toBe(want)
      }
    }
    // The same shipped skill without one renders no conversion line, and
    // the CLI keeps it.
    expect(renderSponsoredSkillProcedure(shipped)).not.toContain(
      CONVERSION_DIRECTIVE,
    )
    for (const runSpecVersion of [undefined, 1])
      expect(
        sponsoredSkillClientRefusal({
          client: 'cli',
          clientVersion: 'cli/0.2.40',
          skillRef: sponsoredSkillDirective(
            renderSponsoredSkillProcedure(shipped),
          ),
          skill: shipped,
          procedure: renderSponsoredSkillProcedure(shipped),
          runSpecVersion,
        }),
      ).toBeNull()
  })
})
