import { describe, expect, test } from 'bun:test'

import {
  ENV_EXAMPLE_FILE_NAMES,
  MCP_CONFIG_FILE_PATHS,
  SPONSORED_DIFF_FILE_TEXT_CAP,
  SPONSORED_OUTCOME_FILES_CAP,
  SPONSORED_RUN_OUTCOMES,
  declaredOutcomes,
  detectOutcomes,
  parseAddedLines,
  sponsoredOutcomeDiffRange,
  sponsoredOutcomeEventId,
  sponsoredOutcomeMetadata,
  verifyOutcomes,
} from './sponsored-run-outcomes'

import type { SponsoredDiffFile } from './sponsored-run-outcomes'

/**
 * The diffs a Supabase procedure leaves behind, as fixtures. Written by hand
 * from what wiring Supabase into a Next app actually adds — COD-446's
 * reviewed procedures are not in the repository yet, so these stand in for
 * the shape of their output rather than quoting them.
 */
const ENV_EXAMPLE: SponsoredDiffFile = {
  path: '.env.example',
  addedText: [
    'NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co',
    'NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key',
  ].join('\n'),
}

const CLIENT_SOURCE: SponsoredDiffFile = {
  path: 'lib/supabase/client.ts',
  addedText: [
    "import { createBrowserClient } from '@supabase/ssr'",
    '',
    'export function createClient() {',
    '  return createBrowserClient(',
    '    process.env.NEXT_PUBLIC_SUPABASE_URL!,',
    '    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,',
    '  )',
    '}',
  ].join('\n'),
}

const MCP_CONFIG: SponsoredDiffFile = {
  path: '.mcp.json',
  addedText: [
    '{',
    '  "mcpServers": {',
    '    "supabase": {',
    '      "command": "npx",',
    '      "args": ["-y", "@supabase/mcp-server-supabase@latest", "--read-only"]',
    '    }',
    '  }',
    '}',
  ].join('\n'),
}

/** A file the run touched that proves nothing on its own. */
const README: SponsoredDiffFile = {
  path: 'README.md',
  addedText: '## Supabase\n\nSet SUPABASE_URL and SUPABASE_ANON_KEY in `.env`.',
}

describe('declaredOutcomes', () => {
  test('reads the directive line out of the procedure text', () => {
    expect(
      declaredOutcomes(
        'Wire Supabase Auth into this app.\n\noutcomes: api_key_issued\n\nDo not install anything.',
      ),
    ).toEqual(['api_key_issued'])
  })

  test('is case-insensitive on the key and tolerant of separators', () => {
    expect(
      declaredOutcomes('Outcomes:  mcp_installed ,api_key_issued'),
    ).toEqual(['api_key_issued', 'mcp_installed'])
    expect(declaredOutcomes('OUTCOMES: mcp_installed api_key_issued')).toEqual([
      'api_key_issued',
      'mcp_installed',
    ])
  })

  test('returns canonical order and dedupes, whatever the procedure wrote', () => {
    expect(
      declaredOutcomes(
        'outcomes: mcp_installed\noutcomes: api_key_issued, mcp_installed',
      ),
    ).toEqual(['api_key_issued', 'mcp_installed'])
  })

  test('declares nothing for a procedure with no directive', () => {
    expect(declaredOutcomes('Install the Acme error handler.')).toEqual([])
    expect(declaredOutcomes('')).toEqual([])
    expect(declaredOutcomes(null)).toEqual([])
    expect(declaredOutcomes(undefined)).toEqual([])
  })

  test('ignores names it does not know rather than failing the procedure', () => {
    expect(
      declaredOutcomes('outcomes: api_key_issued, pr_merged, accepted'),
    ).toEqual(['api_key_issued'])
    expect(declaredOutcomes('outcomes: everything')).toEqual([])
  })

  test('does not read a directive that is not on its own line', () => {
    expect(
      declaredOutcomes('Report outcomes: api_key_issued when done.'),
    ).toEqual([])
  })

  test('an explicit contract field wins over the text', () => {
    expect(
      declaredOutcomes({
        text: 'outcomes: mcp_installed',
        outcomes: ['api_key_issued'],
      }),
    ).toEqual(['api_key_issued'])
    expect(
      declaredOutcomes({ text: 'outcomes: mcp_installed', outcomes: [] }),
    ).toEqual([])
  })

  test('a contract without the field falls back to its text', () => {
    expect(declaredOutcomes({ text: 'outcomes: mcp_installed' })).toEqual([
      'mcp_installed',
    ])
    expect(
      declaredOutcomes({ text: 'outcomes: mcp_installed', outcomes: null }),
    ).toEqual(['mcp_installed'])
  })

  test('never credits a name outside the closed set, even from a contract', () => {
    expect(
      declaredOutcomes({
        text: '',
        outcomes: ['accepted', 'merged', 42] as never,
      }),
    ).toEqual([])
  })
})

describe('verifyOutcomes: declared x present', () => {
  const table: Array<{
    name: string
    declared: string[]
    diff: SponsoredDiffFile[]
    expected: string[]
  }> = [
    {
      name: 'declared + present → emitted (api_key_issued)',
      declared: ['api_key_issued'],
      diff: [ENV_EXAMPLE, CLIENT_SOURCE, README],
      expected: ['api_key_issued'],
    },
    {
      name: 'declared + present → emitted (mcp_installed)',
      declared: ['mcp_installed'],
      diff: [MCP_CONFIG],
      expected: ['mcp_installed'],
    },
    {
      name: 'declared + absent → not emitted',
      declared: ['api_key_issued', 'mcp_installed'],
      diff: [README],
      expected: [],
    },
    {
      name: 'undeclared + present → not emitted',
      declared: [],
      diff: [ENV_EXAMPLE, CLIENT_SOURCE, MCP_CONFIG],
      expected: [],
    },
    {
      name: 'only the declared half of a diff that proves both',
      declared: ['mcp_installed'],
      diff: [ENV_EXAMPLE, CLIENT_SOURCE, MCP_CONFIG],
      expected: ['mcp_installed'],
    },
    {
      name: 'both declared, both present → both, canonical order',
      declared: ['mcp_installed', 'api_key_issued'],
      diff: [MCP_CONFIG, CLIENT_SOURCE, ENV_EXAMPLE],
      expected: ['api_key_issued', 'mcp_installed'],
    },
    {
      name: 'an unknown declared name credits nothing',
      declared: ['pr_merged'],
      diff: [ENV_EXAMPLE, CLIENT_SOURCE, MCP_CONFIG],
      expected: [],
    },
    {
      name: 'an empty diff proves nothing',
      declared: ['api_key_issued', 'mcp_installed'],
      diff: [],
      expected: [],
    },
  ]

  for (const row of table) {
    test(row.name, () => {
      expect(detectOutcomes(row.diff, row.declared)).toEqual(row.expected)
    })
  }

  test('carries the paths that proved each outcome, and only paths', () => {
    expect(
      verifyOutcomes(
        [README, ENV_EXAMPLE, CLIENT_SOURCE, MCP_CONFIG],
        ['api_key_issued', 'mcp_installed'],
      ),
    ).toEqual([
      {
        outcome: 'api_key_issued',
        files: ['.env.example', 'lib/supabase/client.ts'],
      },
      { outcome: 'mcp_installed', files: ['.mcp.json'] },
    ])
  })

  test('caps the evidence list', () => {
    const many = Array.from({ length: 40 }, (_, index) => ({
      path: `src/supabase-${index}.ts`,
      addedText: CLIENT_SOURCE.addedText,
    }))
    const [verified] = verifyOutcomes(
      [ENV_EXAMPLE, ...many],
      ['api_key_issued'],
    )
    expect(verified?.files).toHaveLength(SPONSORED_OUTCOME_FILES_CAP)
  })
})

describe('api_key_issued rule', () => {
  test('needs BOTH the env example and a client initialiser', () => {
    expect(detectOutcomes([ENV_EXAMPLE], ['api_key_issued'])).toEqual([])
    expect(detectOutcomes([CLIENT_SOURCE], ['api_key_issued'])).toEqual([])
  })

  test('accepts every env example basename, in any directory', () => {
    for (const name of ENV_EXAMPLE_FILE_NAMES) {
      expect(
        detectOutcomes(
          [{ ...ENV_EXAMPLE, path: `apps/web/${name}` }, CLIENT_SOURCE],
          ['api_key_issued'],
        ),
      ).toEqual(['api_key_issued'])
    }
  })

  test('does not read `.env` itself as evidence — a run never writes a secret', () => {
    expect(
      detectOutcomes(
        [{ ...ENV_EXAMPLE, path: '.env' }, CLIENT_SOURCE],
        ['api_key_issued'],
      ),
    ).toEqual([])
    expect(
      detectOutcomes(
        [{ ...ENV_EXAMPLE, path: '.env.local' }, CLIENT_SOURCE],
        ['api_key_issued'],
      ),
    ).toEqual([])
  })

  test('the service-role variable name counts as the key half', () => {
    expect(
      detectOutcomes(
        [
          {
            path: '.env.example',
            addedText: 'SUPABASE_URL=\nSUPABASE_SERVICE_ROLE_KEY=',
          },
          {
            path: 'server/supabase.ts',
            addedText:
              "import { createClient } from '@supabase/supabase-js'\nexport const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)",
          },
        ],
        ['api_key_issued'],
      ),
    ).toEqual(['api_key_issued'])
  })

  test('an env example naming only the URL is not wiring', () => {
    expect(
      detectOutcomes(
        [{ path: '.env.example', addedText: 'SUPABASE_URL=' }, CLIENT_SOURCE],
        ['api_key_issued'],
      ),
    ).toEqual([])
  })

  test('a client initialiser without the Supabase import is any SDK', () => {
    expect(
      detectOutcomes(
        [
          ENV_EXAMPLE,
          {
            path: 'lib/db.ts',
            addedText:
              "import { createClient } from 'redis'\ncreateClient({ url: process.env.SUPABASE_URL })",
          },
        ],
        ['api_key_issued'],
      ),
    ).toEqual([])
  })

  test('a Supabase import that never constructs a client is not wiring', () => {
    expect(
      detectOutcomes(
        [
          ENV_EXAMPLE,
          {
            path: 'lib/types.ts',
            addedText:
              "import type { Session } from '@supabase/supabase-js' // SUPABASE_URL",
          },
        ],
        ['api_key_issued'],
      ),
    ).toEqual([])
  })

  test('a client built from a literal, not the variable, is a demo', () => {
    expect(
      detectOutcomes(
        [
          ENV_EXAMPLE,
          {
            path: 'lib/demo.ts',
            addedText:
              "import { createClient } from '@supabase/supabase-js'\ncreateClient('https://x.supabase.co', 'anon')",
          },
        ],
        ['api_key_issued'],
      ),
    ).toEqual([])
  })

  test('an MCP config file never doubles as the source half', () => {
    expect(
      detectOutcomes(
        [
          ENV_EXAMPLE,
          {
            path: '.mcp.json',
            addedText:
              "'@supabase/supabase-js' createClient( SUPABASE_URL SUPABASE_ANON_KEY",
          },
        ],
        ['api_key_issued'],
      ),
    ).toEqual([])
  })
})

describe('mcp_installed rule', () => {
  test('accepts every project MCP config path, at the root or nested', () => {
    for (const path of MCP_CONFIG_FILE_PATHS) {
      expect(
        detectOutcomes([{ ...MCP_CONFIG, path }], ['mcp_installed']),
      ).toEqual(['mcp_installed'])
      expect(
        detectOutcomes(
          [{ ...MCP_CONFIG, path: `packages/app/${path}` }],
          ['mcp_installed'],
        ),
      ).toEqual(['mcp_installed'])
    }
  })

  test('a settings.json outside .claude/ is not an MCP config', () => {
    expect(
      detectOutcomes(
        [{ ...MCP_CONFIG, path: '.vscode/settings.json' }],
        ['mcp_installed'],
      ),
    ).toEqual([])
    expect(
      detectOutcomes(
        [{ ...MCP_CONFIG, path: 'settings.json' }],
        ['mcp_installed'],
      ),
    ).toEqual([])
  })

  test('recognises the hosted endpoint and the community spelling', () => {
    expect(
      detectOutcomes(
        [
          {
            path: '.cursor/mcp.json',
            addedText: '"supabase": { "url": "https://mcp.supabase.com/mcp" }',
          },
        ],
        ['mcp_installed'],
      ),
    ).toEqual(['mcp_installed'])
    expect(
      detectOutcomes(
        [
          {
            path: '.vscode/mcp.json',
            addedText: '"Supabase-MCP": { "command": "supabase-mcp" }',
          },
        ],
        ['mcp_installed'],
      ),
    ).toEqual(['mcp_installed'])
  })

  test('an MCP config edit that adds a different server is not this outcome', () => {
    expect(
      detectOutcomes(
        [
          {
            path: '.mcp.json',
            addedText:
              '"github": { "command": "npx", "args": ["@modelcontextprotocol/server-github"] }',
          },
        ],
        ['mcp_installed'],
      ),
    ).toEqual([])
  })

  test('a Supabase MCP mention outside an MCP config file is prose', () => {
    expect(
      detectOutcomes(
        [
          {
            path: 'docs/setup.md',
            addedText: 'Install @supabase/mcp-server-supabase',
          },
        ],
        ['mcp_installed'],
      ),
    ).toEqual([])
  })
})

describe('parseAddedLines', () => {
  const diff = [
    'diff --git a/.env.example b/.env.example',
    'index 1111111..2222222 100644',
    '--- a/.env.example',
    '+++ b/.env.example',
    '@@ -3,0 +4,2 @@ DATABASE_URL=',
    '+NEXT_PUBLIC_SUPABASE_URL=',
    '+NEXT_PUBLIC_SUPABASE_ANON_KEY=',
    'diff --git a/lib/old.ts b/lib/supabase/client.ts',
    'similarity index 60%',
    'rename from lib/old.ts',
    'rename to lib/supabase/client.ts',
    '--- a/lib/old.ts',
    '+++ b/lib/supabase/client.ts',
    '@@ -1 +1 @@',
    '-export {}',
    "+import { createClient } from '@supabase/supabase-js'",
    '+++not a header: a line that starts with two plus signs',
    'diff --git a/gone.ts b/gone.ts',
    'deleted file mode 100644',
    '--- a/gone.ts',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-goodbye',
    'diff --git a/logo.png b/logo.png',
    'new file mode 100644',
    'Binary files /dev/null and b/logo.png differ',
    '',
  ].join('\n')

  test('collects added lines per file under the NEW path', () => {
    expect(parseAddedLines(diff)).toEqual([
      {
        path: '.env.example',
        addedText: 'NEXT_PUBLIC_SUPABASE_URL=\nNEXT_PUBLIC_SUPABASE_ANON_KEY=',
      },
      {
        path: 'lib/supabase/client.ts',
        addedText:
          "import { createClient } from '@supabase/supabase-js'\n++not a header: a line that starts with two plus signs",
      },
    ])
  })

  test('never includes removed lines or context', () => {
    const text = parseAddedLines(diff)
      .map((file) => file.addedText)
      .join('\n')
    expect(text).not.toContain('export {}')
    expect(text).not.toContain('goodbye')
    expect(text).not.toContain('DATABASE_URL')
  })

  test('an empty diff is an empty list', () => {
    expect(parseAddedLines('')).toEqual([])
    expect(parseAddedLines('\n')).toEqual([])
  })

  test('tolerates CRLF output', () => {
    expect(
      parseAddedLines(
        'diff --git a/x b/x\r\n--- a/x\r\n+++ b/x\r\n@@ -0,0 +1 @@\r\n+hello\r\n',
      ),
    ).toEqual([{ path: 'x', addedText: 'hello' }])
  })

  test('drops added text past the per-file cap instead of growing without bound', () => {
    const huge = `diff --git a/lock b/lock\n--- a/lock\n+++ b/lock\n@@ -0,0 +1 @@\n+${'x'.repeat(SPONSORED_DIFF_FILE_TEXT_CAP + 10)}\n+tail\n`
    const [file] = parseAddedLines(huge)
    expect(file?.addedText).toBe('tail')
  })
})

describe('the wire helpers', () => {
  test('the event id leads with the proposal so a run sorts together', () => {
    expect(sponsoredOutcomeEventId('prop_1', 'api_key_issued')).toBe(
      'prop_1:api_key_issued',
    )
    expect(sponsoredOutcomeEventId('prop_1', 'mcp_installed')).toBe(
      'prop_1:mcp_installed',
    )
  })

  test('metadata names its provenance and carries paths only', () => {
    expect(sponsoredOutcomeMetadata(['.env.example', 'lib/x.ts'])).toEqual({
      verified_by: 'diff',
      files: ['.env.example', 'lib/x.ts'],
    })
    expect(
      sponsoredOutcomeMetadata(Array.from({ length: 50 }, (_, i) => `f${i}`))
        .files,
    ).toHaveLength(SPONSORED_OUTCOME_FILES_CAP)
  })

  test('the diff range is the run and nothing before it', () => {
    expect(sponsoredOutcomeDiffRange('base', 'head')).toBe('base..head')
  })

  test('the closed set is the two stages the funnel declared without a producer', () => {
    expect(SPONSORED_RUN_OUTCOMES).toEqual(['api_key_issued', 'mcp_installed'])
  })
})
