const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { memoryPath, memoryStatePath, summarizeMemoryWithCodex } = require("./memory");

function makeRepo() {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-handoff-memory-repo-"));
  const memoryDir = path.join(repoDir, ".codex-handoff");
  fs.mkdirSync(path.join(memoryDir, "threads"), { recursive: true });
  fs.writeFileSync(path.join(memoryDir, "latest.md"), "# Latest\n\nCurrent work.\n", "utf8");
  fs.writeFileSync(path.join(memoryDir, "handoff.json"), JSON.stringify({ current_goal: "memory tests" }, null, 2) + "\n", "utf8");
  fs.writeFileSync(
    path.join(memoryDir, "thread-index.json"),
    JSON.stringify([
      { thread_id: "thread-1", title: "First", updated_at: "2026-01-02T00:00:00.000Z" },
      { thread_id: "thread-2", title: "Second", updated_at: "2026-01-01T00:00:00.000Z" },
    ], null, 2) + "\n",
    "utf8",
  );
  fs.writeFileSync(path.join(memoryDir, "threads", "thread-1.json"), JSON.stringify([{ role: "user", message: "hello" }], null, 2) + "\n", "utf8");
  fs.writeFileSync(path.join(memoryDir, "threads", "thread-2.json"), JSON.stringify([{ role: "user", message: "old" }], null, 2) + "\n", "utf8");
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
      "fs.writeFileSync(output, ['# Fake Memory', '', `cwd=${process.cwd()}`, `isolated=${prompt.includes('Do not inspect the original repository checkout.')}`].join('\\n') + '\\n', 'utf8');",
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
    keepTemp: true,
    maxThreads: 1,
    timeoutMs: 5000,
  });

  assert.equal(result.wrote_memory, true);
  assert.equal(fs.existsSync(memoryPath(memoryDir)), true);
  assert.equal(fs.existsSync(memoryStatePath(memoryDir)), true);
  assert.match(fs.readFileSync(memoryPath(memoryDir), "utf8"), /# Fake Memory/);
  assert.match(fs.readFileSync(memoryPath(memoryDir), "utf8"), /isolated=true/);
  assert.notEqual(result.temp_dir, repoDir);
  assert.equal(result.state.input_manifest.generated_files[0].path, "thread-digest.json");
  assert.equal(result.state.input_manifest.generated_files[0].thread_count, 2);
  assert.equal(result.state.input_manifest.selected_threads.length, 1);
  assert.equal(result.state.input_manifest.selected_threads[0].thread_id, "thread-1");

  fs.rmSync(result.temp_dir, { recursive: true, force: true });
});

test("summarizeMemoryWithCodex dry run returns summary without writing root memory", () => {
  const { repoDir, memoryDir } = makeRepo();
  const fakeCodex = makeFakeCodex();
  const result = summarizeMemoryWithCodex(repoDir, memoryDir, {
    codexBin: fakeCodex,
    dryRun: true,
    maxThreads: 0,
    timeoutMs: 5000,
  });

  assert.equal(result.dry_run, true);
  assert.equal(result.wrote_memory, false);
  assert.match(result.summary, /# Fake Memory/);
  assert.equal(fs.existsSync(memoryPath(memoryDir)), false);
  assert.equal(fs.existsSync(memoryStatePath(memoryDir)), false);
});
