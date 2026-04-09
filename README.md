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
- thread bundles preserved separately under `.codex-handoff/threads/`
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

- `.codex-handoff/latest.md`
  short bootstrap summary
- `.codex-handoff/memory.md`
  compact repo-level memory for new Codex sessions
- `.codex-handoff/handoff.json`
  structured restore state
- `.codex-handoff/threads/*.json`
  detailed thread bundles used only when deeper evidence is needed

Background sync is driven by a global watcher:

- it watches `~/.codex/sessions/**`
- routes rollout changes to the matching repo using `session_meta.payload.cwd`
- updates repo thread bundles locally
- pushes the repo-scoped handoff tree to the configured remote prefix

Repo-level memory flow:

- Producer PC watches Codex rollout changes and extracts deterministic thread
  bundles under `.codex-handoff/threads/` without using AI.
- When Codex no longer has an active window, Producer PC performs one final
  deterministic thread export, then runs AI-assisted memory summarization in an
  isolated temporary working directory using selected handoff inputs. The
  summarizer receives a compact deterministic `thread-digest.json` by default,
  not the full thread bundle set.
- After validation, the summarizer atomically replaces
  `.codex-handoff/memory.md`; temporary files are not the synchronized output.
- Sync pushes `.codex-handoff/memory.md` and related handoff state to the remote.
- Consumer PC pulls that memory into its local `.codex-handoff/` directory.
- New Codex sessions should read `.codex-handoff/latest.md` and
  `.codex-handoff/memory.md` first, and should not scan
  `.codex-handoff/threads/**` unless a memory source link points to a specific
  thread or the user asks for deeper evidence.

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
- [Agent Install UX](docs/agent-install-ux.md)
- [Prompt Pack](docs/agent-install-prompts.md)
- [npm Installer Spec](docs/npm-installer-spec.md)
- [Global Watcher Architecture](docs/global-watcher-architecture.md)
- [Thread Sync Design](docs/thread-sync-design.md)
- [Handoff JSON Schema](schemas/handoff.schema.json)

## License

MIT
