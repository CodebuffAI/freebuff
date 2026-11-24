---
description: "Spawn this agent between steps to prune context, summarizing the conversation into a condensed format when context exceeds the limit."
mode: subagent
model: anthropic/claude-sonnet-4.6
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
    effect: deny
---

# Context Pruner (context-pruner)

Spawn this agent between steps to prune context, summarizing the conversation into a condensed format when context exceeds the limit.
