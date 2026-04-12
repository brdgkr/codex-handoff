# Command Reference

This is the concise command reference for `codex-handoff`.

## Primary Commands

### `codex-handoff setup`

Attach or reconcile the current repo.

Typical use:

```bash
codex-handoff setup
```

### `codex-handoff receive`

Pull synced repo state on another machine and restore the selected thread
locally when possible.

```bash
codex-handoff receive
```

### `codex-handoff sync now`

Run a one-shot export and push for the current repo.

```bash
codex-handoff sync now
```

### `codex-handoff detach`

Detach the current repo from codex-handoff management.

```bash
codex-handoff detach
```

`codex-handoff uninstall` remains as a compatibility alias.

### `codex-handoff purge-local`

Remove local handoff artifacts from `.codex-handoff/` while preserving repo
credentials and repo attachment metadata.

Preview:

```bash
codex-handoff purge-local
```

Apply:

```bash
codex-handoff purge-local --apply
```

## Inspection

### `codex-handoff status`

Inspect local handoff artifacts.

### `codex-handoff doctor`

Inspect repo state, sync state, runtime state, and local prerequisites.

### `codex-handoff sync status`

Inspect sync health for the current repo.

### `codex-handoff memory status`

Inspect the optional root repo-level memory artifact. This is not part of the
default bootstrap read path, which stays inside `.codex-handoff/synced-threads/`.

### `codex-handoff memory summarize`

Run isolated AI-assisted summarization and atomically update
`.codex-handoff/memory.md`.

This command is optional and manual. The default bootstrap flow does not depend
on repo-root memory files.

By default this passes a compact deterministic `thread-digest.json` into the
isolated summarizer and does not copy full thread bundles. Use
`--max-threads <n>` only when deeper evidence is needed.

Current memory behavior is append-oriented: a stable repo summary is kept near
the top of `memory.md`, and newer conversation summaries are appended as
timestamped update blocks instead of regenerating the whole file each time.

### `codex-handoff agent status`

Inspect background agent and watcher state.

## Remote

### `codex-handoff remote login r2`

Validate or write Cloudflare R2 credentials into the current repo's
`.codex-handoff/.env.local`.

Useful variants:

- `--from-clipboard`
- `--from-env`
- `--dotenv ./.codex-handoff/.env.local`

### `codex-handoff remote whoami`

Show the current repo's active R2 credentials source.

### `codex-handoff remote validate`

Validate the active remote credentials.

### `codex-handoff remote logout`

Clear the current repo's `.codex-handoff/.env.local` credentials file.

### `codex-handoff remote repos`

List synced repo slugs visible in the remote backend.

### `codex-handoff remote purge-repo`

Delete the remote R2 prefix for one repo slug.

Preview:

```bash
codex-handoff remote purge-repo --repo-slug <slug>
```

Apply:

```bash
codex-handoff remote purge-repo --repo-slug <slug> --apply
```

## Agent Control

### `codex-handoff agent start`

Start the detached global background agent.

### `codex-handoff agent stop`

Stop the detached global background agent.

### `codex-handoff agent restart`

Restart the detached global background agent.

### `codex-handoff agent enable`

Enable login-time auto-start.

### `codex-handoff agent disable`

Disable login-time auto-start.

## Thread Tools

### `codex-handoff threads scan`

Find local Codex threads whose `cwd` matches the current repo.

### `codex-handoff threads export`

Export matching threads into `.codex-handoff/local-threads/`.

### `codex-handoff threads import`

Restore a bundled thread into local Codex state.

### `codex-handoff threads cleanup`

Remove restored local thread artifacts for a thread.

## Restore Tools

### `codex-handoff resume`

Generate a restore pack from local handoff state.

### `codex-handoff context-pack`

Explicit variant of `resume`.

### `codex-handoff search`

Search raw handoff evidence.

### `codex-handoff extract`

Print exact records for a session or turn.
