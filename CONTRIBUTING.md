# Contributing

This repository is a public mirror of the Freebuff/Codebuff source tree. The private repository is the source of truth, so accepted public contributions are ported into the private repo and then exported back here.

## Public Contributions

Good public PRs are usually scoped to:

- `cli/`
- `sdk/`
- `common/`
- `agents/`
- `packages/agent-runtime/`
- `packages/code-map/`
- `packages/llm-providers/`
- `freebuff/`, excluding the private web app
- `scripts/tmux/`
- public docs

Please do not add backend, database, billing, deployment, or secret-management code to the public repo.

## Development

Install dependencies:

```bash
bun install
```

Build the SDK:

```bash
bun run build:sdk
```

Build the Freebuff binary:

```bash
bun run build:freebuff
```

## Pull Request Flow

1. Open the PR against the public repo.
2. Public CI validates the exported public packages.
3. An automated reviewer reads the diff, posts a review, and labels the PR with
   a disposition (see below).
4. A maintainer reviews the change.
5. If accepted, a maintainer ports the patch into the private source repo.
6. The next public export brings the accepted change back into this repo.

Because the private repo is the source of truth, your PR is **not merged here**
even when it is accepted — the change is ported and returns in the next export.
So what matters is whether the change is worth porting, not whether it merges
cleanly.

### Automated checks

Every PR gets three structural checks within about ten seconds of opening. They
block merging but never close anything, and all three are fixable by editing
the PR:

1. **Title** — must actually describe the change. Branch names pasted in
   (`Fix/windows-conpty-leak`), one-word stubs, and `WIP` markers are rejected;
   there is no required prefix format.
2. **Description** — must say what the change does and why. Accepted changes are
   ported by hand into a private source tree, so a PR that does not explain
   itself is expensive to accept.
3. **Scope** — must not touch `web/`, `freebuff/web/`, `packages/internal/`,
   `packages/billing/` or `packages/bigquery/`. Those are not part of this
   repository and a change to them cannot be merged here however good it is.

### What gets a PR accepted

- It is scoped to one thing, and the diff stays reviewable.
- It fixes a real problem you can describe, ideally with a repro.
- It stays inside the paths listed above.

### What gets a PR closed

- It touches backend, database, billing, or deployment paths.
- It changes product direction unilaterally — renaming the project, swapping
  default models, adding a vendor integration nobody asked for.
- It is a mass mechanical rewrite with no functional change.
- It went stale after review feedback with no response.

A closed PR is not a door slammed. If you think a close was wrong, say so on
the thread and a maintainer will take another look.

## Issue and PR triage

This repository is triaged daily by an automated bot. It labels issues by type
and area, reviews pull requests, and closes:

- duplicates, pointed at the original;
- provider-outage reports, which are operational rather than defects;
- posts with no specific problem to act on;
- **anything, issue or pull request, with no activity for 28 days.** This is the
  big one. It is not a judgement about your report — the backlog is large and
  inactivity is the only fair way to bound it. You get a comment 7 days before
  it happens, and **a single reply keeps it open**. Anything a maintainer has
  commented on is left alone entirely.

**Anything it closes can be reopened**, and every automated close says so. If
the bot got you wrong, reopen or reply — a maintainer reads those.

One thing worth knowing before you file: **model outages and daily limits are
not tracked here.** If a model is unavailable or you have hit a session cap,
that is operational and [Discord](https://discord.gg/yXG3w7wxfs) is much faster.
If you think a limit is being *counted* wrong — the wrong number of sessions
used, limits not resetting, a premium slot consumed by a free model — that is a
bug and we do want the issue.
