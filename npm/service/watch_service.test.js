const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { normalizeComparablePath } = require("./common");
const { findManagedRepoForCwd, loadManagedRepos } = require("./repo_registry");
const { readIncrementalJsonl } = require("./rollout_incremental");
const { readRolloutLastRecordSummary, readRolloutMeta } = require("./rollout_meta");
const { RepoSyncScheduler } = require("./scheduler");

test("loadManagedRepos returns normalized managed repos sorted by specificity", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-handoff-config-"));
  const configPath = path.join(tempDir, "config.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        repos: {
          "/workspace": { repo_slug: "workspace" },
          "/workspace/project": { repo_slug: "project" },
        },
      },
      null,
      2
    )
  );

  const repos = loadManagedRepos(tempDir);
  assert.equal(repos.length, 2);
  assert.equal(repos[0].repoSlug, "project");
  assert.equal(repos[1].repoSlug, "workspace");
});

test("loadManagedRepos dedupes repo entries that only differ by Windows path casing and separators", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-handoff-config-"));
  const configPath = path.join(tempDir, "config.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        repos: {
          "D:\\source\\repos\\ideook\\codex-handoff": { repo_slug: "older", updated_at: "2026-04-01T00:00:00.000Z" },
          "d:/source/repos/ideook/codex-handoff": { repo_slug: "newer", updated_at: "2026-04-09T00:00:00.000Z" },
        },
      },
      null,
      2
    )
  );

  const repos = loadManagedRepos(tempDir);
  assert.equal(repos.length, 1);
  assert.equal(repos[0].repoSlug, "newer");
  assert.equal(normalizeComparablePath(repos[0].repoPath), "d:/source/repos/ideook/codex-handoff");
});

test("findManagedRepoForCwd matches the longest managed ancestor", () => {
  const managedRepos = [
    { repoPath: "/workspace/project", normalizedPath: normalizeComparablePath("/workspace/project"), repoSlug: "project" },
    { repoPath: "/workspace", normalizedPath: normalizeComparablePath("/workspace"), repoSlug: "workspace" },
  ];

  const match = findManagedRepoForCwd("/workspace/project/src", managedRepos);
  assert.ok(match);
  assert.equal(match.repoSlug, "project");
});

test("findManagedRepoForCwd ignores foreign machine paths", () => {
  const managedRepos = [
    {
      repoPath: "/Users/test/project",
      normalizedPath: normalizeComparablePath("/Users/test/project"),
      repoSlug: "project",
    },
  ];

  const match = findManagedRepoForCwd("D:\\source\\repos\\project", managedRepos);
  assert.equal(match, null);
});

test("readRolloutMeta extracts session metadata from the first record", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-handoff-rollout-"));
  const rolloutPath = path.join(tempDir, "rollout-2026-01-01-test.jsonl");
  fs.writeFileSync(
    rolloutPath,
    [
      JSON.stringify({
        type: "session_meta",
        payload: {
          id: "thread-123",
          cwd: "/workspace/project",
          git: { repository_url: "https://github.com/example/project.git" },
        },
      }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }),
    ].join("\n") + "\n"
  );

  const meta = await readRolloutMeta(rolloutPath);
  assert.deepEqual(meta, {
    threadId: "thread-123",
    cwd: "/workspace/project",
    git: { repository_url: "https://github.com/example/project.git" },
  });
});

test("readRolloutLastRecordSummary extracts the latest record JSON", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-handoff-rollout-tail-"));
  const rolloutPath = path.join(tempDir, "rollout-2026-01-01-tail.jsonl");
  fs.writeFileSync(
    rolloutPath,
    [
      JSON.stringify({
        type: "session_meta",
        payload: {
          id: "thread-123",
          cwd: "/workspace/project",
        },
      }),
      JSON.stringify({
        timestamp: "2026-01-01T00:00:10.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Latest assistant summary for verification." }],
        },
      }),
    ].join("\n") + "\n"
  );

  const summary = await readRolloutLastRecordSummary(rolloutPath);
  assert.deepEqual(summary, {
    timestamp: "2026-01-01T00:00:10.000Z",
    recordType: "response_item",
    payloadType: "message",
    recordJson:
      '{"timestamp":"2026-01-01T00:00:10.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Latest assistant summary for verification."}]}}',
  });
});

test("readIncrementalJsonl returns appended lines after previous size", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-handoff-incremental-"));
  const rolloutPath = path.join(tempDir, "rollout-2026-01-01-tail.jsonl");
  fs.writeFileSync(rolloutPath, '{"a":1}\n', "utf8");

  const initial = await readIncrementalJsonl(rolloutPath, null);
  assert.equal(initial.mode, "bootstrap");
  assert.deepEqual(initial.newLines, []);

  fs.appendFileSync(rolloutPath, '{"b":2}\n{"c":3}\n', "utf8");
  const appended = await readIncrementalJsonl(rolloutPath, initial.nextState);
  assert.equal(appended.mode, "append");
  assert.deepEqual(appended.newLines, ['{"b":2}', '{"c":3}']);
});

test("RepoSyncScheduler coalesces bursts and reruns once when dirtied during a run", async () => {
  const starts = [];
  let release;
  const waitForFirstRun = new Promise((resolve) => {
    release = resolve;
  });

  const scheduler = new RepoSyncScheduler({
    debounceMs: 10,
    logger: () => {},
    runSync: async (repo) => {
      starts.push(repo.repoPath);
      if (starts.length === 1) {
        release();
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
    },
  });

  const repo = {
    repoPath: "/workspace/project",
    normalizedPath: normalizeComparablePath("/workspace/project"),
    repoSlug: "project",
  };

  scheduler.enqueue(repo);
  await waitForFirstRun;
  scheduler.enqueue(repo);
  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.deepEqual(starts, ["/workspace/project", "/workspace/project"]);
  await scheduler.dispose();
});
