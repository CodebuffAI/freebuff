/**
 * The agent a local sponsored run executes as, in the terminal (COD-339).
 *
 * ## The engine pin is satisfied by construction here, and that is worth saying
 *
 * COD-336 decision item 6 pins a sponsored run to the `codebuff` harness,
 * because it is the only harness whose tool loop we own and therefore the only
 * one the capability gate can be ported to. On Desktop that is a real choice —
 * a tab can be set to `claude-code` or `codex`, both of which drive a vendor
 * CLI with `bypassPermissions` / `danger-full-access`, and the pin is what makes
 * those two unreachable for a sponsored run.
 *
 * The CLI has no such choice to make. `git grep 'harness' -- cli/src` finds the
 * `CLI_HARNESS` family switch (base2 vs base3 ROOTS, `docs/freebuff-base3-
 * harness.md`) and nothing that runs a vendor CLI: every turn goes through
 * `CodebuffClient.run` in `utils/codebuff-client.ts`, whose tool loop is the
 * SDK's. So the pin holds trivially — CONFIRMED rather than assumed, which is
 * what the ticket asked for — and there is no engine to override.
 *
 * ## What is NOT trivial: the CLI root offers four tools the grant refuses
 *
 * `createBase3CliRoot` (`agents/base3.ts`) adds `ask_user`,
 * `suggest_followups`, `render_ui` and `skill` to base3's eight. The first
 * three are `human_in_loop` and the fourth is `delegate`, and
 * `SPONSORED_LOCAL_V1_GRANT` refuses both capabilities — a sponsored run is
 * unattended by construction, so an `ask_user` is a question nobody is shown,
 * and nothing propagates a per-run restriction into a spawned agent's template.
 *
 * `overrideTools` cannot close that: three of the four are not client-executed
 * at all, so no client-side handler is ever consulted for them. The narrowing
 * therefore has to happen where Desktop does it — in the `toolNames` of the
 * definition the run is started with.
 *
 * ## Why this keeps the CLI's own root id and model
 *
 * Free mode gates on the (agent id, model) pair (`FREE_MODE_AGENT_MODELS`), so
 * a sponsored run started under an invented id is a run that cannot be admitted
 * at all. The definition is the CLI's own root with a narrower toolset — the
 * same shape Desktop sends — never a different agent.
 *
 * And the system prompt is APPENDED to, never prepended:
 * `hasFreebuffRootSystemPromptOpening` requires the canonical opening at byte 0
 * and 403s every free-mode turn without it (`docs/freebuff-base3-harness.md`).
 */
import { createBase3CliRoot } from '../../../agents/base3'
import {
  SPONSORED_LOCAL_V1_GRANT,
  sponsoredLocalToolNames,
} from '@codebuff/common/ads/sponsored-local-execution'

import {
  sponsoredProcedureRuntimeInputsSection,
  type SponsoredProcedureRuntimeInputs,
} from '@codebuff/common/ads/sponsored-procedure-inputs'

import type { SponsoredCapability } from '@codebuff/common/ads/sponsored-local-execution'
import type { AgentDefinition } from '@codebuff/sdk'

/**
 * The two bullets that make a sponsored run commit and not push.
 *
 * MIRRORED from `SPONSORED_REPO_GIT_GUIDANCE`
 * (`freebuff/web/convex/coding_agent/cli_agent/system_prompt.ts`), the same way
 * `evals/sponsored/prompt.ts` and Desktop's `sponsored-run.ts` mirror them, and
 * for the same reason: importing that module drags the Convex generated API
 * into the CLI's typecheck program. `sponsored-agent.test.ts` reads the
 * production file as text and fails if the two stop matching, so the mirror
 * cannot drift silently.
 */
export const SPONSORED_COMMIT_BULLET =
  '- Commit your finished work to the current branch with a clear message. You are already on a branch created for this task, so do not create or switch branches.'
export const SPONSORED_NO_PUSH_BULLET =
  '- Do NOT push, open a pull request, or run any other Git delivery command. The user reviews your commits and decides whether they go anywhere.'

/**
 * What the CLI adds to the mirrored guidance.
 *
 * Every line here restates a refusal that is ENFORCED elsewhere, which is the
 * right way round: the enforcement is the boundary and the sentence is what
 * stops a run spending three turns discovering it.
 */
const CLI_SPONSORED_GUIDANCE = [
  SPONSORED_COMMIT_BULLET,
  SPONSORED_NO_PUSH_BULLET,
  '- Commit with `--no-verify`. Git hooks are disabled for this run, so a hook-dependent commit will fail rather than run.',
  '- Do NOT install dependencies. `npm install`, `bun add` and their equivalents are refused: work with what the repository already has.',
  '- You are running inside a sandbox rooted at this worktree. Nothing outside it is readable or writable, and the environment carries no credentials.',
  '- There is nobody watching this run. Do not ask questions; decide and proceed, or stop.',
].join('\n')

export function buildSponsoredPrompt(
  procedure: string,
  runtimeInputs: SponsoredProcedureRuntimeInputs = {},
): string {
  // The procedure is never rewritten (COD-512): the consent covered these
  // exact bytes. The advertiser link, when the procedure declared
  // `{{advertiserLink}}`, rides as its own section after it.
  const inputs = sponsoredProcedureRuntimeInputsSection(
    procedure,
    runtimeInputs,
  )
  return [
    CLI_SPONSORED_GUIDANCE,
    `User request:\n${procedure}`,
    ...(inputs ? [inputs] : []),
  ].join('\n\n')
}

/**
 * The definition a sponsored turn runs as.
 *
 * `noAskUser` is passed as well as the toolName narrowing below, and both are
 * deliberate: the flag removes the two human tools AND the paragraph of the
 * appendix that tells the model to use them, so the run is not being told to do
 * something its toolset refuses. The narrowing is what makes it true.
 */
export function sponsoredAgentDefinition(options: {
  agentId: string
  model?: string
  isFreebuff: boolean
  grant?: ReadonlySet<SponsoredCapability>
}): AgentDefinition {
  const {
    agentId,
    model,
    isFreebuff,
    grant = SPONSORED_LOCAL_V1_GRANT,
  } = options
  const root = createBase3CliRoot({
    ...(model ? { model } : {}),
    isFreebuff,
    noAskUser: true,
  })
  return {
    ...root,
    id: agentId,
    // A NARROWING of what the root already offers, never a replacement: a
    // sponsored run has to be a subset of an ordinary one, so a tool the root
    // does not have cannot appear here by way of the policy granting its
    // capability.
    toolNames: sponsoredLocalToolNames(root.toolNames ?? [], grant),
    systemPrompt: `${root.systemPrompt}\n\n# Sponsored task\n\n${CLI_SPONSORED_GUIDANCE}`,
    // The commit is authored by the sponsored run, not by the user, and the
    // ordinary attribution trailer would say otherwise on a branch they are
    // about to review.
    suppressCommitAttribution: true,
  } as AgentDefinition
}
