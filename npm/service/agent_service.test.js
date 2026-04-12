const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { runStartupSync } = require("./agent_service");

function createLogger() {
  const messages = [];
  return {
    messages,
    write(message) {
      messages.push(message);
    },
  };
}

test("runStartupSync refreshes repo memory after pulling synced threads", async () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-handoff-agent-config-"));
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-handoff-agent-repo-"));
  fs.mkdirSync(path.join(repoDir, ".codex-handoff"), { recursive: true });

  let pullCalls = 0;
  let memoryRefreshCalls = 0;
  const logger = createLogger();

  const result = await runStartupSync(configDir, "/tmp/codex-home", logger, {
    deps: {
      loadManagedRepos: () => [{ repoPath: repoDir, repoSlug: "repo-slug" }],
      loadRepoState: () => ({ git_origin_urls: [] }),
      ensureManagedRepoState: () => ({ repo_slug: "repo-slug", remote_prefix: "repos/repo-slug" }),
      loadRepoR2Profile: () => ({ provider: "fake" }),
      pushRepoControlFiles: async () => {},
      buildLocalResultFromMemoryDir: () => ({ changed_paths: [] }),
      pushChangedThreads: async () => ({ objects_uploaded: 0 }),
      pullRepoMemorySnapshot: async () => {
        pullCalls += 1;
        return {
          downloaded_objects: 4,
          current_thread: "thread-1",
          imported_thread: { thread_id: "thread-1" },
        };
      },
      refreshRepoMemory: () => {
        memoryRefreshCalls += 1;
        return {
          status: "refreshed",
          refreshed: true,
          reason: "refreshed",
        };
      },
    },
  });

  assert.equal(pullCalls, 1);
  assert.equal(memoryRefreshCalls, 1);
  assert.equal(result.processed_repo_count, 1);
  assert.equal(result.synced_repo_count, 1);
  assert.equal(result.changed_repo_count, 1);
  assert.equal(result.unchanged_repo_count, 0);
  assert.equal(result.refreshed_memory_repo_count, 1);
  assert.equal(result.skipped_memory_repo_count, 0);
  assert.equal(result.errors.length, 0);
  assert.deepEqual(result.synced_repos[0], {
    repo: repoDir,
    repo_slug: "repo-slug",
    status: "pulled",
    downloaded_objects: 4,
    synced_threads_changed: true,
    recovery_uploaded_objects: 0,
    current_thread: "thread-1",
    imported_thread: "thread-1",
    memory_status: "refreshed",
    memory_refreshed: true,
    memory_reason: "refreshed",
    sync_case: "repo_changed_memory_refreshed",
    memory_case: "memory_refreshed",
    thread_case: "current_thread_imported",
  });
});

test("runStartupSync skips memory refresh when synced threads did not change", async () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-handoff-agent-config-"));
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-handoff-agent-repo-"));
  fs.mkdirSync(path.join(repoDir, ".codex-handoff"), { recursive: true });

  let memoryRefreshCalls = 0;
  const logger = createLogger();

  const result = await runStartupSync(configDir, "/tmp/codex-home", logger, {
    deps: {
      loadManagedRepos: () => [{ repoPath: repoDir, repoSlug: "repo-slug" }],
      loadRepoState: () => ({ git_origin_urls: [] }),
      ensureManagedRepoState: () => ({ repo_slug: "repo-slug", remote_prefix: "repos/repo-slug" }),
      loadRepoR2Profile: () => ({ provider: "fake" }),
      pushRepoControlFiles: async () => {},
      buildLocalResultFromMemoryDir: () => ({ changed_paths: [] }),
      pushChangedThreads: async () => ({ objects_uploaded: 0 }),
      pullRepoMemorySnapshot: async () => ({
        downloaded_objects: 0,
        current_thread: "thread-1",
        imported_thread: { thread_id: "thread-1" },
      }),
      shouldRefreshRepoMemoryForRepo: () => false,
      refreshRepoMemory: () => {
        memoryRefreshCalls += 1;
        return {
          status: "refreshed",
          refreshed: true,
          reason: "refreshed",
        };
      },
    },
  });

  assert.equal(memoryRefreshCalls, 0);
  assert.equal(result.processed_repo_count, 1);
  assert.equal(result.synced_repo_count, 0);
  assert.equal(result.changed_repo_count, 0);
  assert.equal(result.unchanged_repo_count, 1);
  assert.equal(result.refreshed_memory_repo_count, 0);
  assert.equal(result.skipped_memory_repo_count, 1);
  assert.deepEqual(result.synced_repos[0], {
    repo: repoDir,
    repo_slug: "repo-slug",
    status: "unchanged",
    downloaded_objects: 0,
    synced_threads_changed: false,
    recovery_uploaded_objects: 0,
    current_thread: "thread-1",
    imported_thread: "thread-1",
    memory_status: "skipped",
    memory_refreshed: false,
    memory_reason: "no_synced_thread_change",
    sync_case: "repo_unchanged_no_synced_thread_change",
    memory_case: "memory_skipped_no_synced_thread_change",
    thread_case: "current_thread_imported",
  });
});

test("runStartupSync writes activation-scoped events when used for app reactivation", async () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-handoff-activation-config-"));
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-handoff-activation-repo-"));
  const memoryDir = path.join(repoDir, ".codex-handoff");
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify(
      {
        schema_version: "1.0",
        repos: {
          [repoDir]: {
            repo_slug: "repo-slug",
          },
        },
        machine_id: null,
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  const logger = createLogger();
  await runStartupSync(configDir, "/tmp/codex-home", logger, {
    reason: "activation",
    deps: {
      loadManagedRepos: () => [{ repoPath: repoDir, repoSlug: "repo-slug" }],
      loadRepoState: () => ({ git_origin_urls: [] }),
      ensureManagedRepoState: () => ({ repo_slug: "repo-slug", remote_prefix: "repos/repo-slug" }),
      loadRepoR2Profile: () => ({ provider: "fake" }),
      pushRepoControlFiles: async () => {},
      buildLocalResultFromMemoryDir: () => ({ changed_paths: [] }),
      pushChangedThreads: async () => ({ objects_uploaded: 0 }),
      pullRepoMemorySnapshot: async () => ({
        downloaded_objects: 0,
        current_thread: "thread-2",
        imported_thread: { thread_id: "thread-2" },
      }),
      shouldRefreshRepoMemoryForRepo: () => false,
      refreshRepoMemory: () => ({
        status: "skipped",
        refreshed: false,
        reason: "not_needed",
      }),
    },
  });

  const eventLog = fs.readFileSync(path.join(memoryDir, "agent-events.log"), "utf8");
  assert.match(eventLog, /event=activation_sync_started/);
  assert.match(eventLog, /event=activation_sync_repo/);
  assert.match(eventLog, /event=activation_sync_completed/);
  assert.match(eventLog, /status=unchanged/);
  assert.match(eventLog, /synced_threads_changed=false/);
  assert.match(eventLog, /memory_status=skipped/);
  assert.match(eventLog, /sync_case=repo_unchanged_no_synced_thread_change/);
  assert.match(eventLog, /memory_case=memory_skipped_no_synced_thread_change/);
  assert.match(eventLog, /thread_case=current_thread_imported/);
  assert.match(eventLog, /processed_repo_count=1/);
  assert.match(eventLog, /synced_repo_count=0/);
  assert.match(eventLog, /changed_repo_count=0/);
  assert.match(eventLog, /unchanged_repo_count=1/);
  assert.match(eventLog, /refreshed_memory_repo_count=0/);
  assert.match(eventLog, /skipped_memory_repo_count=1/);
  assert.match(eventLog, /completion_case=all_unchanged/);
  assert.match(eventLog, /memory_case=all_memory_skipped/);
  assert.match(eventLog, /current_thread=thread-2/);
});
