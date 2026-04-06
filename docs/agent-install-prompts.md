# Agent Install Prompt Pack

These are ready-to-paste prompt snippets for the future installer-driven experience. They are written for Codex to execute, not for humans to manually follow line by line.

They assume the product ships an npm package later. Until then, treat these as product copy and installer UX content, not live commands.

## 1. Minimal install prompt

Use this when the user wants the shortest possible install request.

```text
codex-handoff를 이 PC에 설치해.
Cloudflare R2를 remote로 쓰고 싶다.
현재 저장소를 attach하고, 이 저장소와 관련된 Codex thread들을 찾아서 thread별로 sync해.
원본 session jsonl도 올리고 thread별 요약(latest.md, handoff.json)도 같이 올려.
필요한 패키지 설치, 로그인, 초기 pull, 백그라운드 에이전트 등록과 시작까지 끝내고 상태를 요약해.
```

## 2. Install and attach current repo

Use this when the user wants the current repository to start syncing immediately.

```text
codex-handoff를 설치해.
Cloudflare R2 remote 인증까지 진행하고,
이 저장소를 attach하고,
로컬 thread list와 session index를 읽어서 이 저장소와 관련된 thread들을 찾아.
각 thread에 대해 원본 session jsonl과 요약된 handoff 파일을 `.codex-handoff/threads/<thread-id>/`로 만들어.
백그라운드 에이전트를 등록해서 로그인 후 자동 시작되게 해.
끝나면 repo slug, 발견된 thread 수, remote prefix, health check 결과만 알려줘.
```

## 3. New machine restore prompt

Use this on a second machine after login is required again.

```text
이 PC에 codex-handoff를 설치하고 같은 Cloudflare R2 remote로 로그인해.
백그라운드 sync agent를 등록하고 시작해.
현재 저장소를 attach한 다음 remote 최신 thread bundle들을 먼저 pull해.
다운받은 thread들을 `.codex-handoff/threads/` 아래에 저장하고,
현재 이어갈 thread 하나를 루트 `.codex-handoff/`에 materialize해.
local 변경이 이미 있으면 안전하게 비교해서 conflict snapshot을 남기거나 병합한 뒤 최신 상태로 맞춰.
끝나면 resume에 바로 쓸 수 있게 현재 sync 상태와 마지막 pull 결과만 짧게 알려줘.
```

## 4. Explicit npm-driven prompt

Use this when the package name is known and the user wants Codex to perform the install.

```text
아래 방식으로 codex-handoff를 설치해.
- npm global install이 필요하면 먼저 준비해
- 예시 설치 명령: `npm install -g @brdg/codex-handoff`
- 설치 후 `codex-handoff install --repo <current-repo>` 흐름이 되도록 진행해
- `doctor`, Cloudflare R2 remote login, repo attach, thread scan, initial pull, agent 자동 시작 등록, agent 실행을 순서대로 끝내
- 현재 repo와 관련된 Codex thread들만 sync하고 전체 세션은 건드리지 마
실행 결과는 핵심 상태만 요약해.
```

## 5. Existing install, sync now

Use this when the package is already installed and the user wants to continue on another machine right now.

```text
codex-handoff를 지금 실행해서 현재 repo의 thread들을 최신 상태로 맞춰.
먼저 remote head를 pull하고, 그 다음 local 변경을 push해.
내려받은 thread들은 `.codex-handoff/threads/` 아래에 저장하고, 이어갈 thread를 루트 `.codex-handoff/`에 materialize해.
충돌이 있으면 덮어쓰지 말고 conflict snapshot을 남긴 뒤 결과만 짧게 요약해.
```

## 6. Prompt with safety boundaries

Use this when the user wants Codex to act autonomously but not overreach.

```text
codex-handoff 설치와 초기 설정을 끝까지 진행해.
Cloudflare R2 remote를 사용하고, 현재 사용자 계정 기준으로만 자동 시작을 등록해.
다른 디렉터리는 건드리지 말고 현재 저장소와 그 저장소에 연결된 Codex thread들만 다뤄.
실패하면 중간에 멈추지 말고 가능한 대안을 시도한 뒤 마지막에 문제만 정리해.
```

## Expected install summary format

After the agent completes setup, the final user-facing report should be short and operator-friendly.

Recommended summary shape:

```text
설치 완료
- package: installed
- remote: logged in as <profile>
- repo: <repo-slug>
- threads_discovered: <count>
- remote_prefix: repos/<repo-slug>/
- agent: running
- autostart: enabled
- attached: yes
- initial_pull: completed
- sync: healthy
```

## Npm copy guidance

When the npm package exists, keep the product copy short and repeatable:

- package name: `@brdg/codex-handoff`
- install verb: `npm install -g @brdg/codex-handoff`
- bootstrap verb: `codex-handoff install --repo <path>`
- verify verb: `codex-handoff doctor`
- remote auth verb: `codex-handoff remote login r2`
- background service verb: `codex-handoff agent start`
- thread scan verb: `codex-handoff threads scan --repo <path>`

Avoid copy that says:

- "install the certificate"
- "read all transcripts into memory"
- "sync every folder automatically"
- "sync every Codex session on this machine"
