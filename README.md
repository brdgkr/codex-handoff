# codex-handoff

`codex-handoff` is a local reader CLI for bootstrapping and restoring Codex context from synchronized memory files.

The workflow is built around three file roles:

- `.codex-handoff/latest.md`: short bootstrap summary that should always be read first
- `.codex-handoff/handoff.json`: structured state for deterministic restore
- `.codex-handoff/raw/*.jsonl`: raw turn evidence searched on demand

## Quick start

```bash
python3 -m codex_handoff status --repo .
python3 -m codex_handoff resume --repo . --goal "지난번 scene evidence 정리 이어서"
python3 -m codex_handoff search --repo . "scene-evidence"
python3 -m codex_handoff extract --repo . --session sess-video-2026-04-06 --turn turn-003
python3 -m codex_handoff remote login r2 --profile default
python3 -m codex_handoff remote whoami
```

To install a local command:

```bash
python3 -m pip install -e .
codex-handoff status --repo .
```

## Current scope vs next scope

Current scope in this repository:

- local reader CLI
- local memory bootstrap model
- Cloudflare R2 remote auth profile management

Next scope being designed:

- agent-first installer UX
- npm wrapper package
- background sync agent
- repo attach and sync lifecycle

## Target handoff flow

The intended product experience is serial handoff across machines, not generic collaboration sync.

The unit the user thinks about is the repository, but the unit that actually syncs is the thread bundle:

- the original Codex session jsonl for a thread
- thread metadata discovered from the local thread list and session index
- a summarized handoff view for that same thread

The target flow is:

1. On machine A, install `codex-handoff`, authenticate to Cloudflare R2, and attach the current repo.
2. `codex-handoff` scans the local Codex thread list and session index, finds threads whose `cwd` matches the repo, and exports thread bundles.
3. The local agent syncs those thread bundles plus the repo-local `.codex-handoff/` view to R2.
4. On machine B, install `codex-handoff`, authenticate to the same R2 remote, attach the same repo, and pull the latest thread bundles into `.codex-handoff/threads/`.
5. `codex-handoff` materializes the selected thread into the root `.codex-handoff/` files so Codex can immediately read `latest.md` and continue.

The product should optimize for one person moving between machines, so pull-before-push and conflict snapshots matter more than real-time multi-user collaboration.

## Commands

- `status`: show which memory artifacts are present and how much raw evidence is available
- `resume`: build a compressed restore pack from `latest.md`, `handoff.json`, and ranked raw evidence
- `context-pack`: same restore engine as `resume`, but named for explicit pack generation
- `search`: search raw jsonl evidence without reading whole files into Codex
- `extract`: print exact raw records for a specific session or turn id
- `remote login r2`: register a Cloudflare R2 backend profile and store credentials locally
- `remote whoami`: inspect the active remote profile
- `remote validate`: test stored R2 credentials with a signed API call
- `remote logout`: remove the local remote profile and its stored secret

## Repository layout

```text
.codex-handoff/
  latest.md
  handoff.json
  raw/
    session-2026-04-06.jsonl
  threads/
    <thread-id>/
      thread.json
      latest.md
      handoff.json
      raw/
        session.jsonl
      source/
        rollout.jsonl.gz
schemas/
  handoff.schema.json
```

The root `.codex-handoff/` files are the active materialized view.
Thread-specific copies live under `.codex-handoff/threads/<thread-id>/`.

## AGENTS bootstrap

The repository includes an `AGENTS.md` that instructs Codex to:

1. Read `.codex-handoff/latest.md` before substantive work.
2. Use `codex-handoff resume` when the user asks to continue work from another machine.
3. Search raw jsonl through the CLI instead of loading entire files directly.

## Remote Backend

Use `remote` as the product term for the synchronized storage backend. The first supported provider is Cloudflare R2.

Why `remote`:

- it keeps the local reader and the sync backend separate
- it leaves room for other providers later without renaming the user-facing concept
- it matches commands like `remote login`, `remote validate`, and later `sync push/pull`

### R2 authentication model

R2 does not use a client certificate flow for this use case. The standard auth model is:

- `account_id`
- `access_key_id`
- `secret_access_key`
- `bucket`
- endpoint `https://<account_id>.r2.cloudflarestorage.com`
- region `auto`

The CLI uses a login-style flow and stores secrets locally with OS-native protection:

- macOS: Keychain via the `security` CLI
- Windows: DPAPI-protected blob via PowerShell

The shared metadata is stored in a local config file:

- macOS: `~/Library/Application Support/codex-handoff/config.json`
- Windows: `%APPDATA%\\codex-handoff\\config.json`

### Example

```bash
python3 -m codex_handoff remote login r2 \
  --profile default \
  --account-id <cloudflare-account-id> \
  --bucket <bucket-name> \
  --access-key-id <r2-access-key-id>

python3 -m codex_handoff remote validate --profile default
python3 -m codex_handoff remote whoami
```

On login, the CLI performs a signed `ListObjectsV2` request against R2 unless `--skip-validate` is passed.

## Planned sync model

The current code does not implement sync yet. The next implementation target is:

- discover repo-related threads from the local Codex thread list and session index
- read the original session jsonl path for each thread
- generate thread-specific `latest.md`, `handoff.json`, and `raw/session.jsonl`
- store those under `.codex-handoff/threads/<thread-id>/`
- upload thread bundles to a repo-specific prefix in R2
- pull thread bundles on another machine and materialize one thread back to the root `.codex-handoff/` view

## Agent-first install UX docs

The installer and operating experience are specified here:

- [docs/agent-install-ux.md](/Users/dukhyunlee/development/repos/brdg-kr/codex-handoff/docs/agent-install-ux.md)
- [docs/agent-install-prompts.md](/Users/dukhyunlee/development/repos/brdg-kr/codex-handoff/docs/agent-install-prompts.md)
- [docs/npm-installer-spec.md](/Users/dukhyunlee/development/repos/brdg-kr/codex-handoff/docs/npm-installer-spec.md)

## `handoff.json` schema

The JSON Schema lives at [schemas/handoff.schema.json](/Users/dukhyunlee/development/repos/brdg-kr/codex-handoff/schemas/handoff.schema.json).

The sample handoff file lives at [.codex-handoff/handoff.json](/Users/dukhyunlee/development/repos/brdg-kr/codex-handoff/.codex-handoff/handoff.json).
