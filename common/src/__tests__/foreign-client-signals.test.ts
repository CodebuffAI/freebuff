import { describe, expect, test } from 'bun:test'
import z from 'zod/v4'

import {
  CLAUDE_CODE_TOOLS,
  PROXY_HOLLOW_END_TURN,
  stubTool,
  wireTool,
  wireTools,
} from './foreign-client-wire-tools'
import {
  canonicalToolParameterKeys,
  detectForeignFreebuffClient,
  ENFORCED_SIGNALS,
  findForeignHarnessPromptMarker,
  FOREIGN_HARNESS_TOOL_NAMES,
  FREEBUFF_CUSTOM_TOOL_NAMES,
  FREEBUFF_DOWNGRADE_MODEL_ID,
  FREEBUFF_SIGNATURE_TOOL_NAMES,
  GENERIC_TOOL_NAMES,
  isGenuineSignatureTool,
  listUnrecognisedToolNames,
  resolveForeignClientDowngrade,
} from '../constants/foreign-client-signals'
import { toolNames } from '../tools/constants'
import { toolParams } from '../tools/list'
import { readFilesDisplayVariants } from '../tools/params/tool/read-files'

/** Wire-shaped tools: our names carry our schema, everything else a generic
 *  one. See foreign-client-wire-tools.ts. */
const tools = wireTools

/** Toolsets observed on real freebuff traffic over 24h of DeepSeek V4 Flash. */
const FREEBUFF_TOOLSETS = [
  // CLI / desktop root agent
  tools(
    'ask_user',
    'basher',
    'browser_use',
    'code_reviewer_deepseek_flash',
    'code_searcher',
    'context_pruner',
    'file_picker',
    'glob',
    'gravity_index',
    'list_directory',
    'read_files',
    'read_subtree',
  ),
  // desktop thread agent
  tools(
    'basher',
    'browser_check',
    'code_reviewer_deepseek_flash',
    'code_searcher',
    'context_pruner',
    'end_turn',
    'file_picker',
    'glob',
    'list_directory',
    'preview_click',
    'preview_evaluate',
  ),
  // chat surface
  tools(
    'context_pruner',
    'gravity_index',
    'render_ui',
    'researcher_web',
    'spawn_agents',
    'suggest_followups',
    'thinker_gemini',
  ),
  // helper agent
  tools('add_message', 'read_files', 'run_terminal_command', 'set_output'),
]

/** Toolsets observed proxying our free endpoint, by harness. */
const FOREIGN_TOOLSETS: Array<[string, ReturnType<typeof tools>]> = [
  ['claude-code', tools('Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write')],
  [
    'opencode',
    tools(
      'ask',
      'bash',
      'edit',
      'eval',
      'glob',
      'grep',
      'hub',
      'read',
      'task',
      'todo',
      'web_search',
      'write',
    ),
  ],
  [
    'cline',
    tools(
      'list_files',
      'read_file',
      'replace_in_file',
      'search_files',
      'write_file',
    ),
  ],
  [
    'novel-farm',
    tools(
      'check_consistency',
      'commit_chapter',
      'draft_chapter',
      'edit_chapter',
      'novel_context',
      'plan_chapter',
      'read_chapter',
    ),
  ],
  [
    'pentest-harness',
    tools(
      'analyze_target_graph',
      'delegate_task',
      'edit_source_code',
      'execute_command',
      'install_tool',
      'python_execute',
      'read_file',
    ),
  ],
]

describe('detectForeignFreebuffClient', () => {
  test('the signature is every non-generic tool we define', () => {
    // Derived, not hand-listed: a tool added to `toolNames` joins the signature
    // automatically. That is the rot that flagged researcher-web — a
    // hand-picked list simply never grew to cover it.
    const known = new Set<string>(toolNames)
    for (const name of known) {
      expect(FREEBUFF_SIGNATURE_TOOL_NAMES.has(name)).toBe(
        !GENERIC_TOOL_NAMES.has(name),
      )
    }
    // Every generic name must be one we actually define, or it is dead weight.
    for (const name of GENERIC_TOOL_NAMES) {
      expect(known.has(name)).toBe(true)
    }
    expect(FREEBUFF_SIGNATURE_TOOL_NAMES.size).toBeGreaterThan(20)
  })

  test('clears real freebuff toolsets', () => {
    for (const toolset of FREEBUFF_TOOLSETS) {
      expect(detectForeignFreebuffClient({ tools: toolset }).signal).toBeNull()
    }
  })

  test.each(FOREIGN_TOOLSETS)('flags %s', (_name, toolset) => {
    // Which enforced signal fires depends on whether the harness's own names
    // are on the harness list (Claude Code, OpenClaw's `delegate_task`) or it
    // is caught by having no genuine tool of ours; both downgrade.
    const { signal } = detectForeignFreebuffClient({ tools: toolset })
    expect(signal).not.toBeNull()
    expect(ENFORCED_SIGNALS.has(signal!)).toBe(true)
  })

  test('sharing a few generic names does not launder a foreign harness', () => {
    // opencode sends `glob` and `web_search`, which we define — but both are
    // generic, so neither is in the signature and the overlap buys it nothing.
    expect(
      detectForeignFreebuffClient({
        tools: tools('glob', 'web_search', 'bash', 'edit', 'write'),
      }).signal,
    ).toBe('foreign_toolset')
  })

  test('a toolset of only generic names is foreign', () => {
    // Measured over 30 days: 406 users on spoofed `base2-free-*` agent ids send
    // a bare `web_search` and nothing else. No agent we ship has a toolset of
    // only generic names — every single-tool agent of ours uses a distinctive
    // one (`run_terminal_command`, `spawn_agents`, `read_docs`, `set_output`).
    expect(
      detectForeignFreebuffClient({ tools: tools('web_search') }).signal,
    ).toBe('foreign_toolset')
    expect(
      detectForeignFreebuffClient({ tools: tools('glob', 'web_search') })
        .signal,
    ).toBe('foreign_toolset')
  })

  test('our toolset wins over sampling params', () => {
    // 16 users in one day sent our tools AND set params. Downgrading them is
    // the false positive this ordering exists to prevent.
    expect(
      detectForeignFreebuffClient({
        tools: tools('ask_user', 'read_files'),
        temperature: 0.3,
        max_tokens: 32000,
      }).signal,
    ).toBeNull()
  })

  test('flags sampling params only when no tools are offered', () => {
    expect(detectForeignFreebuffClient({ temperature: 0.7 }).signal).toBe(
      'sampling_params',
    )
    expect(detectForeignFreebuffClient({ top_p: 0.9 }).signal).toBe(
      'sampling_params',
    )
    expect(detectForeignFreebuffClient({ max_tokens: 4096 }).signal).toBe(
      'sampling_params',
    )
    expect(
      detectForeignFreebuffClient({ max_completion_tokens: 4096 }).signal,
    ).toBe('sampling_params')
  })

  test('clears a tool-free request that leaves sampling params unset', () => {
    // Our helper agents (chat titles, compaction) send no tools at all.
    expect(detectForeignFreebuffClient({}).signal).toBeNull()
    expect(detectForeignFreebuffClient({ tools: [] }).signal).toBeNull()
  })

  test('explicit nulls are not treated as set', () => {
    // Regression: this test used to pass `undefined` while claiming to cover
    // `null`, so it passed against a detector that flagged every explicit
    // null. A client that serializes its whole body sends `temperature: null`
    // rather than omitting the key, and that is unset.
    for (const body of [
      { temperature: null },
      { top_p: null },
      { max_tokens: null },
      { max_completion_tokens: null },
      { temperature: null, top_p: null, max_tokens: null },
    ]) {
      expect(detectForeignFreebuffClient(body as never).signal).toBeNull()
    }
    expect(
      detectForeignFreebuffClient({
        temperature: undefined,
        top_p: undefined,
        max_tokens: undefined,
      }).signal,
    ).toBeNull()
  })

  test('zero is a real choice and stays flagged', () => {
    // `!= null` must not swallow falsy-but-set values.
    expect(detectForeignFreebuffClient({ temperature: 0 }).signal).toBe(
      'sampling_params',
    )
    expect(detectForeignFreebuffClient({ top_p: 0 }).signal).toBe(
      'sampling_params',
    )
  })

  test('tolerates malformed tool entries without throwing', () => {
    for (const tools of [
      null,
      undefined,
      'nope',
      [],
      [null],
      [{}],
      [{ function: {} }],
    ]) {
      expect(() =>
        detectForeignFreebuffClient({ tools } as never),
      ).not.toThrow()
    }
    // Tools present but unparseable read as "no tools offered", so the request
    // falls through to the param check rather than being flagged on a name
    // list we could not actually read.
    expect(detectForeignFreebuffClient({ tools: [{}] }).signal).toBeNull()
  })

  test('truncates caller-controlled tool names before they reach logs', () => {
    const verdict = detectForeignFreebuffClient({
      tools: [{ type: 'function', function: { name: 'x'.repeat(5000) } }],
    })
    expect(verdict.signal).toBe('foreign_toolset')
    expect(verdict.sampleToolNames[0]!.length).toBeLessThanOrEqual(64)
  })

  describe('a signature tool must carry our schema, not only our name', () => {
    // Read from the public resale proxies on 2026-09-17: freebuff2api and its
    // forks, trefeon/freebuff-proxy, 9router's freebuff executor. Every one of
    // them cleared the name-only rule by appending the same hollow `end_turn`
    // to the real harness's toolset — the laundering vector the abuse doc had
    // named as "the obvious evasion once enforcement is noticed".
    test('a hollow end_turn does not launder Claude Code', () => {
      const verdict = detectForeignFreebuffClient({
        tools: [...CLAUDE_CODE_TOOLS, PROXY_HOLLOW_END_TURN],
      })
      // Claude Code's own names now settle it first; the hollow list still
      // records the stub for the log line.
      expect(verdict.signal).toBe('foreign_tool_names')
      expect(verdict.hollowToolNames).toEqual(['end_turn'])
      expect(
        resolveForeignClientDowngrade({
          body: {
            model: 'deepseek/deepseek-v4-flash',
            tools: [...CLAUDE_CODE_TOOLS, PROXY_HOLLOW_END_TURN],
          },
        })?.downgradeTo,
      ).toBe(FREEBUFF_DOWNGRADE_MODEL_ID)
    })

    test('a hollow end_turn does not launder a bare completion proxy', () => {
      // The other shape the same proxies produce: no harness tools at all,
      // just the injected definition.
      expect(
        detectForeignFreebuffClient({ tools: [PROXY_HOLLOW_END_TURN] }).signal,
      ).toBe('foreign_toolset')
    })

    test('our name over a foreign schema is not ours', () => {
      // trefeon/freebuff-proxy's "tool-name tolerance": Claude Code's `Read`
      // is relabelled `read_files` on the way up and back on the way down,
      // with the client's own parameter schema forwarded untouched. The model
      // is still asked for `file_path`, which we never defined.
      const relabelled = [
        stubTool('read_files', schema('file_path', 'offset', 'limit')),
        stubTool(
          'str_replace',
          schema('file_path', 'old_string', 'new_string'),
        ),
        stubTool(
          'run_terminal_command',
          schema('command', 'timeout', 'description'),
        ),
        stubTool('code_search', schema('pattern', 'path', 'output_mode')),
        stubTool('list_directory', schema('path', 'ignore')),
      ]
      const verdict = detectForeignFreebuffClient({ tools: relabelled })
      expect(verdict.signal).toBe('foreign_toolset')
      expect(verdict.hollowToolNames).toEqual([
        'read_files',
        'str_replace',
        'run_terminal_command',
        'code_search',
        'list_directory',
      ])
    })

    test('our name with no schema at all is not ours', () => {
      // Every client we ship serialises a schema for every tool, so a missing
      // `parameters` under one of our names is not a version skew, it is a
      // name copied without the thing that makes it a tool.
      expect(
        detectForeignFreebuffClient({
          tools: [stubTool('read_files'), stubTool('spawn_agents')],
        }).signal,
      ).toBe('foreign_toolset')
      expect(
        detectForeignFreebuffClient({
          tools: [stubTool('read_files', { type: 'object', properties: {} })],
        }).signal,
      ).toBe('foreign_toolset')
    })

    test('every parameterised tool we define is genuine as we ship it', () => {
      for (const name of Object.keys(toolParams)) {
        const keys = canonicalToolParameterKeys(name)
        expect(keys).not.toBeNull()
        if (keys!.size === 0) continue
        expect({
          name,
          genuine: isGenuineSignatureTool(offered(name)),
        }).toEqual({ name, genuine: !GENERIC_TOOL_NAMES.has(name) })
      }
    })

    test('the windowed read_files variant clears', () => {
      // Web and Cloud serve the windowed schema (line ranges inside `paths`);
      // CLI and Desktop the legacy one. Same top-level names, so both clear.
      const windowed = stubTool(
        'read_files',
        z.toJSONSchema(readFilesDisplayVariants.windowed.inputSchema, {
          io: 'input',
        }),
      )
      expect(isGenuineSignatureTool(offered(windowed))).toBe(true)
      expect(
        detectForeignFreebuffClient({ tools: [windowed] }).signal,
      ).toBeNull()
    })

    test('a client one release behind an added optional field clears', () => {
      // A subset of our names is still ours: the server deploys before the
      // clients, so an older binary lacking a field we just added must not
      // read as foreign.
      expect(
        detectForeignFreebuffClient({
          tools: [stubTool('run_terminal_command', schema('command', 'cwd'))],
        }).signal,
      ).toBeNull()
    })

    test('zero-parameter tools never count on their own', () => {
      // `end_turn` and `task_completed` have nothing structural to verify — a
      // copied name over `{}` is byte-identical to the real definition — so
      // they contribute nothing, in either direction. Every agent we ship
      // carries a parameterised signature tool beside them (the shipped-agents
      // test asserts it), so this costs our own traffic nothing.
      expect(
        detectForeignFreebuffClient({ tools: tools('end_turn') }).signal,
      ).toBe('foreign_toolset')
      expect(
        detectForeignFreebuffClient({
          tools: tools('end_turn', 'task_completed'),
        }).signal,
      ).toBe('foreign_toolset')
      expect(
        detectForeignFreebuffClient({ tools: tools('end_turn', 'read_files') })
          .signal,
      ).toBeNull()
      // Our own hollow-by-nature tools are not reported as laundering either.
      expect(
        detectForeignFreebuffClient({ tools: tools('end_turn', 'read_files') })
          .hollowToolNames,
      ).toEqual([])
    })

    test('a custom tool is still taken at its name', () => {
      // `decide` has no schema in toolParams to check against.
      expect(
        detectForeignFreebuffClient({ tools: [stubTool('decide')] }).signal,
      ).toBeNull()
    })

    test('genuine toolsets report no hollow names', () => {
      for (const toolset of FREEBUFF_TOOLSETS) {
        expect(
          detectForeignFreebuffClient({ tools: toolset }).hollowToolNames,
        ).toEqual([])
      }
    })

    test('MCP tools beside our real tools still clear', () => {
      // The reason the rule is "at least one genuine" and not "all ours": a CLI
      // user can attach any MCP server to a base agent.
      expect(
        detectForeignFreebuffClient({
          tools: [
            ...tools('read_files', 'run_terminal_command', 'str_replace'),
            stubTool('ghidra__decompile_function', schema('address')),
            stubTool('ghidra__list_functions', schema('offset', 'limit')),
          ],
        }).signal,
      ).toBeNull()
    })
  })

  test('reports bounded evidence for the log line', () => {
    const verdict = detectForeignFreebuffClient({
      tools: tools('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'),
    })
    expect(verdict.toolCount).toBe(10)
    expect(verdict.sampleToolNames).toHaveLength(8)
  })

  test.each([
    ['researcher-web', ['web_search', 'read_url']],
    ['researcher-docs', ['read_docs']],
    ['freebuff-desktop-autorun', ['decide']],
    ['basher', ['run_terminal_command']],
    ['file-picker', ['spawn_agents']],
  ])('clears our own %s toolset', (_agent, names) => {
    // Backtested over 30 days against the signature alone: researcher-web was
    // flagged on 100% of 334,042 requests from 4,821 users, autorun on 100% of
    // 2,904 from 41. `web_search` cannot join the signature (opencode ships
    // it), so these clear by the every-tool-is-ours rule instead.
    expect(
      detectForeignFreebuffClient({ tools: tools(...names) }).signal,
    ).toBeNull()
  })

  test('a harness tool name is foreign even beside our genuine tools', () => {
    // This test used to assert the opposite — that one borrowed distinctive
    // name clears an otherwise foreign toolset — as a known cost of `some`
    // semantics. 2026-09-18: a proxy appended our REAL definitions to Claude
    // Code's toolset and cleared the schema rule the morning after it
    // shipped. `some` still holds for names we cannot classify (MCP, local
    // agents); it no longer holds for a name only a harness we do not ship
    // uses.
    const verdict = detectForeignFreebuffClient({
      tools: [
        ...tools('read_files', 'run_terminal_command'),
        ...CLAUDE_CODE_TOOLS,
      ],
    })
    expect(verdict.signal).toBe('foreign_tool_names')
    expect(verdict.hollowToolNames).toEqual([])
    expect(
      resolveForeignClientDowngrade({
        body: {
          model: 'deepseek/deepseek-v4-flash',
          tools: [...tools('read_files'), stubTool('Bash', schema('command'))],
        },
      })?.downgradeTo,
    ).toBe(FREEBUFF_DOWNGRADE_MODEL_ID)
  })

  test('the harness list never names a tool any of our surfaces registers', () => {
    for (const name of FOREIGN_HARNESS_TOOL_NAMES) {
      expect(FREEBUFF_SIGNATURE_TOOL_NAMES.has(name)).toBe(false)
      expect(GENERIC_TOOL_NAMES.has(name)).toBe(false)
      expect(
        (FREEBUFF_CUSTOM_TOOL_NAMES as readonly string[]).includes(name),
      ).toBe(false)
      // Desktop THREAD_TOOL_SPECS and Web image/document tools, by name.
      expect([
        'suggest_prompts',
        'ask_questions',
        'exit_plan',
        'request_elevation',
        'read_thread_context',
        'register_preview',
        'preview_snapshot',
        'preview_screenshot',
        'preview_click',
        'preview_type',
        'preview_navigate',
        'inspect_image',
        'search_files',
        'read_file_lines',
      ]).not.toContain(name)
    }
    // Our names and MCP names never look like harness names.
    for (const name of toolNames) {
      expect(FOREIGN_HARNESS_TOOL_NAMES.has(name)).toBe(false)
    }
  })

  test('a harness identity in a system message is foreign', () => {
    const claudeCodePrompt =
      'You are Buffy, the strategic coding assistant.\n\n' +
      "You are Claude Code, Anthropic's official CLI for Claude."
    expect(
      detectForeignFreebuffClient({
        tools: tools('read_files', 'run_terminal_command'),
        messages: [{ role: 'system', content: claudeCodePrompt }],
      }).signal,
    ).toBe('foreign_system_prompt')
    // Any system message, not only the first, and content-part arrays too.
    expect(
      detectForeignFreebuffClient({
        messages: [
          {
            role: 'system',
            content: 'You are Buffy, the strategic coding assistant.',
          },
          {
            role: 'system',
            content: [
              {
                type: 'text',
                text: 'x-anthropic-billing-header: cc_version=2.1.0; cc_entrypoint=cli',
              },
            ],
          },
        ],
      }).signal,
    ).toBe('foreign_system_prompt')
    expect(
      findForeignHarnessPromptMarker([
        { role: 'system', content: claudeCodePrompt },
      ]),
    ).toBe('You are Claude Code')
  })

  test('a harness identity in a USER message is not', () => {
    // A Freebuff user pasting a Claude Code transcript into a chat must never
    // be downgraded, let alone permanently flagged. Only system-role text
    // counts, and that text is client-authored.
    expect(
      detectForeignFreebuffClient({
        tools: tools('read_files'),
        messages: [
          {
            role: 'system',
            content: 'You are Buffy, the strategic coding assistant.',
          },
          {
            role: 'user',
            content:
              'why does it say "You are Claude Code, Anthropic\'s official CLI" here?',
          },
        ],
      }).signal,
    ).toBeNull()
  })

  test('reports unrecognised names for the observe-only line', () => {
    const verdict = detectForeignFreebuffClient({
      tools: [
        ...tools('read_files', 'file_picker'),
        stubTool('ghidra__decompile', schema('address')),
        stubTool('my_local_agent', schema('prompt')),
      ],
    })
    expect(verdict.signal).toBeNull()
    // `file_picker` is an agent-as-tool name the server cannot enumerate, so
    // it is reported too — which is why nothing enforces on this list.
    expect(verdict.unrecognisedToolNames).toEqual([
      'file_picker',
      'my_local_agent',
    ])
    expect(listUnrecognisedToolNames(CLAUDE_CODE_TOOLS)).toEqual([])
  })

  test('a root agent offering no tools is a bare completion proxy', () => {
    // Our roots always ship their toolset — that is what makes them agentic.
    // Measured over 7 days with assistant-response rows excluded, the desktop
    // roots send zero tool-free requests (0 of 683,151 for -v3, 0 of 294,823
    // for -worktree) and the CLI roots 0.30%/2.81%. All 18 users sampled across
    // that tail were non-coding automation.
    expect(detectForeignFreebuffClient({}, true).signal).toBe(
      'root_agent_no_tools',
    )
    // Sampling params do not change the verdict for a root.
    expect(detectForeignFreebuffClient({ temperature: 0.7 }, true).signal).toBe(
      'root_agent_no_tools',
    )
  })

  test('a root agent sending our tools is still ours', () => {
    // Evading root_agent_no_tools means sending our toolset, at which point the
    // toolset check applies instead — the same convergent property.
    expect(
      detectForeignFreebuffClient({ tools: tools('ask_user') }, true).signal,
    ).toBeNull()
    expect(
      detectForeignFreebuffClient({ tools: tools('Bash', 'Edit') }, true)
        .signal,
    ).toBe('foreign_tool_names')
  })

  test('a tool-free SUBagent is untouched', () => {
    // Our helper agents (chat titles, compaction, researcher-docs) legitimately
    // send no tools; only ROOT agents are agentic by definition. Defaulting
    // isRootAgent to false keeps every non-root caller on the old behaviour.
    expect(detectForeignFreebuffClient({}).signal).toBeNull()
    expect(detectForeignFreebuffClient({}, false).signal).toBeNull()
  })

  test('downgrade target is the free OpenRouter variant', () => {
    expect(FREEBUFF_DOWNGRADE_MODEL_ID).toBe('inclusionai/ling-3.0-tiny:free')
    expect(FREEBUFF_DOWNGRADE_MODEL_ID.endsWith(':free')).toBe(true)
  })
})

describe('resolveForeignClientDowngrade', () => {
  const foreign = { tools: tools('Bash', 'Edit') }
  const params = { max_completion_tokens: 977_725 }
  const ours = { tools: tools('ask_user', 'read_files') }

  test('always downgrades a foreign toolset', () => {
    // Third-party clients are a terms violation: Freebuff funds free inference
    // with ads only our own clients render, so a proxied request takes the
    // cost and returns none of the revenue. There is no mode in which this is
    // served what it asked for.
    expect(resolveForeignClientDowngrade({ body: foreign })!.downgradeTo).toBe(
      FREEBUFF_DOWNGRADE_MODEL_ID,
    )
  })

  test('reports but never acts on a tool-free root agent', () => {
    // Deliberately report-only. The 30-day backtest found 3,729 users who mix
    // tool-free root requests into real agentic traffic, 999 of whose sessions
    // contain both — enforcing per-request swaps the model mid-session for real
    // coding runs. Only 417 users are pure proxies, and no run-length threshold
    // separates them (the MIXED cohort holds the longest tool-free run, 11,094,
    // vs 2,153 for the proxies). Flipping this to enforce needs an
    // account-level verdict, not a change here.
    const d = resolveForeignClientDowngrade({ body: {}, isRootAgent: true })!
    expect(d.signal).toBe('root_agent_no_tools')
    expect(d.downgradeTo).toBeNull()
  })

  test('leaves a tool-free non-root request alone', () => {
    expect(resolveForeignClientDowngrade({ body: {} })).toBeNull()
  })

  test('reports but never acts on the sampling-param signal', () => {
    const decision = resolveForeignClientDowngrade({ body: params })!
    expect(decision.signal).toBe('sampling_params')
    expect(decision.downgradeTo).toBeNull()
  })

  test('a freebuff toolset is never reported', () => {
    expect(resolveForeignClientDowngrade({ body: ours })).toBeNull()
  })

  test('does not re-downgrade a request already on the downgrade model', () => {
    const decision = resolveForeignClientDowngrade({
      body: { ...foreign, model: FREEBUFF_DOWNGRADE_MODEL_ID },
    })!
    expect(ENFORCED_SIGNALS.has(decision.signal)).toBe(true)
    expect(decision.downgradeTo).toBeNull()
  })
})

function schema(...keys: string[]) {
  return {
    type: 'object',
    properties: Object.fromEntries(keys.map((k) => [k, { type: 'string' }])),
  }
}

function offered(tool: string | ReturnType<typeof wireTool>) {
  const t = typeof tool === 'string' ? wireTool(tool) : tool
  return { name: t.function.name, parameters: t.function.parameters }
}
