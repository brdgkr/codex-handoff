# NPM Installer Spec

This document defines the future npm-based packaging strategy for `codex-handoff`.

It exists to support the agent-driven install UX. It does not mean the npm package already exists.

## Primary UX goal

The npm layer should make the product feel like:

- install once on a machine
- authenticate once on a machine
- attach the current repository
- discover that repo's Codex threads
- sync thread bundles, including original session source and the repo-local `.codex-handoff/` view, to Cloudflare R2
- automatically pull the latest thread bundles on the next machine before work resumes

## Why npm

An npm package is a reasonable outer installer because:

- Node is already common on macOS and Windows developer machines
- Codex can install with one command
- npm has familiar global-install ergonomics
- a Node entry point can orchestrate OS-specific setup and call into the sync engine

## Recommended package model

- npm package name: `@brdg/codex-handoff`
- executable name: `codex-handoff`
- install mode: global install
- preferred inner runtime: Node wrapper plus the existing Python engine
- postinstall behavior: copy the bundled `codex-handoff` skill into `~/.codex/skills/codex-handoff`

## Recommended split

### npm wrapper

Owns:

- install-time dependency checks
- OS detection
- one-command machine bootstrap
- background service registration
- current-repo attach flow
- local thread discovery
- initial pull before watch mode
- log directory bootstrap
- invoking the sync engine

### core engine

Owns:

- memory file reading
- context pack generation
- remote auth operations
- thread bundle export
- source session sync and normalized metadata export
- repo-scoped R2 object sync
- local Codex session/index/sqlite materialization
- sync conflict handling

## Proposed install sequence

```text
npm install -g @brdg/codex-handoff
codex-handoff install --repo <path>
```

The `install` command should internally cover:

1. `doctor`
2. skill install when missing
3. remote login when needed
4. current repo attach
5. thread discovery from the local thread list and session index
6. initial remote pull for that repo when matching an existing remote
7. initial push when creating a new remote
8. agent auto-start registration
9. agent start
10. final sync health summary

## Required installer behaviors

- If Node is missing, Codex should install or prompt for Node first.
- If the package is already installed, rerun health checks instead of reinstalling.
- If the agent is already registered, restart or validate it instead of duplicating it.
- If the machine is not authenticated, prompt only for the missing R2 fields.
- If the repo is already attached, confirm status instead of attaching twice.
- If local thread metadata can be discovered from the thread list and session index, do not ask the user for paths.
- If the remote repo prefix already exists, pull it before enabling background watch mode.
- If local state and remote state both changed since the last sync, create a conflict snapshot instead of silently dropping either side.

## Remote object layout

The remote bucket should be organized by repo first and thread id second.

Recommended shape:

```text
repos/<repo-slug>/
  manifest.json
  thread-index.json
  current-thread.json
  threads/
    <thread-id>/
      manifest.json
      latest.md
      handoff.json
      raw/session.jsonl
      source/
        rollout.jsonl.gz
        index-entry.json
        thread-record.json
```

Where:

- `manifest.json` records repo identity, known machines, revision markers, and sync metadata
- `thread-index.json` stores discovered thread metadata
- `current-thread.json` points to the thread to materialize into the root `.codex-handoff/` view
- each `threads/<thread-id>/` directory stores the original source session, normalized Codex-local metadata, and the summarized handoff data

## Service registration targets

### macOS

- preferred: `launchd` user agent plist
- verbs:
  - `codex-handoff agent enable`
  - `codex-handoff agent disable`

### Windows

- preferred: Task Scheduler per-user task
- verbs:
  - `codex-handoff agent enable`
  - `codex-handoff agent disable`

## Output principles

The installer should report:

- what it changed
- which repo it attached
- how many threads it discovered
- which remote prefix it is using
- whether the background agent is active
- whether the remote credentials validated
- whether the current repo is attached
- whether an initial pull completed
- whether source session materialization into local Codex storage completed
- where logs and config live

The installer should not dump:

- raw secret material
- full debug logs unless requested
- entire remote object listings
