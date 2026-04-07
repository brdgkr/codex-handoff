# Agent Prompt Pack

These are ready-to-paste prompts for Codex when using `codex-handoff`.

The key UX rule is:

1. First align the current repo state.
2. Then ask whether to enable push automation.
3. Start the watcher only after explicit user approval.

## 1. Sync This Repo

Use this when the user wants the current repo synced but has not explicitly asked for a watcher.

```text
이 저장소를 codex-handoff로 동기화해줘.

먼저 상태를 맞춰:
- repo가 아직 attach 안 되어 있으면 `codex-handoff --repo . install --skip-agent-start --skip-autostart`
- 이미 attach 되어 있으면 `codex-handoff --repo . sync now`
- 다른 PC에서 이어받는 맥락이면 `codex-handoff --repo . receive --skip-agent-start --skip-autostart`

상태를 맞춘 뒤에는 결과만 요약하고, watcher는 바로 켜지 말고
`Push 자동화를 켤까요?`
라고 먼저 물어봐.
```

## 2. Sync And Ask About Automation

Use this when the user already expects the follow-up prompt.

```text
이 저장소를 codex-handoff로 동기화해줘.
먼저 현재 상태를 맞추고, 끝나면 `Push 자동화를 켤까요?` 라고 물어봐.
내가 그렇다고 답하면 그때 `codex-handoff --repo . agent enable`과 `codex-handoff --repo . agent start`를 실행해.
```

## 3. Enable Push Automation

Use this only after the repo is already attached and the user explicitly wants the watcher.

```text
이 저장소에서 push 자동화를 켜줘.
`codex-handoff --repo . agent enable`과 `codex-handoff --repo . agent start`를 실행하고,
watcher와 autostart 상태를 짧게 알려줘.
```

## 4. Disable Push Automation

```text
이 저장소에서 push 자동화를 꺼줘.
`codex-handoff --repo . agent stop`과 필요하면 `codex-handoff --repo . agent disable`까지 실행하고,
남아 있는 watcher가 없는지 확인해줘.
```

## 5. Receive On Another Machine

Use this when the user is clearly trying to continue from another PC.

```text
이 저장소를 다른 PC에서 이어받게 동기화해줘.
`codex-handoff --repo . receive --skip-agent-start --skip-autostart`로 먼저 상태를 맞추고,
끝나면 `Push 자동화를 켤까요?` 라고 물어봐.
내가 동의하면 그때 watcher를 켜.
```

## 6. First Push For A New Repo

Use this when the user wants to upload a repo to R2 for the first time.

```text
이 저장소를 codex-handoff로 처음 R2에 올려줘.
`codex-handoff --repo . install --skip-agent-start --skip-autostart`로 먼저 상태를 맞추고,
같은 repo slug가 R2에 없으면 first push를 해.
끝나면 repo slug, remote prefix, sync action을 요약하고
`Push 자동화를 켤까요?`
라고 물어봐.
```

## Expected Summary Shape

After the one-shot sync step, the report should stay short:

```text
동기화 완료
- repo: <repo-slug>
- action: <push|pull>
- remote_prefix: repos/<repo-slug>/
- watcher: not started
- next: push 자동화 여부 확인 대기
```
