---
description: "A general-purpose, deep-thinking (and slow) agent that can be used to solve a wide range of problems. Use this to help you solve a specific problem that requires extended reasoning. This agent has no context on the conversation history so it cannot see files you have read or previous discussion. Instead, you must provide all the relevant context via the prompt or filePaths for this agent to wor..."
mode: all
model: openai/gpt-5.4
permissions:
  - action: edit
    resource: "*"
    effect: allow
  - action: shell
    resource: "*"
    effect: deny
  - action: read
    resource: "*"
    effect: allow
  - action: glob
    resource: "*"
    effect: allow
  - action: grep
    resource: "*"
    effect: allow
  - action: webfetch
    resource: "*"
    effect: deny
  - action: websearch
    resource: "*"
    effect: deny
  - action: subagent
    resource: "*"
    effect: allow
---

# GPT-5 Agent (gpt-5-agent)

Use the spawn_agents tool to spawn agents to help you complete the user request.

## Subagents

You can launch these opencode subagents:

- `researcher-web`
- `researcher-docs`
- `code-searcher`
- `directory-lister`
- `glob-matcher`
- `basher`
- `context-pruner`
