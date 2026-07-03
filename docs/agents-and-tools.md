# Agents and Tools

## Agents

- Prompt/programmatic agents live in `.agents/` (programmatic agents use `handleSteps` generators).
- Generator functions execute in a sandbox; agent templates define tool access and subagents.

### Shell Shims

Direct commands without `codebuff` prefix:

```bash
codebuff shims install codebuff/base-lite@1.0.0
eval "$(codebuff shims env)"
base-lite "fix this bug"
```

## Tools

- Tool definitions live in `common/src/tools` and are executed via the SDK helpers + agent-runtime.

## Model providers

Model ids use the `provider/model` form (e.g. `openai/gpt-4o-mini`,
`anthropic/claude-sonnet-4.5`). By default, requests are sent through the
Codebuff backend, which routes to the upstream provider (OpenRouter).

### Requesty (direct route)

[Requesty](https://requesty.ai) is an OpenAI-compatible router. Setting the
`REQUESTY_API_KEY` environment variable routes chat completions directly to the
Requesty router (`https://router.requesty.ai/v1`) instead of the Codebuff
backend, using the same `provider/model` ids. This mirrors the existing direct
ChatGPT OAuth route in `sdk/src/impl/model-provider.ts`.

- Router base URL: `https://router.requesty.ai/v1`
- API keys: https://app.requesty.ai/api-keys
- Model list: https://app.requesty.ai/router/list
- Docs: https://docs.requesty.ai

When `REQUESTY_API_KEY` is unset, behavior is unchanged.


