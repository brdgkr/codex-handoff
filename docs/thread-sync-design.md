# Thread Sync Design

This document captures the intended sync architecture for `codex-handoff` based on the current local Codex storage model.

## What is actually synced

The product should not sync arbitrary folders.

The sync inputs are:

- repo-local `.codex-handoff/`
- Codex session jsonl files for threads related to the repo
- thread metadata from the local thread list and session index

The sync should not use SQLite as the remote source of truth.
SQLite may be read locally to discover thread metadata such as:

- thread id
- thread title
- cwd
- rollout path
- updated timestamp

## Local Codex sources

Expected local discovery sources:

- `~/.codex/state_5.sqlite`
  - `threads` table
  - used to discover `id`, `title`, `cwd`, `rollout_path`, `updated_at`
- `~/.codex/session_index.jsonl`
  - used to discover `thread_name`, `id`, `updated_at`
- `~/.codex/sessions/.../*.jsonl`
  - original Codex session data

## Local handoff layout

`codex-handoff` should keep both a per-thread store and a root materialized view.

```text
.codex-handoff/
  repo.json
  latest.md
  handoff.json
  raw/
    session.jsonl
  threads/
    <thread-id>/
      thread.json
      latest.md
      handoff.json
      raw/
        session.jsonl
      source/
        rollout.jsonl.gz
  sync-state.json
  conflicts/
```

Rules:

- `.codex-handoff/threads/<thread-id>/...` is the persistent local mirror for that thread
- root `latest.md`, `handoff.json`, and `raw/session.jsonl` are a materialized view of the currently selected thread
- the existing reader CLI continues to read the root view

## Thread bundle contents

Each thread bundle should contain:

- `thread.json`
  - `thread_id`
  - `thread_title`
  - `thread_name`
  - `cwd`
  - `rollout_path`
  - `updated_at`
  - `source`
  - `model_provider`
- `latest.md`
  - short current-state summary for that thread
- `handoff.json`
  - structured restore state for that thread
- `raw/session.jsonl`
  - normalized raw evidence extracted for reader usage
- `source/rollout.jsonl.gz`
  - compressed original Codex session jsonl

This keeps both:

- the original source data
- the summarized handoff data

## Remote layout

The remote bucket should be keyed by repo identity first and thread id second.

```text
repos/<repo-slug>/
  manifest.json
  thread-index.json
  current-thread.json
  threads/
    <thread-id>/
      thread.json
      latest.md
      handoff.json
      raw/session.jsonl
      source/rollout.jsonl.gz
```

Where:

- `manifest.json` stores repo-level metadata and sync revision info
- `thread-index.json` lists known threads for the repo
- `current-thread.json` points to the thread that should be materialized into the root `.codex-handoff/` view after pull

## Attach and scan model

The user-facing unit is the repo.
The sync unit is the thread bundle.

Attach flow:

1. User runs `codex-handoff install --repo <path>` or `codex-handoff attach --repo <path>`
2. `codex-handoff` records the repo slug and remote prefix
3. `codex-handoff threads scan --repo <path>` reads local thread metadata
4. Threads whose `cwd` matches the repo are candidates for sync
5. The selected thread bundles are exported under `.codex-handoff/threads/`

## Pull and materialize model

On another machine:

1. Pull the repo prefix from R2
2. Store each remote thread bundle under `.codex-handoff/threads/<thread-id>/`
3. Read `current-thread.json`
4. Materialize that thread's `latest.md`, `handoff.json`, and `raw/session.jsonl` into the root `.codex-handoff/`
5. Run the existing reader commands against the root view

This lets Codex keep using the same bootstrap flow:

- read `.codex-handoff/latest.md`
- optionally run `codex-handoff resume`

## Agent commands

Recommended future command surface:

- `codex-handoff install --repo <path>`
- `codex-handoff attach --repo <path>`
- `codex-handoff threads scan --repo <path>`
- `codex-handoff threads list --repo <path>`
- `codex-handoff threads export --repo <path> --thread <id>`
- `codex-handoff threads use --repo <path> --thread <id>`
- `codex-handoff sync push --repo <path>`
- `codex-handoff sync pull --repo <path>`
- `codex-handoff sync now --repo <path>`
- `codex-handoff agent start`
- `codex-handoff agent status`

## Conflict policy

This product is for serial handoff between machines.

Conflict rules:

- always pull before first push on a machine
- keep the original `source/rollout.jsonl.gz` immutable once uploaded for a revision
- if both sides changed thread summaries, keep both and write a conflict snapshot
- never silently overwrite a remote thread bundle that advanced after the last local pull
