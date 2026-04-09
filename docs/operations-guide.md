# Operations Guide

This document describes the normal operating model for `codex-handoff`.

It is intended for maintainers and users who want to understand how the product
behaves after installation, during upgrades, and while background sync is
running.

## Runtime Model

`codex-handoff` runs two background processes:

- `agent_service.js`
  orchestrates lifecycle, detects whether Codex is open, performs startup sync,
  and starts or stops the watcher
- `watch_service.js`
  watches Codex rollout files, routes changes to repos, and triggers repo-scoped
  sync work

The agent should only keep the watcher alive while the Codex app itself is
running.

## Primary Lifecycle Events

### Package install or upgrade

When the npm package is installed or upgraded:

1. `preinstall` stops any running background agent and watcher
2. package files are replaced
3. `postinstall` restarts the agent automatically if it had previously been
   running

This avoids replacing package files while older service processes are still
executing from the previous installation.

### Repo setup

`codex-handoff setup` is the repo-scoped reconciliation command. It:

- ensures the repo is attached to codex-handoff
- aligns local and remote repo state
- updates managed `AGENTS.md` metadata
- updates auto-start configuration when enabled
- starts or restarts the background agent when appropriate

### Cross-machine receive

`codex-handoff receive` is the pull-oriented entry point for another machine. It
aligns state from the remote repo prefix and restores the selected thread into
the local Codex workspace when possible.

### Repo uninstall

`codex-handoff uninstall` detaches a repo from codex-handoff management.

Current behavior:

- removes the repo mapping from local config
- removes the managed `AGENTS.md` block from the repo
- removes the `.codex-handoff/` `.gitignore` entry
- preserves the local `.codex-handoff/` directory by default
- stops the background agent and disables auto-start when no managed repos
  remain

## Watch And Sync Flow

While Codex is open:

1. the agent detects the main Codex app process
2. the watcher monitors `~/.codex/sessions/**/rollout-*.jsonl`
3. rollout changes are mapped to repos using `session_meta.payload.cwd`
4. canonical user and assistant messages are extracted into thread bundles under
   `.codex-handoff/threads/`
5. the repo-scoped handoff tree is pushed to the configured remote prefix
6. sync results are recorded in `.codex-handoff/sync-state.json`

When the Codex app/window is no longer detected, the agent performs one final
producer pass before stopping the watcher:

1. export the repo's deterministic thread bundles again from local Codex state
2. run isolated AI-assisted memory summarization for `.codex-handoff/memory.md`
3. write `.codex-handoff/memory-state.json`
4. push the updated handoff tree to the remote so consumer PCs can read the
   compact root memory without scanning `.codex-handoff/threads/**`

## Important Files

### Local repo files

- `.codex-handoff/repo.json`
- `.codex-handoff/.env.local`
- `.codex-handoff/thread-index.json`
- `.codex-handoff/current-thread.json`
- `.codex-handoff/memory.md`
- `.codex-handoff/memory-state.json`
- `.codex-handoff/sync-state.json`
- `.codex-handoff/threads/*.json`

### Global runtime files

- `~/.codex-handoff/config.json`
- `~/.codex-handoff/runtime/agent-service.json`
- `~/.codex-handoff/runtime/watch-service.json`
- `~/.codex-handoff/runtime/watch-cursors.json`

### Global logs

- `~/.codex-handoff/logs/agent-service.log`
- `~/.codex-handoff/logs/watch-service.log`
- `~/.codex-handoff/logs/watch-events.log`
- `~/.codex-handoff/logs/watch-raw-events.log`
- `~/.codex-handoff/logs/watch-changed-files.log`
- `~/.codex-handoff/logs/watch-content.log`

## Health Checks

Useful commands:

```bash
codex-handoff doctor
codex-handoff agent status
codex-handoff sync status
codex-handoff remote whoami
codex-handoff remote validate
```

## Troubleshooting

### The watcher is running but nothing is syncing

Check:

- `codex-handoff agent status`
- `codex-handoff sync status`
- `watch-events.log`
- whether the repo is attached in `~/.codex-handoff/config.json`

### The agent was upgraded but behavior did not change

Run:

```bash
codex-handoff setup
```

This reconciles repo state on the new version and restarts the agent if needed.

### Codex window was closed but the watcher did not stop

The agent uses the main Codex app process for lifecycle detection. If the
watcher does not stop as expected, inspect:

- `agent-service.log`
- `agent-service.json`
- the current process list

### Package install and setup overlapped

The CLI uses a lifecycle lock to serialize `setup`, `receive`, and direct agent
restart operations. Package installation separately stops and restarts the
background services through npm lifecycle hooks.
