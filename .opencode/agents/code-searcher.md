---
description: "Mechanically runs multiple code search queries (using ripgrep line-oriented search) and returns up to 250 results across all source files, showing each line that matches the search pattern. Excludes git-ignored files. You MUST pass searchQueries in params. Example input: { \"params\": { \"searchQueries\": [{ \"pattern\": \"createUser\", \"flags\": \"-g *.ts\" }, { \"pattern\": \"deleteUser\", \"flags\": \"-g *.ts..."
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

# Code Searcher (code-searcher)

Mechanically runs multiple code search queries (using ripgrep line-oriented search) and returns up to 250 results across all source files, showing each line that matches the search pattern. Excludes git-ignored files. You MUST pass searchQueries in params. Example input: { "params": { "searchQueries": [{ "pattern": "createUser", "flags": "-g *.ts" }, { "pattern": "deleteUser", "flags": "-g *.ts" }, { "pattern": "UserSchema", "maxResults": 5 }] } }
