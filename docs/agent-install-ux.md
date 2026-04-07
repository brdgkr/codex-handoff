# Agent-First Install UX

This document defines the install and operating experience for `codex-handoff` when the user gives Codex only a few lines of instructions and expects the agent to complete setup end to end.

The target platforms are:

- macOS
- Windows

The first remote provider is:

- Cloudflare R2

## Product framing

The user should experience `codex-handoff` as:

- one remote account
- one remote backend profile only
- one local background agent per machine
- one explicit attached repository per workspace the user wants to hand off
- automatic sync of repo-related Codex thread bundles plus the matching `.codex-handoff/` view
- explicit auth once per machine
- automatic pull before resuming work on another machine

The key product terms are:

- `remote`: the synchronized backend, first implemented by Cloudflare R2
- `agent`: the local background sync process installed on each machine
- `repo`: the user-facing attachment unit
- `thread bundle`: the sync unit for one Codex thread, containing raw source, normalized metadata, and derived handoff artifacts
- `attach`: opt a repository into handoff sync and connect it to local thread discovery
- `resume`: reconstruct Codex context from synced memory files

## Sync scope

Each attached repo should include:

- the local repository root the user is working in
- `.codex-handoff/` under that repository
- the local Codex thread list and session index, used only for discovery
- the original Codex session jsonl files for threads whose `cwd` matches the repo
- the normalized metadata required to recreate local `session_index` and SQLite thread visibility on another machine
- a remote prefix such as `repos/<repo-slug>/` inside the authenticated R2 bucket

The product should not behave like a generic filesystem sync tool. It should sync only the Codex source files and handoff artifacts required to resume work on another machine.

## Desired user journey

### Machine 1

1. User gives Codex a short install prompt.
2. Codex ensures npm is available and installs the package.
3. Codex authenticates the machine against Cloudflare R2.
4. Codex attaches the current repository.
5. Codex reads the local thread list and session index to discover repo-related threads.
6. Codex enables and starts the local sync agent.
7. The agent exports thread bundles under `.codex-handoff/threads/<thread-id>/` with both source logs and handoff files, then pushes them to the repo's R2 prefix in the background.

### Machine 2

1. User gives Codex the same short install prompt.
2. Codex installs the package if needed and validates the remote login.
3. Codex attaches the same repository.
4. Before the user resumes work, the agent pulls the latest remote thread bundles for that repo.
5. If local unsynced state exists, the agent compares revisions and resolves the serial-handoff case safely before pushing anything back.
6. The user starts a new Codex session in the synced repo.
7. `codex-handoff` restores the selected thread's original source log and normalized metadata into local `~/.codex/` storage so the thread can appear in Codex.
8. `codex-handoff` materializes the selected thread into the root `.codex-handoff/` files.
9. Codex reads `.codex-handoff/latest.md`, and on demand runs `codex-handoff resume`.

## What "agent-first" means here

The setup should not require the user to manually:

- locate config directories
- edit environment variables
- understand R2 endpoints
- inspect SQLite tables or session index files by hand
- register launchd or Task Scheduler jobs
- remember sync commands

The initial prompt should be enough for Codex to:

- ensure npm exists if the npm wrapper is the install path
- install the product
- authenticate
- attach the current repository
- discover repo-related threads from the local thread list and session index
- perform an initial pull
- register auto-start
- start the watcher
- verify health

## UX constraints

- The install flow must clearly separate local install from remote auth.
- The user should authenticate once per machine, not once per repo.
- Repo attachment should be explicit to avoid syncing unrelated workspaces.
- The primary workflow is serial handoff across machines, not simultaneous collaborative editing.
- The agent should pull before the first push on a machine after attach, login, wake, or restart.
- Local thread discovery should rely on the Codex thread list and session index first.
- Secrets must never be stored in repo files.
- The local agent must survive terminal exit and restart on login.

## Recommended command surface

These commands are the recommended external UX for the future agent package.

### Install and lifecycle

- `codex-handoff install`
- `codex-handoff uninstall`
- `codex-handoff doctor`
- `codex-handoff skill install`
- `codex-handoff agent start`
- `codex-handoff agent stop`
- `codex-handoff agent status`
- `codex-handoff agent restart`

### Remote auth

- `codex-handoff remote login r2`
- `codex-handoff remote whoami`
- `codex-handoff remote validate`
- `codex-handoff remote logout`

### Repo enrollment

- `codex-handoff attach --repo <path>`
- `codex-handoff detach --repo <path>`
- `codex-handoff repos list`
- `codex-handoff --repo <path> enable`

### Threads

- `codex-handoff threads scan --repo <path>`
- `codex-handoff threads list --repo <path>`
- `codex-handoff threads export --repo <path> --thread <id>`
- `codex-handoff threads use --repo <path> --thread <id>`

### Sync

- `codex-handoff sync now --repo <path>`
- `codex-handoff sync push --repo <path>`
- `codex-handoff sync pull --repo <path>`
- `codex-handoff sync status --repo <path>`

### Restore

- `codex-handoff --repo <path> status`
- `codex-handoff --repo <path> resume --goal "<goal>"`
- `codex-handoff --repo <path> context-pack --goal "<goal>"`

## Background agent responsibilities

The local agent should own:

- watching `.codex-handoff/latest.md`
- watching `.codex-handoff/handoff.json`
- watching `.codex-handoff/raw/*.jsonl`
- scanning the local Codex thread list and session index for repo-related threads
- reading original session jsonl for discovered threads
- extracting normalized `session_index` and SQLite thread metadata for those threads
- exporting thread bundles under `.codex-handoff/threads/<thread-id>/`
- batching source and handoff uploads
- debounced sync to the repo's R2 prefix
- local pull on start, attach, login, wake, and periodic health intervals
- pre-push remote head checks
- materializing pulled source logs into local `~/.codex/sessions/...`
- upserting pulled normalized metadata into local `~/.codex/session_index.jsonl` and `~/.codex/state_5.sqlite`
- materializing the selected thread into the root `.codex-handoff/` files after pull
- conflict-safe writes using last-modified metadata, revision markers, and local conflict snapshots
- structured logs for debugging

The agent should not own:

- full transcript summarization inside the daemon
- editing repo files outside `.codex-handoff/`
- implicit repo enrollment
- syncing every Codex session on the machine by default

## Serial handoff policy

`codex-handoff` is for one human moving between machines, not for concurrent multi-writer collaboration.

The expected policy is:

- always pull the repo's latest remote thread bundles before the first local push on a machine
- treat `.codex-handoff/raw/*.jsonl` as append-friendly evidence that can be unioned and deduplicated
- treat `latest.md` and `handoff.json` as handoff snapshots where newer remote state should be respected unless the local machine is clearly ahead
- keep thread bundles separate by thread id instead of flattening them into one remote root
- keep source session documents immutable per revision once uploaded
- rebuild local Codex-visible records from normalized bundle metadata instead of copying local SQLite files as the remote source of truth
- if both sides changed since the last common revision, create a local conflict snapshot instead of silently overwriting either side

## OS integration targets

### macOS

- install binary or shim
- store secrets in Keychain
- register background auto-start with `launchd`
- store app state under `~/.codex-handoff/`
- write logs under `~/.codex-handoff/logs/`

### Windows

- install binary or shim
- store secrets with DPAPI
- register auto-start with Task Scheduler or Startup task
- store app state under `~/.codex-handoff/`
- write logs under `~/.codex-handoff/logs/`

## Agent install contract for Codex

The install prompt that a user pastes into Codex should be intentionally short. Codex should infer and execute the following contract:

1. Check whether the product is already installed.
2. If missing, install it via the declared package manager command.
3. Run `codex-handoff doctor`.
4. Run remote login if no valid profile exists.
5. If the user asked to "sync" the current repo, align the current state first.
6. When the repo is not attached, use `install --skip-agent-start --skip-autostart`.
7. When the repo is already attached, use `sync now`.
8. When the user is resuming on another machine, use `receive --skip-agent-start --skip-autostart`.
9. Print a short state-alignment summary with repo slug, discovered thread count, remote prefix, and sync health.
10. Ask a short follow-up such as `Push 자동화를 켤까요?`
11. Only after explicit user approval should Codex register background auto-start and start the local agent.

## Non-goals for v1

- multiple remote providers
- cross-account merge logic
- syncing arbitrary user directories outside attached repos
- syncing every Codex session on disk without project scoping
- transcript upload directly from Codex internals without local memory files or explicit session scope
- certificate-based auth workflow for R2

## Current implementation status

Implemented today:

- local reader CLI
- `.codex-handoff` bootstrap model
- `remote login r2`, `remote whoami`, `remote validate`, `remote logout`
- macOS Keychain and Windows DPAPI credential strategy
- repo enable/attach metadata and managed `AGENTS.md` block updates
- local thread discovery plus thread-bundle export/import primitives
- repo-scoped sync push/pull/now/watch CLI scaffolding
- detached local `agent start/status/stop/restart` lifecycle around `sync watch`
- bundled `codex-handoff` skill install support for Codex bootstrap flows

Not yet implemented:

- npm package
- background sync agent registration
- auto-start registration
- richer remote repo matching prompts and state reconciliation
- production-grade conflict resolution
- Codex-driven summarization as the default background flow
