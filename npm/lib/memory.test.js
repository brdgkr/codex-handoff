const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { memoryPath, memoryStatePath, refreshLocalMemory, summarizeMemoryWithCodex } = require("./memory");

function makeRepo() {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-handoff-memory-repo-"));
  const memoryDir = path.join(repoDir, ".codex-handoff");
  const syncedThreadsDir = path.join(memoryDir, "synced-threads");
  fs.mkdirSync(path.join(syncedThreadsDir, "threads"), { recursive: true });
  fs.writeFileSync(path.join(syncedThreadsDir, "latest.md"), "# Latest\n\nCurrent work.\n", "utf8");
  fs.writeFileSync(path.join(syncedThreadsDir, "handoff.json"), JSON.stringify({ current_goal: "memory tests" }, null, 2) + "\n", "utf8");
  fs.writeFileSync(
    path.join(syncedThreadsDir, "thread-index.json"),
    JSON.stringify([
      { thread_id: "thread-1", title: "First", updated_at: "2026-01-02T00:00:00.000Z" },
      { thread_id: "thread-2", title: "Second", updated_at: "2026-01-01T00:00:00.000Z" },
    ], null, 2) + "\n",
    "utf8",
  );
  fs.writeFileSync(path.join(syncedThreadsDir, "threads", "thread-1.jsonl"), `${JSON.stringify({ role: "user", message: "hello" })}\n`, "utf8");
  fs.writeFileSync(path.join(syncedThreadsDir, "threads", "thread-2.jsonl"), `${JSON.stringify({ role: "user", message: "old" })}\n`, "utf8");
  return { repoDir, memoryDir };
}

function makeFakeCodex() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-handoff-fake-codex-"));
  const binPath = path.join(dir, "codex");
  fs.writeFileSync(
    binPath,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const args = process.argv.slice(2);",
      "const output = args[args.indexOf('-o') + 1];",
      "const prompt = fs.readFileSync(0, 'utf8');",
      "if (!output) process.exit(2);",
      "let body = '';",
      "if (prompt.includes('write a basic repo summary')) {",
      "  body = ['CLI Repo Summary', '', `cwd=${process.cwd()}`, `isolated=${prompt.includes('Do not inspect the original repository checkout.')}`].join('\\n');",
      "} else if (prompt.includes('append a conversation update')) {",
      "  body = ['- Update summary from changed conversation.', 'Threads: `thread-1` (`unavailable`)'].join('\\n');",
      "} else {",
      "  body = ['CLI Memory', '', `cwd=${process.cwd()}`].join('\\n');",
      "}",
      "fs.writeFileSync(output, body + '\\n', 'utf8');",
    ].join("\n"),
    "utf8",
  );
  fs.chmodSync(binPath, 0o755);
  return binPath;
}

test("summarizeMemoryWithCodex writes memory from an isolated child Codex run", () => {
  const { repoDir, memoryDir } = makeRepo();
  const fakeCodex = makeFakeCodex();
  const result = summarizeMemoryWithCodex(repoDir, memoryDir, {
    codexBin: fakeCodex,
    force: true,
    keepTemp: true,
    maxThreads: 1,
    timeoutMs: 5000,
  });

  assert.equal(result.wrote_memory, true);
  assert.equal(fs.existsSync(memoryPath(memoryDir)), true);
  assert.equal(fs.existsSync(memoryStatePath(memoryDir)), true);
  const memoryText = fs.readFileSync(memoryPath(memoryDir), "utf8");
  assert.match(memoryText, /# Repo Memory/);
  assert.match(memoryText, /## Repo Summary/);
  assert.match(memoryText, /CLI Repo Summary/);
  assert.match(memoryText, /## Conversation Updates/);
  assert.match(memoryText, /Update summary from changed conversation/);
  assert.match(memoryText, /isolated=true/);
  assert.notEqual(result.temp_dir, repoDir);
  assert.equal(result.state.schema_version, "2.0");
  assert.equal(result.state.mode, "append_log");
  assert.deepEqual(result.state.last_appended_thread_ids, ["thread-1", "thread-2"].slice(0, result.state.last_appended_thread_ids.length));

  fs.rmSync(result.temp_dir, { recursive: true, force: true });
});

test("summarizeMemoryWithCodex dry run returns summary without writing root memory", () => {
  const { repoDir, memoryDir } = makeRepo();
  const fakeCodex = makeFakeCodex();
  const result = summarizeMemoryWithCodex(repoDir, memoryDir, {
    codexBin: fakeCodex,
    dryRun: true,
    force: true,
    maxThreads: 0,
    timeoutMs: 5000,
  });

  assert.equal(result.dry_run, true);
  assert.equal(result.wrote_memory, false);
  assert.match(result.summary, /# Repo Memory/);
  assert.match(result.summary, /CLI Repo Summary/);
  assert.equal(fs.existsSync(memoryPath(memoryDir)), false);
  assert.equal(fs.existsSync(memoryStatePath(memoryDir)), false);
});

test("refreshLocalMemory writes root memory from synced threads when missing", () => {
  const { repoDir, memoryDir } = makeRepo();
  const fakeCodex = makeFakeCodex();
  const result = refreshLocalMemory(repoDir, memoryDir, {
    codexBin: fakeCodex,
    timeoutMs: 5000,
  });

  assert.equal(result.refreshed, true);
  assert.equal(result.skipped, false);
  assert.equal(fs.existsSync(memoryPath(memoryDir)), true);
  assert.equal(fs.existsSync(memoryStatePath(memoryDir)), true);
  assert.match(fs.readFileSync(memoryPath(memoryDir), "utf8"), /## Conversation Updates/);
});

test("refreshLocalMemory skips when root memory is already current", () => {
  const { repoDir, memoryDir } = makeRepo();
  const fakeCodex = makeFakeCodex();
  const first = refreshLocalMemory(repoDir, memoryDir, {
    codexBin: fakeCodex,
    timeoutMs: 5000,
  });
  const second = refreshLocalMemory(repoDir, memoryDir, {
    codexBin: fakeCodex,
    timeoutMs: 5000,
  });

  assert.equal(first.refreshed, true);
  assert.equal(second.refreshed, false);
  assert.equal(second.reason, "not_needed");
});

test("refreshLocalMemory regenerates when the prior memory used a different input source", () => {
  const { repoDir, memoryDir } = makeRepo();
  const fakeCodex = makeFakeCodex();
  const first = refreshLocalMemory(repoDir, memoryDir, {
    codexBin: fakeCodex,
    timeoutMs: 5000,
  });
  const statePath = memoryStatePath(memoryDir);
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  state.input_memory_dir = path.join(memoryDir, "local-threads");
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf8");

  const second = refreshLocalMemory(repoDir, memoryDir, {
    codexBin: fakeCodex,
    timeoutMs: 5000,
  });

  assert.equal(first.refreshed, true);
  assert.equal(second.refreshed, false);
  assert.equal(second.skipped, true);
  assert.equal(second.reason, "not_needed");
});

test("refreshLocalMemory appends only changed conversation updates", () => {
  const { repoDir, memoryDir } = makeRepo();
  const fakeCodex = makeFakeCodex();
  const first = refreshLocalMemory(repoDir, memoryDir, {
    codexBin: fakeCodex,
    timeoutMs: 5000,
  });
  const before = fs.readFileSync(memoryPath(memoryDir), "utf8");

  const syncedDir = path.join(memoryDir, "synced-threads");
  fs.writeFileSync(
    path.join(syncedDir, "thread-index.json"),
    JSON.stringify([
      { thread_id: "thread-1", title: "First", updated_at: "2026-01-03T00:00:00.000Z" },
      { thread_id: "thread-2", title: "Second", updated_at: "2026-01-01T00:00:00.000Z" },
    ], null, 2) + "\n",
    "utf8",
  );
  fs.appendFileSync(path.join(syncedDir, "threads", "thread-1.jsonl"), `${JSON.stringify({ role: "assistant", message: "new update" })}\n`, "utf8");

  const second = refreshLocalMemory(repoDir, memoryDir, {
    codexBin: fakeCodex,
    timeoutMs: 5000,
  });
  const after = fs.readFileSync(memoryPath(memoryDir), "utf8");

  assert.equal(first.refreshed, true);
  assert.equal(second.refreshed, true);
  assert.match(after, /CLI Repo Summary/);
  assert.equal((after.match(/## Repo Summary/g) || []).length, 1);
  assert.ok(after.length > before.length);
  assert.ok((after.match(/### /g) || []).length >= 2);
});

test("refreshLocalMemory migrates legacy memory format into repo summary plus updates", () => {
  const { repoDir, memoryDir } = makeRepo();
  const fakeCodex = makeFakeCodex();
  fs.writeFileSync(
    memoryPath(memoryDir),
    [
      "## Recent Work",
      "Legacy recent work that should not remain as the top-level format.",
      "",
      "## Repo Overview",
      "Legacy repo overview should become the stable repo summary.",
      "",
      "## Durable Decisions",
      "- Legacy durable notes.",
      "",
    ].join("\n") + "\n",
    "utf8",
  );
  fs.writeFileSync(
    memoryStatePath(memoryDir),
    JSON.stringify({ schema_version: "1.0", updated_at: "2026-01-01T00:00:00.000Z" }, null, 2) + "\n",
    "utf8",
  );

  const result = refreshLocalMemory(repoDir, memoryDir, {
    codexBin: fakeCodex,
    timeoutMs: 5000,
  });
  const memoryText = fs.readFileSync(memoryPath(memoryDir), "utf8");

  assert.equal(result.refreshed, true);
  assert.equal(result.skipped, false);
  assert.match(memoryText, /# Repo Memory/);
  assert.match(memoryText, /## Repo Summary/);
  assert.match(memoryText, /Legacy repo overview should become the stable repo summary\./);
  assert.match(memoryText, /## Conversation Updates/);
  assert.doesNotMatch(memoryText, /^## Recent Work/m);
});

test("refreshLocalMemory rewrites old append-era memory layout into the current format", () => {
  const { repoDir, memoryDir } = makeRepo();
  const fakeCodex = makeFakeCodex();
  fs.writeFileSync(
    memoryPath(memoryDir),
    [
      "## Recent Work",
      "Old layout top section.",
      "",
      "## Repo Overview",
      "Old layout overview should become the repo summary.",
      "",
      "## Conversation Updates",
      "### 2026-01-01T00:00:00.000Z",
      "- Existing appended note.",
      "",
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(
    memoryStatePath(memoryDir),
    JSON.stringify({
      schema_version: "2.0",
      mode: "append_log",
      append_mode_enabled: true,
      processed_threads: {},
      input_memory_dir: path.join(memoryDir, "synced-threads"),
    }, null, 2) + "\n",
    "utf8",
  );

  const result = refreshLocalMemory(repoDir, memoryDir, {
    codexBin: fakeCodex,
    timeoutMs: 5000,
  });
  const memoryText = fs.readFileSync(memoryPath(memoryDir), "utf8");

  assert.equal(result.refreshed, true);
  assert.match(memoryText, /# Repo Memory/);
  assert.match(memoryText, /## Repo Summary/);
  assert.match(memoryText, /Old layout overview should become the repo summary\./);
  assert.match(memoryText, /### 2026-01-01T00:00:00.000Z/);
  assert.match(memoryText, /Existing appended note\./);
});
