# codex-handoff

`codex-handoff` is a local reader CLI for bootstrapping and restoring Codex context from synchronized memory files.

The workflow is built around three file roles:

- `.codex-handoff/latest.md`: short bootstrap summary that should always be read first
- `.codex-handoff/handoff.json`: structured state for deterministic restore
- `.codex-handoff/raw/*.jsonl`: raw turn evidence searched on demand

## Quick start

```bash
codex-handoff --repo . status
codex-handoff --repo . resume --goal "지난번 scene evidence 정리 이어서"
codex-handoff --repo . search "scene-evidence"
codex-handoff --repo . extract --session sess-video-2026-04-06 --turn turn-003
codex-handoff remote login r2 --profile default
codex-handoff remote whoami
```

## Current scope vs next scope

Current scope in this repository:

- local reader CLI
- local memory bootstrap model
- Cloudflare R2 remote auth profile management
- repo enable/attach metadata and managed `AGENTS.md` block updates
- local thread discovery and thread-bundle export/import primitives
- repo-scoped sync push/pull/now/watch command scaffolding
- npm package skeleton with Node bin wrapper and postinstall skill install

Next scope being designed:

- npm wrapper package
- background sync agent registration
- richer conflict handling and remote repo matching UX
- Codex-driven summary generation as the default background path

## Target handoff flow

The intended product experience is serial handoff across machines, not generic collaboration sync.

The unit the user thinks about is the repository, but the unit that actually syncs is the thread bundle:

- the original Codex session jsonl for a thread
- normalized thread metadata discovered from the local thread list and session index
- a summarized handoff view for that same thread

The target flow is:

1. On machine A, install `codex-handoff`, authenticate to Cloudflare R2, and attach the current repo.
2. `codex-handoff` scans the local Codex thread list and session index, finds threads whose `cwd` matches the repo, and exports thread bundles with both source logs and handoff files.
3. The local agent syncs those thread bundles plus the repo-local `.codex-handoff/` view to R2.
4. On machine B, install `codex-handoff`, authenticate to the same R2 remote, attach the same repo, and pull the latest thread bundles into `.codex-handoff/threads/`.
5. `codex-handoff` restores the selected thread's original session source and normalized metadata into local `~/.codex/` storage so the thread is visible in Codex.
6. `codex-handoff` materializes the selected thread into the root `.codex-handoff/` files so Codex can immediately read `latest.md` and continue.

The product should optimize for one person moving between machines, so pull-before-push and conflict snapshots matter more than real-time multi-user collaboration.

## Commands

- `status`: show which memory artifacts are present and how much raw evidence is available
- `install`: bootstrap the repo in one flow by enabling sync and optionally starting the detached agent
- `doctor`: show local prerequisites and current codex-handoff setup health
- `enable`: attach the current repo to codex-handoff sync, save repo metadata, and patch `AGENTS.md`
- `resume`: build a compressed restore pack from `latest.md`, `handoff.json`, and ranked raw evidence
- `context-pack`: same restore engine as `resume`, but named for explicit pack generation
- `search`: search raw jsonl evidence without reading whole files into Codex
- `extract`: print exact raw records for a specific session or turn id
- `threads scan`: list local Codex threads whose `cwd` matches the current repo
- `threads export`: export matching local Codex threads under `.codex-handoff/threads/<thread-id>/`
- `threads import`: materialize a bundled thread back into the local `~/.codex/` store
- `remote login r2`: register a Cloudflare R2 backend profile and store credentials locally
- `remote login r2 --from-clipboard`: read a copied credential block from the OS clipboard
- `remote login r2 --from-env`: read credentials from environment variables for scripted setup
- `remote login r2 --dotenv ~/.codex-handoff/.env.local`: read credentials from the default global dotenv file
- `remote login r2 --show-setup-info --open-dashboard`: show the Cloudflare R2 dashboard URL and open it in a browser
- `remote whoami`: inspect the active remote profile
- `remote validate`: test stored R2 credentials with a signed API call
- `remote logout`: remove the local remote profile and its stored secret
- `remote repos`: list remote repo slugs already present in R2, optionally with remote metadata
- `sync push`: upload the local `.codex-handoff/` tree to the configured remote prefix
- `sync pull`: download the remote `.codex-handoff/` tree and optionally materialize a thread into local Codex state
- `sync now`: export local repo threads and push them immediately
- `sync watch`: poll local Codex/session changes and push updates continuously
- `agent start|status|stop|restart`: manage a detached local watcher for an enabled repo
- `skill install|status`: install the bundled `codex-handoff` skill into the local Codex skills directory

## Interpreting "Sync This Repo"

When the user asks Codex to "sync this repo", the product should split that intent into two phases:

1. Align the current repo state with the remote.
2. Ask whether to enable push automation.

The default interpretation should be:

- if the repo is not attached yet, run `codex-handoff --repo . install --skip-agent-start --skip-autostart`
- if the repo is already attached, run `codex-handoff --repo . sync now`
- if the user is clearly asking to continue on another machine, run `codex-handoff --repo . receive --skip-agent-start --skip-autostart`

After the state is aligned, Codex should ask a short follow-up such as:

`Push 자동화를 켤까요?`

Only if the user agrees should Codex enable auto-start and start the watcher:

- `codex-handoff --repo . agent enable`
- `codex-handoff --repo . agent start`

## Repository layout

```text
.codex-handoff/
  latest.md
  handoff.json
  raw/
    session-2026-04-06.jsonl
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
schemas/
  handoff.schema.json
```

The root `.codex-handoff/` files are the active materialized view.
Thread-specific copies live under `.codex-handoff/threads/<thread-id>/`.
The `source/` files are the planned materialization input for local Codex thread visibility on another machine.

## AGENTS bootstrap

The repository includes an `AGENTS.md` that instructs Codex to:

1. Read `.codex-handoff/latest.md` before substantive work.
2. Use `codex-handoff resume` when the user asks to continue work from another machine.
3. Search raw jsonl through the CLI instead of loading entire files directly.

## Remote Backend

Use `remote` as the product term for the synchronized storage backend. The first supported provider is Cloudflare R2.

The current product model is intentionally single-remote:

- one user-level remote profile only
- one shared backend bucket per user setup
- projects are separated inside that one remote by repo slug, not by separate remote profiles

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

- cross-platform default: `~/.codex-handoff/config.json`

### Example

```bash
codex-handoff remote login r2 \
  --profile default \
  --account-id <cloudflare-account-id> \
  --bucket <bucket-name> \
  --access-key-id <r2-access-key-id>

codex-handoff remote validate --profile default
codex-handoff remote whoami
```

On login, the CLI performs a signed `ListObjectsV2` request against R2 unless `--skip-validate` is passed.

Recommended prompt-friendly auth path:

- Copy a small credential block to the clipboard.
- Ask Codex to run `codex-handoff remote login r2 --from-clipboard`.
- Then ask Codex to run `codex-handoff --repo . enable --login-if-needed --auth-source clipboard --sync-now`.

This keeps the secret out of the Codex chat transcript while still allowing a one-prompt setup flow.

If you prefer a file-based path, keep the secret in the global codex-handoff dotenv file and use:

- `codex-handoff remote login r2 --dotenv ~/.codex-handoff/.env.local`
- `codex-handoff --repo . install --login-if-needed --auth-source dotenv`

The npm skeleton now supports the intended install shape:

```bash
npm install -g @brdg/codex-handoff
codex-handoff install
```

The global install wrapper forwards into the bundled Python engine and runs an npm postinstall step that copies the bundled `codex-handoff` skill into `~/.codex/skills/codex-handoff`.

## Planned sync model

The current code now implements the first CLI scaffolding for thread-bundle export/import and remote sync. The next implementation target is:

- discover repo-related threads from the local Codex thread list and session index
- read the original session jsonl path for each thread
- generate thread-specific `latest.md`, `handoff.json`, and `raw/session.jsonl`
- store normalized `session_index` and SQLite thread metadata alongside the source session
- store those under `.codex-handoff/threads/<thread-id>/`
- upload thread bundles to a repo-specific prefix in R2
- pull thread bundles on another machine, materialize the local Codex thread source and metadata, and then materialize one thread back to the root `.codex-handoff/` view
- add background watcher/service registration and remote repo matching prompts

## Agent-first install UX docs

The installer and operating experience are specified here:

- [docs/agent-install-ux.md](docs/agent-install-ux.md)
- [docs/agent-install-prompts.md](docs/agent-install-prompts.md)
- [docs/npm-installer-spec.md](docs/npm-installer-spec.md)

## `handoff.json` schema

The JSON Schema lives at [schemas/handoff.schema.json](schemas/handoff.schema.json).

The sample handoff file lives at [.codex-handoff/handoff.json](.codex-handoff/handoff.json).
