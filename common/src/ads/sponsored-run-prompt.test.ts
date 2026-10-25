import { createHash } from 'node:crypto'

import { describe, expect, test } from 'bun:test'

import { labSponsoredPrompt } from './agentic-ad-lab-run'
import { agenticOfferRequestSchema } from './agentic-offer'
import {
  SPONSORED_RUN_CLI_GUIDANCE,
  SPONSORED_RUN_CONTEXT_HEADING,
  SPONSORED_RUN_DEFERRED_SIGNUP_CREDENTIALS,
  SPONSORED_RUN_DEFERRED_SIGNUP_LINK,
  SPONSORED_RUN_DESKTOP_IN_PLACE_GUIDANCE,
  SPONSORED_RUN_DESKTOP_WORKTREE_GUIDANCE,
  SPONSORED_RUN_INSTALL_TOOL_LINE,
  SPONSORED_RUN_LAYER1_FRAME,
  SPONSORED_RUN_LAYER1_REPORT,
  SPONSORED_RUN_RESULT_REPORT,
  SPONSORED_RUN_SCOPE_GUIDANCE,
  SPONSORED_RUN_TASK_FRAMING,
  SPONSORED_RUN_WEB_GUIDANCE,
  buildSponsoredRunLayer1PromptTemplate,
  buildSponsoredRunPromptTemplate,
  buildSponsoredRunSpec,
  renderSponsoredRunTaskContext,
  sponsoredRunDeferredSignup,
} from './sponsored-run-prompt'
import {
  SPONSORED_RUN_SPEC_SLOTS,
  fillSponsoredRunSpecPrompt,
} from './sponsored-run-spec'
import { renderSponsoredSkillProcedure } from './sponsored-skill'
import { buildLayer2Skill } from './sponsored-skill-layer2'
import { resolveSponsoredSkill } from './sponsored-skills/registry'

const PROCEDURE = 'Add the Example SDK.\n1. Install it.\n2. Wire it up.'
const MESSAGES = ['hey', 'my app is Next.js']
const CONTEXT = renderSponsoredRunTaskContext(MESSAGES)
const LINK =
  'https://example.com/start?bfcid=bfc1.eyJ2IjoxfQ.c2lnbmF0dXJlc2lnbmF0dXJlc2ln'

const fill = (template: string, credentials = '') =>
  fillSponsoredRunSpecPrompt(template, { taskContext: CONTEXT, credentials })

/** The prompt each surface runs, section by section, in Desktop's order. */
function expected(guidance: string, deferred?: string, credentials?: string) {
  return [
    SPONSORED_RUN_TASK_FRAMING,
    `The approved procedure:\n${PROCEDURE}`,
    `${SPONSORED_RUN_CONTEXT_HEADING}\nUser message 1:\nhey\n\nUser message 2:\nmy app is Next.js`,
    `How to carry it out here:\n${guidance}\n${SPONSORED_RUN_SCOPE_GUIDANCE}`,
    ...(deferred ? [deferred] : []),
    ...(credentials ? [credentials] : []),
    SPONSORED_RUN_RESULT_REPORT,
  ].join('\n\n')
}

describe('buildSponsoredRunPromptTemplate', () => {
  test('desktop in place: Desktop’s in-place prompt', () => {
    const template = buildSponsoredRunPromptTemplate({
      surface: 'desktop',
      inPlace: true,
      procedure: PROCEDURE,
      advertiserLink: null,
      deferredSignup: 'link',
    })
    expect(fill(template)).toBe(
      expected(
        SPONSORED_RUN_DESKTOP_IN_PLACE_GUIDANCE,
        SPONSORED_RUN_DEFERRED_SIGNUP_LINK,
      ),
    )
    expect(fill(template)).toStartWith(
      'The user accepted this sponsored task from its offer card.',
    )
    expect(fill(template)).not.toContain('consent dialog')
    expect(SPONSORED_RUN_DESKTOP_IN_PLACE_GUIDANCE).toContain(
      'You are editing the user’s REAL working copy',
    )
  })

  test('desktop worktree: commit, never push', () => {
    const template = buildSponsoredRunPromptTemplate({
      surface: 'desktop',
      inPlace: false,
      procedure: PROCEDURE,
      advertiserLink: null,
    })
    expect(fill(template)).toBe(
      expected(SPONSORED_RUN_DESKTOP_WORKTREE_GUIDANCE),
    )
    expect(fill(template)).toContain('Commit with `--no-verify`.')
    expect(fill(template)).not.toContain('UNCOMMITTED')
  })

  test('cli: in place whatever is asked, with the no-questions line', () => {
    for (const inPlace of [true, false]) {
      const template = buildSponsoredRunPromptTemplate({
        surface: 'cli',
        inPlace,
        procedure: PROCEDURE,
        advertiserLink: null,
        deferredSignup: 'credentials',
      })
      expect(fill(template)).toBe(
        expected(
          SPONSORED_RUN_CLI_GUIDANCE,
          SPONSORED_RUN_DEFERRED_SIGNUP_CREDENTIALS,
        ),
      )
    }
    expect(SPONSORED_RUN_CLI_GUIDANCE).toContain(
      '- There is nobody to answer questions during this run.',
    )
  })

  test('web: byte for byte the Cloud prompt it replaces', () => {
    for (const deferredSignup of [undefined, 'link', 'credentials'] as const) {
      const template = buildSponsoredRunPromptTemplate({
        surface: 'web',
        inPlace: true,
        procedure: PROCEDURE,
        advertiserLink: LINK,
        ...(deferredSignup ? { deferredSignup } : {}),
      })
      expect(fill(template)).toBe(
        labSponsoredPrompt(PROCEDURE, MESSAGES, {
          runtimeInputs: { advertiserLink: LINK },
          ...(deferredSignup ? { deferredSignup } : {}),
        }),
      )
    }
    expect(SPONSORED_RUN_WEB_GUIDANCE).toContain('in a Linux cloud VM')
  })

  test('the advertiser link fills a procedure that declares it', () => {
    const procedure = 'Write {{advertiserLink}} into .env.example.'
    const template = buildSponsoredRunPromptTemplate({
      surface: 'desktop',
      inPlace: true,
      procedure,
      advertiserLink: LINK,
    })
    expect(template).toContain(`- advertiserLink: ${LINK}`)
  })

  test('each slot appears once, after the procedure', () => {
    const template = buildSponsoredRunPromptTemplate({
      surface: 'desktop',
      inPlace: true,
      procedure: PROCEDURE,
      advertiserLink: null,
    })
    for (const slot of Object.values(SPONSORED_RUN_SPEC_SLOTS)) {
      expect(template.split(slot)).toHaveLength(2)
      expect(template.indexOf(slot)).toBeGreaterThan(
        template.indexOf(PROCEDURE),
      )
    }
  })
})

describe('fillSponsoredRunSpecPrompt', () => {
  const template = buildSponsoredRunPromptTemplate({
    surface: 'desktop',
    inPlace: true,
    procedure: PROCEDURE,
    advertiserLink: null,
  })

  test('a credentials section is its own paragraph before the report', () => {
    expect(fill(template, 'Credentials:\n- X is set.')).toBe(
      expected(
        SPONSORED_RUN_DESKTOP_IN_PLACE_GUIDANCE,
        undefined,
        'Credentials:\n- X is set.',
      ),
    )
  })

  test('no messages leaves the heading, as Desktop renders none', () => {
    expect(
      fillSponsoredRunSpecPrompt(template, {
        taskContext: '',
        credentials: '',
      }),
    ).toContain(
      `${SPONSORED_RUN_CONTEXT_HEADING}\n\n\nHow to carry it out here:`,
    )
  })

  test('slot text in a section or the procedure is never filled', () => {
    const tricky = buildSponsoredRunPromptTemplate({
      surface: 'desktop',
      inPlace: true,
      procedure: `Mention ${SPONSORED_RUN_SPEC_SLOTS.credentials} literally.`,
      advertiserLink: null,
    })
    const filled = fillSponsoredRunSpecPrompt(tricky, {
      taskContext: `User message 1:\n${SPONSORED_RUN_SPEC_SLOTS.credentials}`,
      credentials: 'Credentials:\n- set',
    })
    expect(filled).toContain(
      `Mention ${SPONSORED_RUN_SPEC_SLOTS.credentials} literally.`,
    )
    expect(filled).toContain(
      `User message 1:\n${SPONSORED_RUN_SPEC_SLOTS.credentials}\n\nHow to`,
    )
    expect(filled).toContain(
      `Credentials:\n- set\n\n${SPONSORED_RUN_RESULT_REPORT}`,
    )
  })
})

describe('sponsoredRunDeferredSignup', () => {
  const credentialProcedure = `${PROCEDURE}\nrequires-credential: env=EXAMPLE_API_KEY label="Example API key"`

  test('declared credentials and no link ask for the keys', () => {
    for (const surface of ['desktop', 'cli', 'web'] as const)
      expect(
        sponsoredRunDeferredSignup({
          surface,
          procedure: credentialProcedure,
          advertiserLink: null,
          skill: null,
        }),
      ).toBe('credentials')
  })

  test('a procedure that needs an account opens the tracked link', () => {
    for (const surface of ['desktop', 'cli', 'web'] as const)
      expect(
        sponsoredRunDeferredSignup({
          surface,
          procedure: credentialProcedure,
          advertiserLink: LINK,
          skill: null,
        }),
      ).toBe('link')
  })

  test('only the Cloud opens the link for a procedure that needs no account', () => {
    const input = { procedure: PROCEDURE, advertiserLink: LINK, skill: null }
    expect(sponsoredRunDeferredSignup({ ...input, surface: 'web' })).toBe(
      'link',
    )
    expect(
      sponsoredRunDeferredSignup({ ...input, surface: 'desktop' }),
    ).toBeUndefined()
  })
})

describe('buildSponsoredRunSpec', () => {
  const skill = resolveSponsoredSkill('exa-web-search-feature@2.0.0')!
  const procedure = renderSponsoredSkillProcedure(skill)

  test('a skill: its packages are the declared installs', () => {
    const spec = buildSponsoredRunSpec({
      procedure,
      skill,
      surface: 'cli',
      inPlace: true,
      advertiserLink: null,
    })
    expect(spec.v).toBe(1)
    expect(spec.procedure).toBe(procedure)
    expect(spec.procedureSha256).toBe(
      createHash('sha256').update(procedure, 'utf8').digest('hex'),
    )
    expect(spec.skill).toBe(skill)
    expect(skill.packages.length).toBeGreaterThan(0)
    expect(spec.declaredPackages).toEqual(skill.packages)
    expect(spec.promptTemplate).toContain(SPONSORED_RUN_CLI_GUIDANCE)
  })

  test('free text: no skill and no installs', () => {
    const spec = buildSponsoredRunSpec({
      procedure: PROCEDURE,
      skill: null,
      surface: 'desktop',
      inPlace: true,
      advertiserLink: null,
    })
    expect(spec.skill).toBeNull()
    expect(spec.declaredPackages).toEqual([])
    expect(spec.promptTemplate).toBe(
      buildSponsoredRunPromptTemplate({
        surface: 'desktop',
        inPlace: true,
        procedure: PROCEDURE,
        advertiserLink: null,
      }),
    )
  })
})

describe('Layer 1 frame for a Layer 2 skill', () => {
  const built = buildLayer2Skill(
    {
      id: 'example-search',
      advertiser: 'example',
      goal: 'Add Example search to one existing search box in this app.',
      docsUrl: 'https://docs.example.com',
      signupUrl: 'https://example.com/signup?utm_source=freebuff&bfcid={bfcid}',
      packages: [{ ecosystem: 'npm', name: 'example-sdk', version: '1.2.3' }],
      envKeys: ['EXAMPLE_API_KEY'],
      consent: { title: 'Add Example search', summary: 'Adds Example search.' },
    },
    '1.0.0',
  )
  if (!built.ok) throw new Error(JSON.stringify(built.errors))
  const skill = built.skill
  const procedure = renderSponsoredSkillProcedure(skill)
  const spec = (surface: 'desktop' | 'cli' | 'web') =>
    buildSponsoredRunSpec({
      procedure,
      skill,
      surface,
      inPlace: true,
      advertiserLink: null,
    })

  test('gets the short frame, the procedure, both slots and the report', () => {
    const template = spec('desktop').promptTemplate
    expect(template).toBe(
      buildSponsoredRunLayer1PromptTemplate({
        surface: 'desktop',
        procedure,
        advertiserLink: null,
      }),
    )
    expect(template.startsWith(SPONSORED_RUN_LAYER1_FRAME)).toBe(true)
    expect(template).toContain(`The approved procedure:\n${procedure}`)
    expect(template).toContain(SPONSORED_RUN_SPEC_SLOTS.taskContext)
    expect(template).toContain(SPONSORED_RUN_SPEC_SLOTS.credentials)
    expect(template.endsWith(SPONSORED_RUN_LAYER1_REPORT)).toBe(true)
    expect(template).toContain('call report_sponsored_run_summary if available')
    expect(template).not.toContain(SPONSORED_RUN_SCOPE_GUIDANCE)
  })

  test('opens with the sentence the prompt classifier keys on', () => {
    expect(
      SPONSORED_RUN_LAYER1_FRAME.startsWith(
        'The user accepted this sponsored task from its offer card.',
      ),
    ).toBe(true)
  })

  test('only Cloud adds the lockfile restore line', () => {
    expect(spec('web').promptTemplate).toContain('npm ci')
    expect(spec('desktop').promptTemplate).not.toContain('npm ci')
    expect(spec('cli').promptTemplate).not.toContain('npm ci')
  })

  test('the frame is a fraction of the long one', () => {
    const short = fill(spec('desktop').promptTemplate)
    const long = fill(
      buildSponsoredRunPromptTemplate({
        surface: 'desktop',
        inPlace: true,
        procedure,
        advertiserLink: null,
      }),
    )
    expect(short.length).toBeLessThan(long.length / 2)
  })

  test('installTool adds the install_package line to the frame', () => {
    const template = buildSponsoredRunSpec({
      procedure,
      skill,
      surface: 'desktop',
      inPlace: true,
      advertiserLink: null,
      installTool: true,
    }).promptTemplate
    expect(
      template.startsWith(
        `${SPONSORED_RUN_LAYER1_FRAME}\n${SPONSORED_RUN_INSTALL_TOOL_LINE}`,
      ),
    ).toBe(true)
    expect(spec('desktop').promptTemplate).not.toContain('install_package')
  })

  test('a registered skill keeps its long frame', () => {
    const registered = resolveSponsoredSkill('exa-web-search-feature@2.0.0')!
    const template = buildSponsoredRunSpec({
      procedure: renderSponsoredSkillProcedure(registered),
      skill: registered,
      surface: 'desktop',
      inPlace: true,
      advertiserLink: null,
    }).promptTemplate
    expect(template.startsWith(SPONSORED_RUN_TASK_FRAMING)).toBe(true)
  })
})

describe('runSpecVersion on the offer request', () => {
  const request = {
    v: 1,
    conversationId: 'thread-1',
    messages: [],
  }

  test('1 is accepted, absent is the legacy path, anything else is invalid', () => {
    expect(
      agenticOfferRequestSchema.parse({ ...request, runSpecVersion: 1 })
        .runSpecVersion,
    ).toBe(1)
    expect(
      agenticOfferRequestSchema.parse(request).runSpecVersion,
    ).toBeUndefined()
    expect(
      agenticOfferRequestSchema.safeParse({ ...request, runSpecVersion: 2 })
        .success,
    ).toBe(false)
  })
})

describe('installTool (COD-965)', () => {
  const skill = resolveSponsoredSkill('exa-web-search-feature@2.0.0')!
  const procedure = renderSponsoredSkillProcedure(skill)
  const build = (
    surface: 'desktop' | 'cli' | 'web',
    inPlace: boolean,
    installTool?: boolean,
  ) =>
    buildSponsoredRunSpec({
      procedure,
      skill,
      surface,
      inPlace,
      advertiserLink: null,
      ...(installTool === undefined ? {} : { installTool }),
    }).promptTemplate

  test('absent or false is byte-identical to before', () => {
    for (const [surface, inPlace] of [
      ['desktop', true],
      ['desktop', false],
      ['cli', true],
      ['web', true],
    ] as const) {
      expect(build(surface, inPlace, false)).toBe(build(surface, inPlace))
      expect(build(surface, inPlace)).not.toContain('install_package')
    }
  })

  test('replaces the pinned-installs bullet on every surface', () => {
    for (const [surface, inPlace] of [
      ['desktop', true],
      ['desktop', false],
      ['cli', true],
      ['web', true],
    ] as const) {
      const template = build(surface, inPlace, true)
      expect(template).toContain(`- ${SPONSORED_RUN_INSTALL_TOOL_LINE}`)
      expect(template).not.toContain('Install only what the procedure pins')
      expect(template).toBe(
        build(surface, inPlace).replace(
          /- Install only what the procedure pins[^\n]*/,
          `- ${SPONSORED_RUN_INSTALL_TOOL_LINE}`,
        ),
      )
    }
  })
})
