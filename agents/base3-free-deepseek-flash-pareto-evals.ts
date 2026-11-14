import baseDefinition from './base3-free-deepseek-flash-evals'

/**
 * base3 on DeepSeek V4.1 Flash served by Pareto alone (buffbench provider
 * comparison). Identical to base3-free-deepseek-flash-evals except for the
 * lane: `only` asks prod web for this one Flash lane, which it honours for
 * admin and god accounts only (web/src/llm-api/deepseek-eval-lane.ts).
 */
const definition = {
  ...baseDefinition,
  id: 'base3-free-deepseek-flash-pareto-evals',
  displayName: 'Buffy on DeepSeek Flash via Pareto (evals)',
  providerOptions: { ...baseDefinition.providerOptions, only: ['pareto'] },
}

export default definition
