---
description: "Edits code by spawning multiple implementor agents with different strategy prompts, selects the best implementation, and applies the changes. It also returns further suggested improvements which you should take seriously and act on. Pass as input an array of short prompts specifying different implementation approaches or strategies. Make sure to read any files intended to be edited before spawn..."
mode: all
model: anthropic/claude-opus-5
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

# Multi-Prompt Editor (editor-multi-prompt)

Edits code by spawning multiple implementor agents with different strategy prompts, selects the best implementation, and applies the changes. It also returns further suggested improvements which you should take seriously and act on. Pass as input an array of short prompts specifying different implementation approaches or strategies. Make sure to read any files intended to be edited before spawning this agent.

## Subagents

You can launch these opencode subagents:

- `best-of-n-selector2`
- `editor-implementor-opus`
- `editor-implementor-gpt-5`
