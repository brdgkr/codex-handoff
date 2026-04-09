---
name: codex-handoff
description: Project handoff and resume workflow for Codex repos that use `.codex-handoff` plus Cloudflare R2 sync. Use when a user wants to enable handoff sync for the current Codex project, receive synced work on another machine, match the current project to an R2 project, restore a thread into local `~/.codex/` state, or continue work from synced handoff files across PCs.
---

# Codex Handoff

Use this skill when the user wants to move Codex work between machines through the `codex-handoff` workflow.

## Core rule

Do not improvise the workflow by searching for files manually unless the CLI reports a concrete problem.

Package install alone is never a complete `codex-handoff` setup. If Codex installs or upgrades the npm package as part of the user's request, it must continue by running `codex-handoff setup` or `codex-handoff receive` for the target repo in the same flow.

Prefer these commands in order:

1. `codex-handoff --repo . doctor`
2. `codex-handoff --repo . setup`
3. `codex-handoff --repo . receive`
4. `codex-handoff --repo . agent start`

## Package-first bootstrap rule

When the user starts from "nothing installed yet" and asks Codex to set up sync:

1. Install the npm package first.
2. Let npm `postinstall` install the bundled `codex-handoff` skill.
3. Immediately continue by using this skill and running `codex-handoff --repo <target-repo> setup` or `codex-handoff --repo <target-repo> receive`.

Do not stop after npm package installation.

If the target repo is not the current working directory, find the target repo path first and use `--repo <path>` explicitly.

During development before npm publish, use the packed tarball path instead of the registry package name:

- `npm pack`
- `npm install -g ./brdgkr-codex-handoff-<version>.tgz`
- `codex-handoff --repo <target-repo> setup`

## Prompt mapping

Interpret short user prompts like this:

- "Install `@brdgkr/codex-handoff` and start sync for this repository."
  Install the npm package, then continue immediately into `setup` for the target repo.
- "Set up codex-handoff sync for this repository."
  Run `setup`.
- "Sync this repository with codex-handoff."
  If unattached, run `setup --skip-agent-start --skip-autostart`; if already attached, run `sync now`; if the user clearly means another machine, use `receive`.
- "Receive this repository with codex-handoff on another machine."
  Run `receive`.
- "I updated codex-handoff. Reconcile this repository so it works again."
  Assume npm package upgrade already happened or should happen first, then run `setup` so repo state is reconciled on the new version.
- "Enable codex-handoff push automation for this repository."
  Run `agent enable` and `agent start`.
- "Disable codex-handoff push automation for this repository."
  Run `agent stop`, then `agent disable` if the user wants auto-start disabled too.
- "Remove codex-handoff from this repository."
  Run `uninstall`.

## Interpreting "sync"

When the user says "sync this repo", do not jump straight to watcher mode.

First align the repo state:

- if the repo is not enabled yet, run:
  `codex-handoff --repo . setup --skip-agent-start --skip-autostart`
- if the repo is already enabled and the user is pushing current local work, run:
  `codex-handoff --repo . sync now`
- if the user is clearly resuming on another machine or asking to pull remote state first, run:
  `codex-handoff --repo . receive --skip-agent-start --skip-autostart`

After that, ask a short follow-up:

- `Do you want to enable automatic push sync?`

Only if the user says yes should you enable the watcher:

1. `codex-handoff --repo . agent enable`
2. `codex-handoff --repo . agent start`

If the user does not explicitly agree, stop after the one-shot sync and report the resulting state.

## Dotenv rule

The CLI should use this default auth file:

- `.codex-handoff/.env.local`

If a different file is needed, pass `--dotenv <path>` explicitly.

## A PC bootstrap

When the user wants to turn sync on in the current project, run:

`codex-handoff --repo . setup`

That command is the preferred bootstrap entry point. It is expected to:

- install the bundled `codex-handoff` skill
- enable the current project
- patch `AGENTS.md`
- choose pull or push automatically
- register auto-start when possible
- optionally start the detached watcher

If the user just installed or upgraded the npm package, npm install should stop and restart any running background agent automatically. `codex-handoff setup` is still required afterward to reconcile repo state on the new package version.

## B PC receive

When the user wants to continue on another machine, run:

`codex-handoff --repo . receive`

If the CLI returns `selection_required`, do this:

1. Show the current project information from the payload.
2. Show the remote candidate list from the payload.
3. Highlight the recommended remote project id when present.
4. Ask the user which remote project id to use.
5. Re-run:
   `codex-handoff --repo . receive --remote-slug <chosen-remote-project-id>`

Do not guess when the CLI says selection is required.

## R2 auth

Prefer not to paste secrets into the Codex chat.

Recommended sources:

- `.codex-handoff/.env.local`
- OS clipboard
- process environment variables

Useful commands:

- Show the Cloudflare setup URL and credential template:
  `codex-handoff remote login r2 --show-setup-info --open-dashboard`
- Login from the current repo dotenv file:
  `codex-handoff --repo . remote login r2 --dotenv ./.codex-handoff/.env.local`
- Login from a specific dotenv file:
  `codex-handoff remote login r2 --dotenv <path>`
- Login from clipboard:
  `codex-handoff remote login r2 --from-clipboard`

## Continue work

When the user asks to continue previous work in a synced repo:

1. Read `.codex-handoff/latest.md`
2. Read `.codex-handoff/memory.md` if it exists; it is the compact repo-level memory intended for new sessions.
3. If needed, inspect `.codex-handoff/handoff.json`
4. If the bootstrap summary is not enough, run:
   `codex-handoff --repo . resume --goal "<user-goal>"`
5. Keep evidence usage targeted through:
   - `codex-handoff --repo . search "<query>"`
   - `codex-handoff --repo . extract --session <id> --turn <id>`

## Safety rules

- Do not paste R2 secrets into the Codex chat when `.codex-handoff/.env.local`, clipboard, or env sources are available.
- Prefer `doctor`, `setup`, and `receive` over ad hoc filesystem searches.
- Pull before the first push on a new machine.
- Treat `.codex-handoff` as derived handoff state, not the original Codex source of truth.
- When the user only wants to continue from synced summaries, prefer `.codex-handoff/latest.md`, `.codex-handoff/memory.md`, and `.codex-handoff/handoff.json` over full raw thread restoration.
- Do not enumerate or bulk-read `.codex-handoff/threads/**`; inspect a specific thread only when memory, handoff state, or the user points to that exact thread.
