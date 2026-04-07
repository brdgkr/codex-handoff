# Codex Memory Bootstrap

Before doing substantive work in this repository:

1. Read `.codex-handoff/latest.md` first.
2. If the user asks to continue previous work, run `codex-handoff --repo . resume --goal "<user-goal>"`.
3. If the bootstrap summary is insufficient, inspect `.codex-handoff/handoff.json`.
4. Never load raw session jsonl files wholesale. Use `codex-handoff search`, `codex-handoff extract`, or `codex-handoff context-pack` to retrieve only relevant evidence.

Memory files are split by responsibility:

- `latest.md`: short current-state bootstrap summary
- `handoff.json`: structured restore state with goals, decisions, todos, files, and recent commands
- `raw/*.jsonl`: original evidence for audit and targeted retrieval

Preferred recovery flow:

1. Bootstrap from `latest.md`.
2. Restore structured state from `handoff.json`.
3. Search raw evidence only for the goal, files, or failures relevant to the current request.

Remote storage terminology:

- Use `remote` for the synchronized backend.
- The first supported remote provider is Cloudflare R2.
- Authenticate through `codex-handoff remote login r2`; do not assume certificate-based auth for R2.

<!-- codex-handoff:start -->
## Codex Handoff Sync

This repository is attached to codex-handoff sync.
- remote profile: `default`
- remote repo slug: `ideook-codex-handoff`
- remote prefix: `repos/ideook-codex-handoff/`
- summary mode: `auto`
- include raw threads: `true`
- match status: `existing_local`
- installed skill path: `C:\Users\DukhyunLee\.codex\skills\codex-handoff`

Before doing substantive work in this repository:
0. If the local `codex-handoff` skill is installed, use it for sync, pull, import, and resume orchestration.
1. Read `.codex-handoff/latest.md` first if it exists.
2. If the user asks to continue previous work, run `codex-handoff --repo . resume --goal "<user-goal>"`.
3. If the bootstrap summary is insufficient, inspect `.codex-handoff/handoff.json`.
4. Never load raw session jsonl files wholesale. Use `codex-handoff search`, `codex-handoff extract`, or `codex-handoff context-pack` to retrieve only relevant evidence.
<!-- codex-handoff:end -->
