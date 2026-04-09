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

### `codex-handoff uninstall`

Detach the current repo from codex-handoff management.

```bash
codex-handoff uninstall
```

## Inspection

### `codex-handoff status`

Inspect local handoff artifacts.

### `codex-handoff doctor`

Inspect repo state, sync state, runtime state, and local prerequisites.

### `codex-handoff sync status`

Inspect sync health for the current repo.

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

Export matching threads into `.codex-handoff/threads/`.

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
