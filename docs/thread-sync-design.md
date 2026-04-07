# Thread Sync Design

This document defines the intended sync architecture for `codex-handoff`.

The target use case is serial handoff across machines for one human using Codex. The thing being handed off is not only a summary and not only a transcript. The remote payload must preserve:

- the original Codex session source needed to reconstruct a thread
- the derived handoff artifacts needed to resume work efficiently
- the normalized metadata needed to make the thread visible again in Codex on another machine

## Design decision

Default sync includes the original session document.

The remote source of truth for a thread is a normalized thread bundle, not a copied local SQLite database and not a copied local `session_index.jsonl`.

That bundle contains:

- raw source session content
- derived handoff files
- normalized metadata for Codex-local materialization

## What is actually synced

The product should not sync arbitrary folders.

The sync inputs are:

- repo-local `.codex-handoff/`
- Codex session jsonl files for threads related to the repo
- thread metadata discovered from the local thread list and session index

The sync should not use SQLite as the remote source of truth.
SQLite is read locally to discover thread metadata and written locally again on pull so Codex can see the restored thread.

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
      manifest.json
      latest.md
      handoff.json
      raw/
        session.jsonl
      source/
        rollout.jsonl.gz
        index-entry.json
        thread-record.json
  sync-state.json
  conflicts/
```

Rules:

- `.codex-handoff/threads/<thread-id>/...` is the persistent local mirror for that thread
- root `latest.md`, `handoff.json`, and `raw/session.jsonl` are a materialized view of the currently selected thread
- `source/` stores the original session source plus normalized Codex metadata needed for local reconstruction
- the existing reader CLI continues to read the root view

## Thread bundle contents

Each thread bundle should contain:

- `manifest.json`
  - `thread_id`
  - `thread_title`
  - `thread_name`
  - `cwd`
  - `rollout_path`
  - `updated_at`
  - `source_session_relpath`
  - `source_session_sha256`
  - `revision`
  - `parent_revision`
  - `machine_id`
  - `model_provider`
- `latest.md`
  - short current-state summary for that thread
- `handoff.json`
  - structured restore state for that thread
- `raw/session.jsonl`
  - normalized reader evidence for that thread
  - should include the important extracted evidence plus the recent conversational tail
- `source/rollout.jsonl.gz`
  - compressed original Codex session jsonl
- `source/index-entry.json`
  - normalized representation of the `session_index.jsonl` entry required for local materialization
- `source/thread-record.json`
  - normalized representation of the SQLite `threads` row required for local materialization

This keeps all three needed views of the same work:

- the original source conversation
- the derived handoff state
- the Codex-local metadata needed to surface the thread in the UI

## Remote layout

The remote bucket should be keyed by repo identity first and thread id second.

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

- `manifest.json` stores repo-level metadata and sync revision info
- `thread-index.json` lists known threads for the repo
- `current-thread.json` points to the thread that should be materialized after pull

## Attach and scan model

The user-facing unit is the repo.
The sync unit is the thread bundle.

Attach flow:

1. User runs `codex-handoff install --repo <path>` or `codex-handoff attach --repo <path>`.
2. `codex-handoff` records the repo slug and remote prefix.
3. `codex-handoff threads scan --repo <path>` reads local thread metadata.
4. Threads whose `cwd` matches the repo are candidates for sync.
5. The selected thread bundles are exported under `.codex-handoff/threads/`.

## Push model

On the source machine:

1. Discover repo-related threads from local SQLite and session index data.
2. Read the original session jsonl path for each thread.
3. Extract normalized metadata for `session_index.jsonl` and the SQLite `threads` row.
4. Generate thread-specific `latest.md`, `handoff.json`, and `raw/session.jsonl`.
5. Compress the original session jsonl as `source/rollout.jsonl.gz`.
6. Upload the thread bundle to the repo-specific prefix in R2.

## Pull and materialize model

On another machine:

1. Pull the repo prefix from R2.
2. Store each remote thread bundle under `.codex-handoff/threads/<thread-id>/`.
3. Restore `source/rollout.jsonl.gz` into the appropriate `~/.codex/sessions/...` location.
4. Upsert `source/index-entry.json` into local `~/.codex/session_index.jsonl`.
5. Upsert `source/thread-record.json` into local `~/.codex/state_5.sqlite`.
6. Read `current-thread.json`.
7. Materialize that thread's `latest.md`, `handoff.json`, and `raw/session.jsonl` into the root `.codex-handoff/`.
8. Verify that the thread is visible in Codex and that the reader CLI can run against the root view.

This lets both recovery paths work:

- Codex can see the restored thread through its own local storage
- `codex-handoff` can immediately bootstrap from the root `.codex-handoff/` view

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
- keep `source/rollout.jsonl.gz` immutable for a given revision
- if both sides changed thread summaries, keep both and write a conflict snapshot
- never silently overwrite a remote thread bundle that advanced after the last local pull
- never treat copied local SQLite or `session_index.jsonl` files as the remote source of truth
- always rebuild local Codex-visible records from normalized bundle metadata
