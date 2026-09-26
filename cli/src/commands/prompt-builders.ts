/**
 * Centralized prompt builders for /plan, /review, and /btw commands.
 * This ensures consistent behavior regardless of entry path. Both run on the
 * user's currently selected model.
 */

// Base prompts - both always gather context first.
const PLAN_BASE_PROMPT =
  'Gather all the relevant context and then think carefully about how to implement the following:'
const REVIEW_BASE_PROMPT =
  'Please gather all relevant context and then carefully review:'

const BTW_BASE_PROMPT =
  'The user has an additional thought for the current task. Consider it without abandoning the original request:'

/** Build the prompt sent by `/btw` without the command syntax. */
export function buildBtwPrompt(input: string): string {
  const trimmedInput = input.trim()
  return trimmedInput
    ? `${BTW_BASE_PROMPT}\n\n${trimmedInput}`
    : BTW_BASE_PROMPT
}

/**
 * Build a plan prompt from user input.
 * @param input - The user's plan request (e.g., "add OAuth login")
 * @returns The full prompt to send to the agent
 */
export function buildPlanPrompt(input: string): string {
  const trimmedInput = input.trim()
  if (!trimmedInput) {
    return PLAN_BASE_PROMPT
  }
  return `${PLAN_BASE_PROMPT}\n\n${trimmedInput}`
}

// Base prompt for interview command - asks clarifying questions before acting
export const INTERVIEW_BASE_PROMPT = 'Interview me to better understand my request and then create a spec file. First, gather any relevant context (read files, do research, etc.). Then, use several rounds of the ask_user tool to ask non-obvious clarifying questions — things you cannot easily infer from the codebase or my initial message. Ask about edge cases, preferences, constraints, and design decisions. All questions should be directed through the ask_user tool -- not written out as text. Keep coming up with new questions that get at unique aspects of the request. Aim for at least **3 rounds** with multiple questions each round. When satisfied, write a [INSERT_REQUEST_SHORT_NAME]-spec.md file with all the information you have gathered about the request. Aim for as much detail as possible. You should NOT make any code changes yet. Stop after creating the spec file. End by using the suggest_followups tool with ways to flesh out the spec file. Here is my request:'

/**
 * Build an interview prompt from user input.
 * @param input - The user's request to be interviewed about
 * @returns The full prompt to send to the agent
 */
export function buildInterviewPrompt(input: string): string {
  const trimmedInput = input.trim()
  if (!trimmedInput) {
    return INTERVIEW_BASE_PROMPT
  }
  return `${INTERVIEW_BASE_PROMPT}\n\n${trimmedInput}`
}

/**
 * Build the prompt for a user-invoked skill. Shared by the /skill:<name>
 * command (when it carries trailing text) and the skill input mode's second
 * submit, so both entry paths produce byte-identical prompts.
 *
 * `content` is the whole SKILL.md (frontmatter included) — same as the
 * agent-runtime's own skill tool output.
 */
export function buildSkillPrompt(
  skill: { name: string; content: string },
  input: string,
): string {
  const skillContext = `<skill name="${skill.name}">\n${skill.content}\n</skill>`
  const trimmedInput = input.trim()
  return (
    `I invoke the following skill:\n\n${skillContext}\n\n` +
    (trimmedInput ? `User request: ${trimmedInput}` : '')
  )
}

/**
 * Review scope presets for the review screen.
 */
type ReviewScope = 'conversation' | 'uncommitted' | 'branch' | 'custom'

/**
 * Get the default text for a review scope preset.
 */
function getReviewScopeText(scope: ReviewScope): string {
  switch (scope) {
    case 'conversation':
      return 'all changes made in this conversation'
    case 'uncommitted':
      return 'uncommitted changes'
    case 'branch':
      return 'this branch compared to main'
    case 'custom':
      return ''
  }
}

/**
 * Build a review prompt from scope or custom input.
 * @param scope - The selected review scope (conversation, uncommitted, branch, or custom)
 * @param customInput - Optional custom review focus (when scope is 'custom')
 * @returns The full prompt to send to the agent
 */
export function buildReviewPrompt(
  scope: ReviewScope,
  customInput?: string,
): string {
  const scopeText = getReviewScopeText(scope)

  // For custom input, append the user's specific focus
  if (scope === 'custom' && customInput?.trim()) {
    return `${REVIEW_BASE_PROMPT} ${customInput.trim()}`
  }

  // For preset scopes, use the scope text
  if (scopeText) {
    return `${REVIEW_BASE_PROMPT} ${scopeText}`
  }

  // Fallback for custom with no input
  return REVIEW_BASE_PROMPT
}

/**
 * Build a review prompt from direct argument (e.g., /review foo).
 * This is used when the user provides review text directly after the command.
 * @param input - The user's review request
 * @returns The full prompt to send to the agent
 */
export function buildReviewPromptFromArgs(input: string): string {
  const trimmedInput = input.trim()
  // Use the same format as preset scopes for consistency
  return `${REVIEW_BASE_PROMPT} ${trimmedInput}`
}
