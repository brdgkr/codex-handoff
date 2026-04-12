# codex-handoff

> Keep Codex work portable across machines, repos, and sessions.

![node >=18](https://img.shields.io/badge/node-%E2%89%A518-2f6f44)
![backend cloudflare r2](https://img.shields.io/badge/backend-Cloudflare%20R2-f48120)
![platform macOS windows](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-4b5563)
![license mit](https://img.shields.io/badge/license-MIT-111827)

`codex-handoff` watches repo-related Codex sessions, builds repo-scoped handoff
memory under `.codex-handoff/`, and syncs that state to a remote backend so you
can resume on another machine with the right context already in place.

Codex is OpenAI's coding agent. OpenAI describes Codex as "a coding agent that
helps you build and ship with AI—powered by ChatGPT" and the Codex app as "a
command center for agentic coding." Download and learn more at
[openai.com/codex](https://openai.com/codex/) or read
[Introducing the Codex app](https://openai.com/index/introducing-the-codex-app/).

## Start With Codex

`codex-handoff` is built for repo-scoped, one-person handoff across machines.
It keeps pulled thread state under `.codex-handoff/synced-threads/`, keeps
local pushable thread state under `.codex-handoff/local-threads/`, and can run
background sync while Codex is open.

Open the Codex app in the project you want to manage, make sure that project is
the current workspace/cwd, and paste one of these prompts into the Codex chat.
Use the same setup-and-start prompt on another PC. Plain `setup` already
decides whether this repo should pull remote state or push local state.

Install if needed, then set up and start:

```text
Install or upgrade `@brdgkr/codex-handoff` with npm if needed, then set up codex-handoff for this repository and start the agent.
Finish only when setup has completed and the agent is running.
```

Set up and start when the package is already installed:

```text
Set up codex-handoff for this repository and start the agent.
Finish only when setup has completed and the agent is running.
```

Set up this repo without starting the agent yet:

```text
Set up codex-handoff sync for this repository, but do not start the agent yet.
```

## Remote Backend

The first supported backend is Cloudflare R2.

After the npm package is installed, `setup` needs valid R2 credentials for the
current repo. The two simplest auth paths are:

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

## Common Tasks

- Set up one repo and start background sync.
  Use a Codex prompt or run `codex-handoff setup`.
- Run a one-shot sync without relying on the background agent.
  Use `codex-handoff sync now`.
- Inspect or rebuild repo context when you need to understand current handoff
  state.
  Use `codex-handoff status`, `codex-handoff sync status`,
  `codex-handoff resume`, and `codex-handoff search`.
- Stop managing the current repo without deleting its cached data.
  Use `codex-handoff detach`.
- Remove local handoff files from `.codex-handoff/` while keeping credentials.
  Use `codex-handoff purge-local` and `codex-handoff purge-local --apply`.
- Delete one repo's remote backup from Cloudflare R2.
  Use `codex-handoff remote purge-repo --repo-slug <slug>` and add `--apply`
  to execute it.
- Stop or disable the background service on this machine.
  Use `codex-handoff agent stop` and `codex-handoff agent disable`.

## What It Stores

The repo-local state is intentionally simple:

- `.codex-handoff/synced-threads/`
  pulled thread payloads used for default restore reads, including
  `current-thread.json`, `thread-index.json`, and `threads/`
- `.codex-handoff/local-threads/`
  local thread payloads prepared for push
- `.codex-handoff/repo.json`
  repo-local control-plane state
- optional derived files such as `.codex-handoff/memory.md`
  manually generated repo memory artifacts that are not part of the default
  bootstrap read path. The current format keeps a stable repo summary near the
  top and appends timestamped conversation updates when new synced thread
  activity arrives.

Default restore reads stay inside `.codex-handoff/synced-threads/`. Start with
`current-thread.json`, then use `thread-index.json` to decide which specific
bundle under `threads/` to inspect next.

## Docs

- [Prompt Pack](docs/agent-install-prompts.md)
- [Command Reference](docs/command-reference.md)
- [Docs Index](docs/README.md)

## License

MIT
