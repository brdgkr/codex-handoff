# Prompt Pack

These are short user-facing prompts for Codex when using `codex-handoff`.

The prompts are intentionally brief. Users should not need to know the internal
CLI flow. The skill is responsible for mapping these prompts to `setup`,
`receive`, `sync now`, and optional watcher automation.

## 1. Install And Start Sync

Use when nothing is installed yet and the user wants Codex to set everything up.

```text
Install `@brdgkr/codex-handoff` and start sync for this repository.
Do not stop at package installation. Finish the setup so it is actually ready to run.
```

## 2. Set Up This Repo

Use when the package is already installed but this repo is not set up yet.

```text
Set up codex-handoff sync for this repository.
```

## 3. Sync This Repo

Use when the repo is already set up and the user wants a one-shot sync.

```text
Sync this repository with codex-handoff.
```

## 4. Receive On Another Machine

Use when the user wants to continue work from another PC.

```text
Receive this repository with codex-handoff on another machine.
```

## 5. Update Package And Reconcile

Use after npm reinstall or upgrade.

```text
I updated codex-handoff. Reconcile this repository so it works again.
```

## 6. Enable Push Automation

Use only when the repo is already attached and the user explicitly wants ongoing
background sync.

```text
Enable codex-handoff push automation for this repository.
```

## 7. Disable Push Automation

```text
Disable codex-handoff push automation for this repository.
```

## 8. Remove From This Repo

Use when the user wants to detach this repo from codex-handoff management.

```text
Remove codex-handoff from this repository.
```

## Intent Mapping Notes

For maintainers reviewing this file:

- install prompt: package install, then `setup`
- repo setup prompt: `setup`
- sync prompt: `setup --skip-agent-start --skip-autostart` when unattached, `sync now` when already attached, `receive` when cross-machine resume is clear
- receive prompt: `receive`
- update prompt: package reinstall/upgrade lifecycle, then `setup`
- enable automation prompt: `agent enable` then `agent start`
- disable automation prompt: `agent stop`, optionally `agent disable`
- remove prompt: `uninstall`
