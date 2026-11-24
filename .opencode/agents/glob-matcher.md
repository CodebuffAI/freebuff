---
description: "Mechanically runs multiple glob pattern matches and returns all matching files"
mode: subagent
model: anthropic/claude-sonnet-4.5
permissions:
  - action: edit
    resource: "*"
    effect: deny
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

# Glob Matcher (glob-matcher)

Mechanically runs multiple glob pattern matches and returns all matching files
