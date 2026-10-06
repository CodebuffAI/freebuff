/**
 * The values `users:setCliPreference` accepts for each CLI agent preference
 * on a users document. Shared by the Convex mutation
 * (freebuff/web/convex/users.ts) and its Postgres twin
 * (packages/internal/src/identity/writes.ts), so the two cannot accept
 * different values (COD-742 identity writes).
 */

export const GPT_MODEL_PREFERENCES = [
  'default',
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
] as const

// Mirrors ANTHROPIC_CLAUDE_MODELS / BEDROCK_CLAUDE_MODELS in
// freebuff/web/src/server/agent-runner/executeClaudeCode.ts. Old ids stay
// forever — this validates a stored preference, so removing one rejects the
// saved choice of every user who picked it.
export const CLAUDE_MODEL_PREFERENCES = [
  'default',
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-opus-4-8',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
  'us.anthropic.claude-opus-5',
  'us.anthropic.claude-sonnet-5',
  'us.anthropic.claude-opus-4-8',
  'us.anthropic.claude-sonnet-4-6',
  'us.anthropic.claude-haiku-4-5-20251001-v1:0',
] as const

export const CLI_PREFERENCE_VALUES = {
  gpt_auth_method: ['oauth', 'byok'],
  claude_provider_preference: ['anthropic', 'bedrock'],
  gpt_model_preference: GPT_MODEL_PREFERENCES,
  claude_model_preference: CLAUDE_MODEL_PREFERENCES,
} as const

export type CliPreferenceKey = keyof typeof CLI_PREFERENCE_VALUES

export const CLI_PREFERENCE_KEYS = Object.keys(
  CLI_PREFERENCE_VALUES,
) as CliPreferenceKey[]

export function isAllowedCliPreferenceValue(
  key: CliPreferenceKey,
  value: string,
): boolean {
  return (CLI_PREFERENCE_VALUES[key] as readonly string[]).includes(value)
}
