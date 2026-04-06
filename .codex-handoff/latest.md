# Current State

- The local `codex-handoff` reader CLI is working.
- R2 remote auth profile support exists for macOS and Windows credential storage.
- The install UX is now defined as repo attach plus thread-bundle sync across machines.
- The next implementation target is npm install plus background sync for thread-specific session bundles under `.codex-handoff/threads/`.
- Bootstrap should stay short enough for Codex to read first on every turn.

# Immediate Goal

Implement the npm installer and background agent so one machine can push repo-related thread bundles to Cloudflare R2 and another machine can pull and materialize them before resuming work.
