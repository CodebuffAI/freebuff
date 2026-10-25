import { describe, expect, test } from 'bun:test'

import {
  parseSponsoredSkill,
  renderSponsoredSkillProcedure,
  sponsoredSkillSha256,
  sponsoredSkillTrackedLink,
} from './sponsored-skill'
import {
  buildLayer2Skill,
  compileLayer2Skill,
  isLayer2Skill,
  LAYER2_MAX_VERIFY,
  LAYER2_SKILL_CHANGELOG,
  type SponsoredSkillLayer2,
  type SponsoredSkillLayer2Verify,
} from './sponsored-skill-layer2'
import { conversionDefinitionFromProcedure } from './sponsored-conversion'
import { sponsoredConversionClientRefusal } from './sponsored-skill-client-support'
import {
  parseSponsoredProcedureSteps,
  sponsoredStepNeedsUser,
} from './sponsored-procedure-steps'

const SIGNUP =
  'https://app.posthog.com/signup?utm_source=freebuff&utm_medium=cpc&utm_campaign=analytics&bfcid={bfcid}'

const base: SponsoredSkillLayer2 = {
  id: 'posthog-product-analytics',
  advertiser: 'posthog',
  goal: 'Add PostHog capture for 2–4 events that answer one product question.',
  docsUrl: 'https://posthog.com/docs/libraries/js',
  signupUrl: SIGNUP,
  packages: [{ ecosystem: 'npm', name: 'posthog-js', version: '1.438.13' }],
  consent: {
    title: 'Measure one product journey with PostHog',
    summary: 'Adds 2–4 events for one product question. Nothing is deployed.',
  },
}

const VERIFY: SponsoredSkillLayer2Verify[] = [
  {
    label: 'a changed file imports posthog-js',
    pattern: `from ['"]posthog-js['"]|require\\(['"]posthog-js['"]\\)`,
  },
  {
    label: 'a changed file calls posthog.capture',
    pattern: 'posthog\\.capture\\(',
  },
]

describe('buildLayer2Skill', () => {
  test('native HTTP integrations do not require an invented SDK', () => {
    const result = buildLayer2Skill({ ...base, packages: [] }, '1.0.0')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.skill.packages).toEqual([])
    expect(result.skill.format).toBe(1)
    expect(result.skill.fit).toBeUndefined()
    expect(result.skill.requirements.runtimes).toEqual([{ name: 'node' }])
    expect(result.skill.steps[0]!.checks.map((c) => c.kind)).toEqual([
      'no_privileged_secrets',
    ])
  })
  const conversion = {
    id: 'onboarding',
    version: 3,
    goal: 'Verify product onboarding',
    criteria: [
      { id: 'sign-in', claim: 'signed_in', origin: 'https://app.posthog.com' },
      {
        id: 'api-key',
        claim: 'new_api_key',
        origin: 'https://app.posthog.com',
        credentialEnv: 'POSTHOG_PROJECT_TOKEN',
      },
    ],
  }

  test('preserves onboarding evidence through compile/render and gates clients', () => {
    const result = buildLayer2Skill(
      { ...base, envKeys: ['POSTHOG_PROJECT_TOKEN'], conversion },
      '1.0.0',
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const procedure = renderSponsoredSkillProcedure(result.skill)
    expect(conversionDefinitionFromProcedure(procedure)).toEqual(conversion)
    expect(procedure).toContain('report_sponsored_conversion')
    for (const client of ['cli', 'web'] as const) {
      expect(
        sponsoredConversionClientRefusal({ client, skill: result.skill }),
      ).toBe('conversion_tools_missing')
    }
    expect(
      sponsoredConversionClientRefusal({
        client: 'desktop',
        skill: result.skill,
        conversionToolsVersion: 1,
      }),
    ).toBe('desktop_too_old')
    expect(
      sponsoredConversionClientRefusal({
        client: 'desktop',
        skill: result.skill,
        conversionToolsVersion: 2,
      }),
    ).toBeNull()
  })

  test('download measurement names a declared product and changes the skill hash', () => {
    const download = {
      ...conversion,
      criteria: [
        {
          id: 'product-download',
          claim: 'product_download',
          origin: 'https://posthog.com',
          product: 'sdk',
          package: 'posthog-js',
        },
      ],
    }
    const result = buildLayer2Skill({ ...base, conversion: download }, '1.0.0')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.skill.conversion).toEqual(download)
    expect(sponsoredSkillSha256(result.skill)).not.toBe(
      sponsoredSkillSha256(compileLayer2Skill(base, '1.0.0')),
    )
    expect(
      buildLayer2Skill(
        {
          ...base,
          conversion: {
            ...download,
            criteria: [{ ...download.criteria[0], package: 'undeclared' }],
          },
        },
        '1.0.0',
      ).ok,
    ).toBe(false)
  })

  test('refuses missing credential declarations, legacy and custom conversions', () => {
    expect(buildLayer2Skill({ ...base, conversion }, '1.0.0').ok).toBe(false)
    for (const invalid of [
      { ...conversion, version: 2 },
      { ...conversion, goal: 'Verify integration success' },
      {
        ...conversion,
        criteria: [
          { id: 'feedback', claim: 'feedback', origin: 'https://posthog.com' },
        ],
      },
      {
        ...conversion,
        criteria: [
          conversion.criteria[0],
          { ...conversion.criteria[0], instructions: 'Count API use' },
        ],
      },
      {
        ...conversion,
        criteria: [
          ...conversion.criteria,
          {
            id: 'product-download',
            claim: 'product_download',
            origin: 'https://posthog.com',
            product: 'sdk',
            package: 'posthog-js',
          },
        ],
      },
    ])
      expect(
        buildLayer2Skill(
          { ...base, envKeys: ['POSTHOG_PROJECT_TOKEN'], conversion: invalid },
          '1.0.0',
        ).ok,
      ).toBe(false)
  })
  test('an npm skill with no keys compiles to a parsing format-1 skill with no fit', () => {
    const result = buildLayer2Skill(base, '1.0.0')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const { skill } = result
    expect(skill.format).toBe(1)
    expect('fit' in skill).toBe(false)
    expect(skill.preflight).toEqual([])
    expect(skill.requirements).toEqual({
      os: ['darwin', 'linux', 'win32'],
      runtimes: [{ name: 'node' }],
      frameworks: ['nodejs'],
      packageManagers: ['npm', 'pnpm', 'bun'],
    })
    const reparsed = parseSponsoredSkill(compileLayer2Skill(base, '1.0.0'))
    expect(reparsed.ok).toBe(true)
    expect(skill.steps[0]!.instructions).toContain(
      'If the folder has no project yet, scaffold a minimal one first, then integrate.',
    )
    expect(skill.steps.map((step) => step.kind)).toEqual(['agent', 'user'])
    expect(skill.outcomes).toEqual([])
    expect(sponsoredSkillTrackedLink(skill)).toBe(SIGNUP)
    expect(isLayer2Skill(skill)).toBe(true)
  })

  test('env keys become secure credential steps on the signup link', () => {
    const result = buildLayer2Skill(
      { ...base, envKeys: ['POSTHOG_PROJECT_TOKEN'] },
      '1.0.0',
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const user = result.skill.steps[1]!
    expect(user.credential).toEqual({
      env: 'POSTHOG_PROJECT_TOKEN',
      label: 'Posthog project token',
      getUrl: SIGNUP,
    })
    expect(user.checks[0]!.kind).toBe('credential_provided')
    expect(result.skill.outcomes).toEqual(['api_key_issued'])
    const agentChecks = result.skill.steps[0]!.checks.map((check) => check.kind)
    expect(agentChecks).toContain('env_key_declared')
    expect(sponsoredSkillTrackedLink(result.skill)).toBe(SIGNUP)
  })

  test('a pypi skill needs python, has no fit, and gets a manifest check', () => {
    const result = buildLayer2Skill(
      {
        ...base,
        packages: [{ ecosystem: 'pypi', name: 'posthog', version: '3.7.0' }],
      },
      '1.0.0',
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.skill.format).toBe(1)
    expect(result.skill.fit).toBeUndefined()
    expect(result.skill.requirements.runtimes).toEqual([{ name: 'python' }])
    expect(isLayer2Skill(result.skill)).toBe(true)
    const check = result.skill.steps[0]!.checks[0]!
    expect(check.kind).toBe('file_contains')
  })

  test('a mixed skill has no package checks, so neither project fails one', () => {
    const result = buildLayer2Skill(
      {
        ...base,
        packages: [
          { ecosystem: 'npm', name: 'posthog-node', version: '4.2.1' },
          { ecosystem: 'pypi', name: 'posthog', version: '3.7.0' },
        ],
      },
      '1.0.0',
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const kinds = result.skill.steps[0]!.checks.map((check) => check.kind)
    expect(kinds).toEqual(['no_privileged_secrets'])
  })

  test('the rendered steps read as agent then user work', () => {
    const result = buildLayer2Skill(base, '1.0.0')
    if (!result.ok) throw new Error('expected ok')
    const steps = parseSponsoredProcedureSteps(
      renderSponsoredSkillProcedure(result.skill),
    )
    expect(steps.map((step) => step.needsUser)).toEqual([false, true])
  })

  test('a signup link without bfcid is refused', () => {
    const result = buildLayer2Skill(
      { ...base, signupUrl: 'https://app.posthog.com/signup' },
      '1.0.0',
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors[0]!.path).toBe('signupUrl')
  })

  test('a platform or non-secret env key is refused', () => {
    for (const key of ['OPENAI_API_KEY', 'POSTHOG_HOST']) {
      const result = buildLayer2Skill({ ...base, envKeys: [key] }, '1.0.0')
      expect(result.ok).toBe(false)
    }
  })

  test('a range version is refused', () => {
    const result = buildLayer2Skill(
      {
        ...base,
        packages: [{ ecosystem: 'npm', name: 'posthog-js', version: '^1.0.0' }],
      },
      '1.0.0',
    )
    expect(result.ok).toBe(false)
  })

  test('a goal that reads as user work fails the step parser', () => {
    const result = buildLayer2Skill(
      { ...base, goal: 'Ask the user to sign up for PostHog and add events.' },
      '1.0.0',
    )
    expect(result.ok).toBe(false)
  })

  test('unknown fields are refused', () => {
    const result = buildLayer2Skill({ ...base, checks: [] }, '1.0.0')
    expect(result.ok).toBe(false)
  })
})

describe('verify', () => {
  test('each item becomes a case-insensitive source check, before the auto checks', () => {
    const result = buildLayer2Skill(
      { ...base, envKeys: ['POSTHOG_PROJECT_TOKEN'], verify: VERIFY },
      '1.0.0',
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const checks = result.skill.steps[0]!.checks
    expect(checks.map((check) => check.id)).toEqual([
      'verify-1',
      'verify-2',
      'package-1',
      'env-1',
      'no-secrets',
    ])
    expect(checks[0]).toEqual({
      id: 'verify-1',
      kind: 'file_contains',
      label: 'a changed file imports posthog-js',
      path: '**/*.{ts,tsx,js,jsx,mjs,cjs,mts,cts,py}',
      pattern: VERIFY[0]!.pattern,
      flags: 'i',
    })
  })

  test('omitted and empty compile to the same skill and hash', () => {
    const omitted = compileLayer2Skill(base, '1.0.0')
    const empty = compileLayer2Skill({ ...base, verify: [] }, '1.0.0')
    expect(empty).toEqual(omitted)
    expect(sponsoredSkillSha256(empty)).toBe(sponsoredSkillSha256(omitted))
    expect(JSON.stringify(omitted)).not.toContain('verify')
  })

  test('verify moves the hash', () => {
    expect(
      sponsoredSkillSha256(
        compileLayer2Skill({ ...base, verify: VERIFY }, '1.0.0'),
      ),
    ).not.toBe(sponsoredSkillSha256(compileLayer2Skill(base, '1.0.0')))
  })

  test('a pattern that is not a regex is refused', () => {
    const result = buildLayer2Skill(
      { ...base, verify: [{ label: 'broken', pattern: 'posthog(' }] },
      '1.0.0',
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors[0]!.path).toBe('verify.0.pattern')
  })

  test(`more than ${LAYER2_MAX_VERIFY}, an empty label, a long pattern or an extra field is refused`, () => {
    const item = VERIFY[1]!
    for (const verify of [
      Array.from({ length: LAYER2_MAX_VERIFY + 1 }, () => item),
      [{ ...item, label: ' ' }],
      [{ ...item, label: 'x'.repeat(101) }],
      [{ ...item, pattern: 'a'.repeat(201) }],
      [{ ...item, flags: 'i' }],
    ]) {
      expect(buildLayer2Skill({ ...base, verify }, '1.0.0').ok).toBe(false)
    }
  })
})

describe('the agent step', () => {
  test('reads as guidance, and never as user work', () => {
    const skill = compileLayer2Skill(
      { ...base, envKeys: ['POSTHOG_PROJECT_TOKEN'], verify: VERIFY },
      '1.0.0',
    )
    const integrate = skill.steps[0]!
    expect(integrate.title).toBe(
      'Build the Posthog integration in this project',
    )
    expect(integrate.instructions).toBe(
      `${base.goal}\nGuidelines:\n- Read the docs before writing code: ${base.docsUrl}\n- If the folder has no project yet, scaffold a minimal one first, then integrate.\n- Start from the listed packages and add others only when the integration needs them; fit this project's framework and conventions, and change as little as possible.\n- Read POSTHOG_PROJECT_TOKEN from the environment only, and declare it with an empty value in the example env file.\nHow you do it is up to you; the step is done when its checks pass.`,
    )
    expect(
      sponsoredStepNeedsUser(`${integrate.title} ${integrate.instructions}`),
    ).toBe(false)
  })

  test('with no keys there is no env line', () => {
    const integrate = compileLayer2Skill(base, '1.0.0').steps[0]!
    expect(integrate.instructions).not.toContain('environment')
    expect(integrate.instructions).toEndWith(
      'change as little as possible.\nHow you do it is up to you; the step is done when its checks pass.',
    )
  })

  test('two keys share one line', () => {
    const integrate = compileLayer2Skill(
      {
        ...base,
        envKeys: ['POSTHOG_PROJECT_TOKEN', 'POSTHOG_PERSONAL_API_KEY'],
      },
      '1.0.0',
    ).steps[0]!
    expect(integrate.instructions).toContain(
      '- Read POSTHOG_PROJECT_TOKEN and POSTHOG_PERSONAL_API_KEY from the environment only, and declare each',
    )
  })

  test('the rendered steps with keys and verify still read as agent then user work', () => {
    const result = buildLayer2Skill(
      { ...base, envKeys: ['POSTHOG_PROJECT_TOKEN'], verify: VERIFY },
      '1.0.0',
    )
    if (!result.ok) throw new Error(JSON.stringify(result.errors))
    const steps = parseSponsoredProcedureSteps(
      renderSponsoredSkillProcedure(result.skill),
    )
    expect(steps.map((step) => step.needsUser)).toEqual([false, true])
  })
})

describe('compileLayer2Skill', () => {
  test('is deterministic: same source and version, same hash', () => {
    const a = sponsoredSkillSha256(compileLayer2Skill(base, '1.0.0'))
    const b = sponsoredSkillSha256(
      compileLayer2Skill(structuredClone(base), '1.0.0'),
    )
    expect(a).toBe(b)
  })

  test('the hash moves with the version and with any field', () => {
    const a = sponsoredSkillSha256(compileLayer2Skill(base, '1.0.0'))
    expect(sponsoredSkillSha256(compileLayer2Skill(base, '1.0.1'))).not.toBe(a)
    expect(
      sponsoredSkillSha256(
        compileLayer2Skill(
          { ...base, docsUrl: 'https://posthog.com/docs' },
          '1.0.0',
        ),
      ),
    ).not.toBe(a)
  })

  test('emits nothing optional as empty or null', () => {
    const skill = compileLayer2Skill(base, '1.0.0')
    expect(JSON.stringify(skill)).not.toContain('null')
    expect('desktop' in skill).toBe(false)
    expect('conversion' in skill).toBe(false)
    expect(skill.changelog).toBe(LAYER2_SKILL_CHANGELOG)
  })

  test('renders far under the old long-form skills', () => {
    const rendered = renderSponsoredSkillProcedure(
      compileLayer2Skill(
        {
          ...base,
          envKeys: ['POSTHOG_PROJECT_TOKEN'],
          verify: [
            ...VERIFY,
            {
              label: 'a changed file calls posthog.init',
              pattern: 'posthog\\.init\\(',
            },
          ],
        },
        '1.0.0',
      ),
    )
    expect(rendered.length).toBeLessThan(2_500)
  })
})
