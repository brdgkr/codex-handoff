const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { dbCwd, dbRolloutPath, discoverThreadsForRepo, upsertThreadRow } = require("./local-codex");
const { readTranscriptFile } = require("./thread-bundles");
const { applyChangedThreadsLocally, buildLocalResultFromMemoryDir, exportRepoThreads, prepareLocalWriteSnapshot, pullRepoMemorySnapshot, pushChangedThreads, reconcileRepoThreads, syncChangedThreads, syncNow, updateThreadBundleFromRolloutChange, _test } = require("./sync");

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
  assert.equal(result.created, true);
  assert.equal(result.transcript.length, 2);
  assert.deepEqual(
    result.transcript.map((item) => ({ role: item.role, message: item.message, phase: item.phase })),
    [
      { role: "user", message: "hello user", phase: null },
      { role: "assistant", message: "hello assistant", phase: "final_answer" },
    ],
  );
  assert.equal(fs.existsSync(path.join(memoryDir, "threads", "thread-123.jsonl")), true);
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
  fs.writeFileSync(path.join(memoryDir, "threads", "thread-imported.jsonl"), `${JSON.stringify({
    session_id: "thread-imported",
    turn_id: "turn-1",
    timestamp: null,
    role: "user",
    phase: null,
    message: "imported user",
  })}\n`, "utf8");
  fs.writeFileSync(path.join(memoryDir, "thread-index.json"), JSON.stringify([
    {
      thread_id: "thread-imported",
      title: "Imported Thread",
      thread_name: "Imported Thread",
      created_at: 1,
      updated_at: 4,
      source_session_relpath: "sessions/original-imported.jsonl",
      bundle_path: "threads/thread-imported.jsonl",
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
  const importedTranscript = readTranscriptFile(path.join(memoryDir, "threads", "thread-imported.jsonl"));
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
  assert.equal(fs.existsSync(path.join(memoryDir, "threads", "thread-noise.jsonl")), false);
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
  assert.equal(result.new_thread_count, 1);
  assert.deepEqual(result.new_threads, [
    {
      thread_id: "thread-123",
      title: "Incremental Thread",
      thread_name: "Incremental Thread",
      bundle_path: path.posix.join("threads", "thread-123.jsonl"),
      transcript_record_count: 2,
    },
  ]);
  assert.equal(fs.existsSync(path.join(memoryDir, "threads", "thread-123.jsonl")), true);
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
  assert.equal(result.new_thread_count, 1);
  assert.equal(result.new_threads[0].thread_id, "thread-new");
  assert.equal(result.new_threads[0].bundle_path, path.posix.join("threads", "thread-new.jsonl"));
  assert.equal(fs.existsSync(path.join(memoryDir, "threads", "thread-new.jsonl")), true);
  const transcript = readTranscriptFile(path.join(memoryDir, "threads", "thread-new.jsonl"));
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

test("reconcileRepoThreads refreshes only stale thread bundles", () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-handoff-reconcile-"));
  const memoryDir = path.join(repoDir, ".codex-handoff");
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-handoff-reconcile-home-"));
  const stateDbPath = path.join(codexHome, "state_5.sqlite");
  const rolloutDir = path.join(codexHome, "sessions", "2026", "04", "10");
  const staleRolloutPath = path.join(rolloutDir, "rollout-stale.jsonl");
  const freshRolloutPath = path.join(rolloutDir, "rollout-fresh.jsonl");

  fs.mkdirSync(path.join(memoryDir, "threads"), { recursive: true });
  fs.mkdirSync(rolloutDir, { recursive: true });
  fs.writeFileSync(staleRolloutPath, [
    JSON.stringify({ type: "session_meta", payload: { id: "thread-stale", cwd: repoDir } }),
    JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "stale user" } }),
    "",
  ].join("\n"), "utf8");
  fs.writeFileSync(freshRolloutPath, [
    JSON.stringify({ type: "session_meta", payload: { id: "thread-fresh", cwd: repoDir } }),
    JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "fresh user" } }),
    "",
  ].join("\n"), "utf8");
  fs.writeFileSync(path.join(memoryDir, "threads", "thread-fresh.jsonl"), `${JSON.stringify({
    session_id: "thread-fresh",
    turn_id: "turn-1",
    timestamp: null,
    role: "user",
    phase: null,
    message: "fresh user",
  })}\n`, "utf8");
  fs.writeFileSync(path.join(memoryDir, "thread-index.json"), JSON.stringify([
    {
      thread_id: "thread-fresh",
      title: "thread-fresh",
      thread_name: "thread-fresh",
      created_at: 1,
      updated_at: 10,
      source_session_relpath: "sessions/2026/04/10/rollout-fresh.jsonl",
      bundle_path: "threads/thread-fresh.jsonl",
    },
  ], null, 2) + "\n", "utf8");

  seedThread(stateDbPath, repoDir, { id: "thread-stale", updatedAt: 20, rolloutPath: staleRolloutPath });
  seedThread(stateDbPath, repoDir, { id: "thread-fresh", updatedAt: 10, rolloutPath: freshRolloutPath });

  const result = reconcileRepoThreads(repoDir, memoryDir, {
    codexHome,
    includeRawThreads: false,
  });

  assert.equal(result.reconciled_thread_count, 1);
  assert.deepEqual(result.reconciled_threads, ["thread-stale"]);
  assert.ok(result.changed_paths.includes(path.posix.join("threads", "thread-stale.jsonl")));
  assert.equal(fs.existsSync(path.join(memoryDir, "threads", "thread-stale.jsonl")), true);
  assert.equal(fs.existsSync(path.join(memoryDir, "threads", "thread-fresh.jsonl")), true);
});

test("prepareLocalWriteSnapshot stages local thread exports without mutating the read cache", () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-handoff-local-stage-"));
  const memoryDir = path.join(repoDir, ".codex-handoff");
  const rolloutPath = path.join(repoDir, "rollout-thread-stage.jsonl");
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(
    path.join(memoryDir, "repo.json"),
    JSON.stringify({
      repo_path: repoDir,
      repo_slug: "project",
      remote_auth_type: "test",
      remote_auth_path: "test",
      remote_prefix: "repos/project/",
    }, null, 2) + "\n",
    "utf8",
  );
  fs.writeFileSync(path.join(memoryDir, "memory.md"), "# Root Memory\n\n- Keep this at root.\n", "utf8");
  fs.writeFileSync(rolloutPath, `${JSON.stringify({
    session_id: "thread-stage",
    turn_id: "turn-1",
    timestamp: null,
    role: "user",
    phase: null,
    message: "local staged thread",
  })}\n`, "utf8");

  const thread = makeThread({
    threadId: "thread-stage",
    title: "Stage Thread",
    rolloutPath,
    updatedAt: 3,
    row: {
      id: "thread-stage",
      source: "vscode",
      model_provider: "openai",
      model: "gpt-5.4",
      reasoning_effort: "xhigh",
      cwd: repoDir,
      rollout_path: rolloutPath,
    },
    sessionIndexEntry: {
      id: "thread-stage",
      thread_name: "Stage Thread",
      updated_at: "2026-01-01T00:00:00.000Z",
    },
  });

  const result = prepareLocalWriteSnapshot(repoDir, memoryDir, {
    codexHome: "/unused",
    discoverThreads: () => [thread],
  });

  assert.equal(result.stageDir, path.join(memoryDir, "local-threads"));
  assert.equal(fs.existsSync(path.join(result.stageDir, "threads", "thread-stage.jsonl")), true);
  assert.equal(fs.existsSync(path.join(result.stageDir, "memory.md")), false);
  assert.equal(fs.existsSync(path.join(result.stageDir, "memory-state.json")), false);
  assert.equal(fs.existsSync(path.join(result.stageDir, "repo.json")), false);
  assert.equal(fs.existsSync(path.join(memoryDir, "threads", "thread-stage.jsonl")), false);
  assert.match(result.local_result.changed_paths.join("\n"), /threads\/thread-stage\.jsonl/);
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
  assert.equal(result.new_thread_count, 1);
  assert.equal(result.new_threads[0].thread_id, "thread-123");
  assert.equal(fs.existsSync(path.join(memoryDir, "local-threads", "threads", "thread-123.jsonl")), true);
});

test("pushChangedThreads reuses a precomputed local result without reapplying changes", async () => {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-handoff-push-local-result-"));
  const thread = makeThread();

  const localResult = applyChangedThreadsLocally("/workspace/project", memoryDir, {
    codexHome: "/tmp/codex-home",
    includeRawThreads: false,
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

  const result = await pushChangedThreads("/workspace/project", memoryDir, null, {
    prefix: "repos/project/",
    localResult,
  });

  assert.equal(result.remote_push_attempted, false);
  assert.equal(result.remote_push_succeeded, false);
  assert.equal(result.threads_exported, 1);
  assert.equal(result.new_thread_count, 1);
  assert.ok(result.changed_paths.includes("thread-index.json"));
  assert.equal(fs.existsSync(path.join(memoryDir, "threads", "thread-123.jsonl")), true);
});

test("pushChangedThreads can upload from a local staging dir and mirror the remote cache on success", async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-handoff-stage-push-repo-"));
  const memoryDir = path.join(repoDir, ".codex-handoff");
  const stageDir = path.join(memoryDir, "local-threads");
  fs.mkdirSync(path.join(stageDir, "threads"), { recursive: true });
  fs.writeFileSync(path.join(stageDir, "threads", "thread-stage.jsonl"), `${JSON.stringify({
    session_id: "thread-stage",
    turn_id: "turn-1",
    timestamp: null,
    role: "user",
    phase: null,
    message: "staged local thread",
  })}\n`, "utf8");
  fs.writeFileSync(path.join(stageDir, "thread-index.json"), JSON.stringify([
    {
      thread_id: "thread-stage",
      title: "Stage Thread",
      thread_name: "Stage Thread",
      created_at: 1,
      updated_at: 2,
      source_session_relpath: "sessions/stage.jsonl",
      bundle_path: "threads/thread-stage.jsonl",
    },
  ], null, 2) + "\n", "utf8");
  fs.writeFileSync(path.join(stageDir, "current-thread.json"), JSON.stringify({ thread_id: "thread-stage" }, null, 2) + "\n", "utf8");
  fs.writeFileSync(path.join(memoryDir, "repo.json"), JSON.stringify({
    repo_path: repoDir,
    repo_slug: "project",
    machine_id: "machine-a",
    remote_auth_type: "test",
    remote_auth_path: "test",
    remote_prefix: "repos/project/",
  }, null, 2) + "\n", "utf8");

  const uploaded = [];
  const r2Path = require.resolve("./r2");
  const originalR2 = require(r2Path);
  require.cache[r2Path].exports = {
    ...originalR2,
    putR2Object: async (_profile, key, payload) => { uploaded.push({ key, payload: Buffer.from(payload).toString("utf8") }); return { status: "200" }; },
    deleteR2Object: async () => ({ status: "204" }),
    listR2Objects: async () => [],
    getR2Object: async () => Buffer.alloc(0),
  };
  const syncPath = require.resolve("./sync");
  delete require.cache[syncPath];
  const freshSync = require("./sync");

  try {
    const localResult = freshSync.buildLocalResultFromMemoryDir(stageDir);
    const result = await freshSync.pushChangedThreads(repoDir, memoryDir, { fake: true }, {
      prefix: "repos/project/",
      localResult,
      sourceDir: stageDir,
      mirrorOnSuccess: true,
    });

    assert.equal(result.remote_push_attempted, true);
    assert.equal(result.remote_push_succeeded, true);
    assert.equal(fs.existsSync(path.join(memoryDir, "threads", "thread-stage.jsonl")), true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(memoryDir, "current-thread.json"), "utf8")).thread_id, "thread-stage");
    assert.ok(uploaded.some((entry) => entry.key === "repos/project/machine-sources/machine-a/threads/thread-stage.jsonl"));
    assert.ok(uploaded.some((entry) => entry.key === "repos/project/repo.json"));
  } finally {
    require.cache[r2Path].exports = originalR2;
    delete require.cache[syncPath];
  }
});

test("syncNow only uploads thread payloads when sourceDir is local-threads", async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-handoff-sync-now-memory-root-"));
  const memoryDir = path.join(repoDir, ".codex-handoff");
  const stageDir = path.join(memoryDir, "local-threads");
  fs.mkdirSync(path.join(stageDir, "threads"), { recursive: true });
  fs.writeFileSync(path.join(stageDir, "threads", "thread-stage.jsonl"), `${JSON.stringify({
    session_id: "thread-stage",
    turn_id: "turn-1",
    timestamp: null,
    role: "user",
    phase: null,
    message: "staged local thread",
  })}\n`, "utf8");
  fs.writeFileSync(path.join(stageDir, "thread-index.json"), JSON.stringify([
    {
      thread_id: "thread-stage",
      title: "Stage Thread",
      thread_name: "Stage Thread",
      created_at: 1,
      updated_at: 2,
      source_session_relpath: "sessions/stage.jsonl",
      bundle_path: "threads/thread-stage.jsonl",
    },
  ], null, 2) + "\n", "utf8");
  fs.writeFileSync(path.join(stageDir, "current-thread.json"), JSON.stringify({ thread_id: "thread-stage" }, null, 2) + "\n", "utf8");
  fs.writeFileSync(path.join(memoryDir, "repo.json"), JSON.stringify({
    repo_path: repoDir,
    repo_slug: "project",
    machine_id: "machine-a",
    remote_auth_type: "test",
    remote_auth_path: "test",
    remote_prefix: "repos/project/",
  }, null, 2) + "\n", "utf8");
  const uploaded = [];
  const r2Path = require.resolve("./r2");
  const originalR2 = require(r2Path);
  require.cache[r2Path].exports = {
    ...originalR2,
    putR2Object: async (_profile, key, payload) => { uploaded.push({ key, payload: Buffer.from(payload).toString("utf8") }); return { status: "200" }; },
    deleteR2Object: async () => ({ status: "204" }),
    listR2Objects: async () => [],
    getR2Object: async () => Buffer.alloc(0),
  };
  const syncPath = require.resolve("./sync");
  delete require.cache[syncPath];
  const freshSync = require("./sync");

  try {
    await freshSync.syncNow(repoDir, memoryDir, { fake: true }, {
      prefix: "repos/project/",
      sourceDir: stageDir,
    });

    assert.ok(uploaded.some((entry) => entry.key === "repos/project/machine-sources/machine-a/threads/thread-stage.jsonl"));
    assert.ok(uploaded.some((entry) => entry.key === "repos/project/repo.json"));
    assert.equal(uploaded.some((entry) => entry.key === "repos/project/memory.md"), false);
    assert.equal(uploaded.some((entry) => entry.key === "repos/project/memory-state.json"), false);
  } finally {
    require.cache[r2Path].exports = originalR2;
    delete require.cache[syncPath];
  }
});

test("pullRepoMemorySnapshot preserves local staging files while pruning the remote cache", async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-handoff-stage-preserve-repo-"));
  const memoryDir = path.join(repoDir, ".codex-handoff");
  const stageDir = path.join(memoryDir, "local-threads");
  const readDir = path.join(memoryDir, "synced-threads");
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-handoff-stage-preserve-home-"));
  fs.mkdirSync(path.join(readDir, "threads"), { recursive: true });
  fs.mkdirSync(path.join(stageDir, "threads"), { recursive: true });
  fs.writeFileSync(path.join(readDir, "threads", "old-remote.jsonl"), `${JSON.stringify({
    session_id: "old-remote",
    turn_id: "turn-1",
    timestamp: null,
    role: "assistant",
    phase: null,
    message: "old remote thread",
  })}\n`, "utf8");
  fs.writeFileSync(path.join(stageDir, "threads", "local-stage.jsonl"), `${JSON.stringify({
    session_id: "local-stage",
    turn_id: "turn-1",
    timestamp: null,
    role: "user",
    phase: null,
    message: "local staged thread",
  })}\n`, "utf8");
  fs.writeFileSync(path.join(stageDir, "thread-index.json"), JSON.stringify([
    {
      thread_id: "local-stage",
      title: "Local Stage",
      thread_name: "Local Stage",
      created_at: 1,
      updated_at: 2,
      source_session_relpath: "sessions/local-stage.jsonl",
      bundle_path: "threads/local-stage.jsonl",
    },
  ], null, 2) + "\n", "utf8");
  fs.writeFileSync(path.join(memoryDir, "repo.json"), JSON.stringify({
    repo_path: repoDir,
    repo_slug: "project",
    machine_id: "machine-local",
    remote_auth_type: "test",
    remote_auth_path: "test",
    remote_prefix: "repos/project/",
  }, null, 2) + "\n", "utf8");

  const remoteObjects = new Map();
  remoteObjects.set("repos/project/machine-sources/machine-remote/threads/remote-new.jsonl", Buffer.from(`${JSON.stringify({
    session_id: "remote-new",
    turn_id: "turn-1",
    timestamp: null,
    role: "assistant",
    phase: null,
    message: "remote cached thread",
  })}\n`));
  remoteObjects.set("repos/project/machine-sources/machine-local/threads/local-owned.jsonl", Buffer.from(`${JSON.stringify({
    session_id: "local-owned",
    turn_id: "turn-1",
    timestamp: null,
    role: "assistant",
    phase: null,
    message: "should not be pulled back to same machine",
  })}\n`));

  const r2Path = require.resolve("./r2");
  const originalR2 = require(r2Path);
  require.cache[r2Path].exports = {
    ...originalR2,
    listR2Objects: async (_profile, prefix = "") => [...remoteObjects.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })),
    getR2Object: async (_profile, key) => remoteObjects.get(key),
    putR2Object: async () => ({ status: "200" }),
    deleteR2Object: async () => ({ status: "204" }),
  };
  const syncPath = require.resolve("./sync");
  delete require.cache[syncPath];
  const freshSync = require("./sync");

  try {
    const result = await freshSync.pullRepoMemorySnapshot(repoDir, memoryDir, { fake: true }, require("./workspace").loadRepoState(memoryDir), { codexHome });
    assert.equal(result.imported_thread.thread_id, "local-owned");
    assert.equal(fs.existsSync(path.join(readDir, "threads", "remote-new.jsonl")), true);
    assert.equal(fs.existsSync(path.join(readDir, "threads", "local-owned.jsonl")), true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(readDir, "current-thread.json"), "utf8")).thread_id, "local-owned");
    assert.equal(JSON.parse(fs.readFileSync(path.join(readDir, "thread-index.json"), "utf8")).length, 2);
    assert.equal(fs.existsSync(path.join(memoryDir, "memory.md")), false);
    assert.equal(fs.existsSync(path.join(memoryDir, "memory-state.json")), false);
    assert.equal(fs.existsSync(path.join(readDir, "repo.json")), false);
    assert.equal(fs.existsSync(path.join(readDir, "threads", "old-remote.jsonl")), false);
    assert.equal(fs.existsSync(path.join(stageDir, "threads", "local-stage.jsonl")), true);
  } finally {
    require.cache[r2Path].exports = originalR2;
    delete require.cache[syncPath];
  }
});

test("pullRepoMemorySnapshot applies remote repo metadata while reading thread payloads from the stable prefix", async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-handoff-pull-remote-repo-state-"));
  const memoryDir = path.join(repoDir, ".codex-handoff");
  const readDir = path.join(memoryDir, "synced-threads");
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-handoff-pull-remote-state-home-"));
  fs.mkdirSync(readDir, { recursive: true });
  fs.writeFileSync(path.join(memoryDir, "repo.json"), JSON.stringify({
    repo_path: repoDir,
    repo_slug: "ideook-codex-handoff",
    machine_id: "machine-local",
    remote_auth_type: "test",
    remote_auth_path: "test",
    remote_prefix: "repos/ideook-codex-handoff/",
    git_origin_url: "https://github.com/ideook/codex-handoff.git",
  }, null, 2) + "\n", "utf8");

  const remoteObjects = new Map();
  remoteObjects.set("repos/ideook-codex-handoff/repo.json", Buffer.from(JSON.stringify({
    repo_slug: "ideook-codex-handoff",
    remote_prefix: "repos/ideook-codex-handoff/",
    git_origin_url: "https://github.com/brdgkr/codex-handoff.git",
    git_origin_urls: ["https://github.com/ideook/codex-handoff.git"],
    updated_at: "2026-04-11T10:00:00.000Z",
  }, null, 2) + "\n"));
  remoteObjects.set("repos/ideook-codex-handoff/machine-sources/machine-remote/threads/remote-new.jsonl", Buffer.from(`${JSON.stringify({
    session_id: "remote-new",
    turn_id: "turn-1",
    timestamp: null,
    role: "assistant",
    phase: null,
    message: "remote cached thread",
  })}\n`));

  const r2Path = require.resolve("./r2");
  const originalR2 = require(r2Path);
  require.cache[r2Path].exports = {
    ...originalR2,
    listR2Objects: async (_profile, prefix = "") => [...remoteObjects.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })),
    getR2Object: async (_profile, key) => {
      if (remoteObjects.has(key)) {
        return remoteObjects.get(key);
      }
      throw new Error(`Missing key: ${key}`);
    },
    putR2Object: async () => ({ status: "200" }),
    deleteR2Object: async () => ({ status: "204" }),
  };
  const syncPath = require.resolve("./sync");
  delete require.cache[syncPath];
  const freshSync = require("./sync");
  const { loadRepoState: loadFreshRepoState } = require("./workspace");

  try {
    const result = await freshSync.pullRepoMemorySnapshot(
      repoDir,
      memoryDir,
      { fake: true },
      loadFreshRepoState(memoryDir),
      { codexHome },
    );

    assert.equal(result.pulled_from_prefix, "repos/ideook-codex-handoff/");
    assert.deepEqual(result.alias_remote_prefixes, []);
    assert.equal(loadFreshRepoState(memoryDir).repo_slug, "ideook-codex-handoff");
    assert.equal(loadFreshRepoState(memoryDir).git_origin_url, "https://github.com/brdgkr/codex-handoff.git");
    assert.deepEqual(loadFreshRepoState(memoryDir).git_origin_urls, ["https://github.com/ideook/codex-handoff.git"]);
    assert.equal(fs.existsSync(path.join(readDir, "threads", "remote-new.jsonl")), true);
  } finally {
    require.cache[r2Path].exports = originalR2;
    delete require.cache[syncPath];
  }
});

test("applyChangedThreadsLocally only flags notifications when a bundle is first created", () => {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-handoff-sync-notify-once-"));
  const thread = makeThread();

  const first = applyChangedThreadsLocally("/workspace/project", memoryDir, {
    codexHome: "/tmp/codex-home",
    includeRawThreads: false,
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

  const second = applyChangedThreadsLocally("/workspace/project", memoryDir, {
    codexHome: "/tmp/codex-home",
    includeRawThreads: false,
    discoverThreads: () => [thread],
    changes: [
      {
        threadId: "thread-123",
        newLines: [
          JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "hello assistant", phase: "final_answer" } }),
        ],
        parserState: { sessionId: "thread-123", currentTurnId: "turn-1" },
      },
    ],
  });

  assert.equal(first.new_thread_count, 1);
  assert.equal(second.new_thread_count, 0);
  assert.deepEqual(second.new_threads, []);
});

test("sync file filter includes root memory artifacts", () => {
  assert.equal(_test.shouldSyncRelpath("memory.md", [], null), false);
  assert.equal(_test.shouldSyncRelpath("memory-state.json", [], null), false);
  assert.equal(_test.shouldSyncRelpath("sync-state.json", [], null), true);
  assert.equal(_test.shouldSyncRelpath("threads/thread-1.jsonl", ["thread-1"], "thread-1"), true);
  assert.equal(_test.shouldSyncRelpath("threads/thread-1.jsonl", ["thread-1"], "thread-1"), true);
  assert.equal(_test.shouldSyncRelpath("threads/thread-2.jsonl", ["thread-1"], "thread-1"), false);
});
