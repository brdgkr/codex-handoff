# codex-handoff

> Keep Codex work portable across machines, repos, and sessions.

![node >=18](https://img.shields.io/badge/node-%E2%89%A518-2f6f44)
![backend cloudflare r2](https://img.shields.io/badge/backend-Cloudflare%20R2-f48120)
![platform macOS windows](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-4b5563)
![license mit](https://img.shields.io/badge/license-MIT-111827)

`codex-handoff` watches repo-related Codex sessions, builds repo-scoped handoff
memory under `.codex-handoff/`, and syncs that state to a remote backend so you
can resume on another machine with the right context already in place.

## Why

- repo-scoped instead of one giant session pool
- built for one-person, cross-machine handoff
- background sync while Codex is open
- thread payloads preserved separately under `.codex-handoff/synced-threads/` and `.codex-handoff/local-threads/`
- Cloudflare R2 support out of the box

## Start With Codex

The easiest way to use `codex-handoff` is to tell Codex what you want in plain
language.

Install and start sync for this repo:

```text
Install `@brdgkr/codex-handoff` and start sync for this repository.
Do not stop at package installation. Finish the setup so it is ready to run.
```

Set up this repo after the package is already installed:

```text
Set up codex-handoff sync for this repository.
```

Receive work on another machine:

```text
Receive this repository with codex-handoff on another machine.
```

Run a one-shot sync:

```text
Sync this repository with codex-handoff.
```

Enable background sync:

```text
Enable codex-handoff push automation for this repository.
```

Detach this repo:

```text
Remove codex-handoff from this repository.
```

## How It Works

`codex-handoff` keeps four main kinds of state:

- `.codex-handoff/memory.md`
  compact repo-level memory kept only at the repo root for new Codex sessions
- `.codex-handoff/synced-threads/`
  pulled thread payloads used for default restore reads
- `.codex-handoff/local-threads/`
  local thread payloads prepared for push
- `.codex-handoff/repo.json`
  repo-local control-plane state

Background sync is driven by a global watcher:

- it watches `~/.codex/sessions/**`
- routes rollout changes to the matching repo using `session_meta.payload.cwd`
- writes producer-side thread updates into `.codex-handoff/local-threads/`
- pushes local thread payloads to the configured remote prefix
- keeps running while the Codex app process is alive, including background window-hidden states
- keeps pulled remote thread state under `.codex-handoff/synced-threads/` as the default thread read cache

Repo-level memory flow:

- Producer PC watches Codex rollout changes and extracts deterministic thread
  bundles into `.codex-handoff/local-threads/threads/` without using AI.
- Producer PC does not summarize repo memory during conversation or shutdown.
- Producer shutdown does not rewrite `.codex-handoff/local-threads/`.
- Explicit pull flows regenerate root `.codex-handoff/memory.md` locally from
  `.codex-handoff/synced-threads/`.
- New Codex sessions should read `.codex-handoff/memory.md` first, and should not scan
  `.codex-handoff/synced-threads/threads/**` unless a memory source link points to a specific
  thread or the user asks for deeper evidence.
- Producer-side staged thread payloads are not part of the default bootstrap
  read path.

## Primary Commands

- `setup`
  bootstrap or reconcile a repo
- `receive`
  restore synced work on another machine
- `status`
  inspect local handoff state
- `resume`
  build a restore pack from local handoff state
- `memory summarize`
  update compact repo-level memory in `.codex-handoff/memory.md`
- `search`
  search raw handoff evidence
- `sync now`
  perform a one-shot export and push
- `uninstall`
  detach the repo from codex-handoff management

For the full command surface, see [docs/command-reference.md](docs/command-reference.md).

## Remote Backend

The first supported backend is Cloudflare R2.

Prompt-friendly auth path:

```bash
codex-handoff remote login r2 --from-clipboard
codex-handoff setup
```

File-based auth path:

```bash
codex-handoff remote login r2 --dotenv ./.codex-handoff/.env.local
codex-handoff setup
```

## Development

If you prefer direct CLI commands instead of prompt-first use, see:

- [Command Reference](docs/command-reference.md)

Before publishing to npm, test from a tarball:

```bash
TARBALL=$(npm pack --silent)
npm install -g "./$TARBALL"
codex-handoff --repo . setup
```

Run tests:

```bash
npm run test:node
```

## Docs

- [Manual Index](docs/README.md)
- [Command Reference](docs/command-reference.md)
- [Operations Guide](docs/operations-guide.md)
- [Prompt Pack](docs/agent-install-prompts.md)
- [Handoff JSON Schema](schemas/handoff.schema.json)

## License

MIT
