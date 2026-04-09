const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { dbCwd, dbRolloutPath, discoverThreadsForRepo, upsertThreadRow } = require("./local-codex");
const { applyChangedThreadsLocally, exportRepoThreads, syncChangedThreads, updateThreadBundleFromRolloutChange, _test } = require("./sync");

function makeThread(overrides = {}) {
  return {
    threadId: "thread-123",
    title: "Incremental Thread",
    cwd: "/workspace/project",
    rolloutPath: "/tmp/rollout-thread-123.jsonl",
    createdAt: 1,
    updatedAt: 2,
    row: {
      id: "thread-123",
      source: "vscode",
      model_provider: "openai",
      model: "gpt-5.4",
      reasoning_effort: "xhigh",
      cwd: "/workspace/project",
      rollout_path: "/tmp/rollout-thread-123.jsonl",
    },
    sessionIndexEntry: {
      id: "thread-123",
      thread_name: "Incremental Thread",
      updated_at: "2026-01-01T00:00:00.000Z",
    },
    ...overrides,
  };
}

function runGit(repoDir, ...args) {
  execFileSync("git", args, {
    cwd: repoDir,
    stdio: "ignore",
  });
}

function seedThread(stateDbPath, repoDir, { id, gitOriginUrl = null, updatedAt = 2, rolloutPath = path.join(repoDir, `${id}.jsonl`) }) {
  upsertThreadRow(stateDbPath, {
    id,
    rollout_path: dbRolloutPath(rolloutPath),
    created_at: 1,
    updated_at: updatedAt,
    source: "vscode",
    model_provider: "openai",
    cwd: dbCwd(repoDir),
    title: id,
    sandbox_policy: JSON.stringify({ type: "danger-full-access" }),
    approval_mode: "never",
    tokens_used: 0,
    has_user_event: 0,
    archived: 0,
    archived_at: null,
    git_sha: null,
    git_branch: "main",
    git_origin_url: gitOriginUrl,
    cli_version: "",
    first_user_message: "",
    agent_nickname: null,
    agent_role: null,
    memory_mode: "enabled",
    model: "gpt-5.4",
    reasoning_effort: "xhigh",
    agent_path: null,
  });
}

test("updateThreadBundleFromRolloutChange creates a bundle from appended canonical messages only", () => {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-handoff-sync-"));
  const thread = makeThread();

  const newLines = [
    JSON.stringify({ type: "session_meta", payload: { id: "thread-123" } }),
    JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } }),
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hello user" }] } }),
    JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "hello user" } }),
    JSON.stringify({ type: "event_msg", payload: { type: "token_count" } }),
    JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "hello assistant", phase: "final_answer" } }),
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "hello assistant" }] } }),
    JSON.stringify({ type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: "{}" } }),
  ];

  const result = updateThreadBundleFromRolloutChange("/workspace/project", memoryDir, thread, {
    newLines,
    parserState: null,
    includeRawThreads: false,
  });

  assert.equal(result.touched, true);
  assert.equal(result.transcript.length, 2);
  assert.deepEqual(
    result.transcript.map((item) => ({ role: item.role, message: item.message, phase: item.phase })),
    [
      { role: "user", message: "hello user", phase: null },
      { role: "assistant", message: "hello assistant", phase: "final_answer" },
    ],
  );
  assert.equal(fs.existsSync(path.join(memoryDir, "threads", "thread-123.json")), true);
});

test("exportRepoThreads preserves imported bundles when raw rollout files are unavailable", async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-handoff-export-missing-rollout-repo-"));
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-handoff-export-missing-rollout-home-"));
  const memoryDir = path.join(repoDir, ".codex-handoff");
  const stateDbPath = path.join(codexHome, "state_5.sqlite");
  const rolloutDir = path.join(codexHome, "sessions", "2026", "04", "09");
  const liveRolloutPath = path.join(rolloutDir, "rollout-live.jsonl");
  const missingRolloutPath = path.join(codexHome, "sessions", "missing-rollout.jsonl");

  fs.mkdirSync(path.join(memoryDir, "threads"), { recursive: true });
  fs.mkdirSync(rolloutDir, { recursive: true });
  fs.writeFileSync(liveRolloutPath, [
    JSON.stringify({ type: "session_meta", payload: { id: "thread-live", cwd: repoDir } }),
    JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "live user" } }),
    "",
  ].join("\n"), "utf8");
  fs.writeFileSync(path.join(memoryDir, "threads", "thread-imported.json"), JSON.stringify([
    {
      session_id: "thread-imported",
      turn_id: "turn-1",
      timestamp: null,
      role: "user",
      phase: null,
      message: "imported user",
    },
  ], null, 2) + "\n", "utf8");
  fs.writeFileSync(path.join(memoryDir, "thread-index.json"), JSON.stringify([
    {
      thread_id: "thread-imported",
      title: "Imported Thread",
      thread_name: "Imported Thread",
      created_at: 1,
      updated_at: 4,
      source_session_relpath: "sessions/original-imported.jsonl",
      bundle_path: "threads/thread-imported.json",
    },
  ], null, 2) + "\n", "utf8");

  seedThread(stateDbPath, repoDir, { id: "thread-imported", updatedAt: 4, rolloutPath: missingRolloutPath });
  seedThread(stateDbPath, repoDir, { id: "thread-live", updatedAt: 3, rolloutPath: liveRolloutPath });

  const exported = await exportRepoThreads(repoDir, memoryDir, {
    codexHome,
    includeRawThreads: false,
  });

  assert.deepEqual(exported.map((thread) => thread.threadId), ["thread-imported", "thread-live"]);
  const index = JSON.parse(fs.readFileSync(path.join(memoryDir, "thread-index.json"), "utf8"));
  assert.deepEqual(index.map((entry) => entry.thread_id), ["thread-imported", "thread-live"]);
  assert.equal(index[0].source_session_relpath, "sessions/original-imported.jsonl");
  const importedTranscript = JSON.parse(fs.readFileSync(path.join(memoryDir, "threads", "thread-imported.json"), "utf8"));
  assert.equal(importedTranscript[0].message, "imported user");
});

test("updateThreadBundleFromRolloutChange ignores noise-only appended lines for new threads", () => {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-handoff-sync-noise-"));
  const thread = makeThread({ threadId: "thread-noise", row: { id: "thread-noise", source: "vscode", model_provider: "openai", cwd: "/workspace/project", rollout_path: "/tmp/rollout-thread-noise.jsonl" } });

  const result = updateThreadBundleFromRolloutChange("/workspace/project", memoryDir, thread, {
    newLines: [
      JSON.stringify({ type: "session_meta", payload: { id: "thread-noise" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "token_count" } }),
      JSON.stringify({ type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: "{}" } }),
    ],
    parserState: null,
    includeRawThreads: false,
  });

  assert.equal(result.touched, false);
  assert.equal(result.transcript, null);
  assert.equal(fs.existsSync(path.join(memoryDir, "threads", "thread-noise.json")), false);
});

test("updateThreadBundleFromRolloutChange appends new canonical messages to an existing bundle", () => {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-handoff-sync-append-"));
  const thread = makeThread();

  updateThreadBundleFromRolloutChange("/workspace/project", memoryDir, thread, {
    newLines: [
      JSON.stringify({ type: "session_meta", payload: { id: "thread-123" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "hello user" } }),
    ],
    parserState: null,
    includeRawThreads: false,
  });

  const result = updateThreadBundleFromRolloutChange("/workspace/project", memoryDir, thread, {
    newLines: [
      JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "second reply", phase: "commentary" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "token_count" } }),
    ],
    parserState: { sessionId: "thread-123", currentTurnId: "turn-1" },
    includeRawThreads: false,
  });

  assert.equal(result.touched, true);
  assert.deepEqual(
    result.transcript.map((item) => item.message),
    ["hello user", "second reply"],
  );
});

test("applyChangedThreadsLocally updates thread bundles without remote auth", () => {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-handoff-sync-local-only-"));
  const thread = makeThread();

  const result = applyChangedThreadsLocally("/workspace/project", memoryDir, {
    codexHome: "/tmp/codex-home",
    includeRawThreads: false,
    discoverThreads: () => [thread],
    changes: [
      {
        threadId: "thread-123",
        newLines: [
          JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "hello user" } }),
          JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "hello assistant", phase: "final_answer" } }),
        ],
        parserState: { sessionId: "thread-123", currentTurnId: "turn-1" },
      },
    ],
  });

  assert.equal(result.threads_exported, 1);
  assert.deepEqual(result.thread_ids, ["thread-123"]);
  assert.equal(fs.existsSync(path.join(memoryDir, "threads", "thread-123.json")), true);
});

test("applyChangedThreadsLocally synthesizes a watched thread when SQLite metadata is missing", () => {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-handoff-sync-synth-"));
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-handoff-sync-synth-home-"));
  const rolloutDir = path.join(codexHome, "sessions", "2026", "04", "09");
  const rolloutPath = path.join(rolloutDir, "rollout-2026-04-09T13-17-40-thread-new.jsonl");
  fs.mkdirSync(rolloutDir, { recursive: true });
  fs.writeFileSync(rolloutPath, [
    JSON.stringify({ type: "session_meta", payload: { id: "thread-new", cwd: "/workspace/project" } }),
    JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "hello from watcher" } }),
    "",
  ].join("\n"), "utf8");
  fs.writeFileSync(path.join(codexHome, "session_index.jsonl"), `${JSON.stringify({
    id: "thread-new",
    thread_name: "Watched Thread",
    updated_at: "2026-04-09T13:17:46.7410438Z",
  })}\n`, "utf8");

  const result = applyChangedThreadsLocally("/workspace/project", memoryDir, {
    codexHome,
    includeRawThreads: false,
    discoverThreads: () => [],
    changes: [
      {
        threadId: "thread-new",
        rolloutPath,
        cwd: "/workspace/project",
        newLines: [
          JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "hello from watcher" } }),
          JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "watch reply", phase: "final_answer" } }),
        ],
        parserState: { sessionId: "thread-new", currentTurnId: "turn-1" },
      },
    ],
  });

  assert.equal(result.threads_exported, 1);
  assert.deepEqual(result.thread_ids, ["thread-new"]);
  assert.equal(fs.existsSync(path.join(memoryDir, "threads", "thread-new.json")), true);
  const transcript = JSON.parse(fs.readFileSync(path.join(memoryDir, "threads", "thread-new.json"), "utf8"));
  assert.deepEqual(transcript.map((item) => item.message), ["hello from watcher", "watch reply"]);
  const index = JSON.parse(fs.readFileSync(path.join(memoryDir, "thread-index.json"), "utf8"));
  assert.equal(index[0].thread_name, "Watched Thread");
});

test("discoverThreadsForRepo recovers matching historical git origins from same-cwd rows", () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-handoff-origin-match-"));
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-handoff-codex-home-"));
  const stateDbPath = path.join(codexHome, "state_5.sqlite");

  runGit(repoDir, "init");
  runGit(repoDir, "remote", "add", "origin", "https://github.com/brdgkr/codex-handoff.git");

  seedThread(stateDbPath, repoDir, {
    id: "thread-current",
    gitOriginUrl: "https://github.com/brdgkr/codex-handoff.git",
    updatedAt: 4,
  });
  seedThread(stateDbPath, repoDir, {
    id: "thread-old",
    gitOriginUrl: "https://github.com/ideook/codex-handoff.git",
    updatedAt: 3,
  });
  seedThread(stateDbPath, repoDir, {
    id: "thread-null",
    gitOriginUrl: null,
    updatedAt: 2,
  });
  seedThread(stateDbPath, repoDir, {
    id: "thread-other",
    gitOriginUrl: "https://github.com/example/other-repo.git",
    updatedAt: 1,
  });

  const threads = discoverThreadsForRepo(repoDir, codexHome, {
    git_origin_url: "https://github.com/brdgkr/codex-handoff.git",
    git_origin_urls: [],
  });

  assert.deepEqual(
    threads.map((thread) => thread.threadId),
    ["thread-current", "thread-old", "thread-null"],
  );
});

test("syncChangedThreads keeps local thread updates when remote push is unavailable", async () => {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-handoff-sync-remote-skip-"));
  const thread = makeThread();

  const result = await syncChangedThreads("/workspace/project", memoryDir, null, {
    codexHome: "/tmp/codex-home",
    includeRawThreads: false,
    prefix: "repos/project/",
    discoverThreads: () => [thread],
    changes: [
      {
        threadId: "thread-123",
        newLines: [
          JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "hello user" } }),
        ],
        parserState: { sessionId: "thread-123", currentTurnId: "turn-1" },
      },
    ],
  });

  assert.equal(result.remote_push_attempted, false);
  assert.equal(result.remote_push_succeeded, false);
  assert.equal(result.threads_exported, 1);
  assert.equal(fs.existsSync(path.join(memoryDir, "threads", "thread-123.json")), true);
});

test("sync file filter includes root memory artifacts", () => {
  assert.equal(_test.shouldSyncRelpath("memory.md", [], null), true);
  assert.equal(_test.shouldSyncRelpath("memory-state.json", [], null), true);
  assert.equal(_test.shouldSyncRelpath("threads/thread-1.json", ["thread-1"], "thread-1"), true);
  assert.equal(_test.shouldSyncRelpath("threads/thread-2.json", ["thread-1"], "thread-1"), false);
});
