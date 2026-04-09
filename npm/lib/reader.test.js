const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  extractRecords,
  renderContextPack,
  renderSearchResults,
  renderStatus,
  searchRaw,
} = require("./reader");

function makeFixtureMemory() {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-handoff-reader-"));
  const memoryDir = path.join(repoDir, ".codex-handoff");
  const threadsDir = path.join(memoryDir, "threads");
  fs.mkdirSync(threadsDir, { recursive: true });
  fs.writeFileSync(path.join(memoryDir, "latest.md"), "# Current State\n\n- Last assistant message: reader test\n", "utf8");
  fs.writeFileSync(path.join(memoryDir, "memory.md"), "# Repo Memory\n\n- Durable memory note.\n", "utf8");
  fs.writeFileSync(
    path.join(memoryDir, "handoff.json"),
    JSON.stringify(
      {
        current_goal: "Validate restore output.",
        status_summary: "Testing the Node reader.",
        active_branch: "main",
        next_prompt: "Run resume and inspect the ranked evidence.",
        search_hints: ["scene-evidence", "restore", "reader"],
        related_files: ["src/app.ts", "README.md"],
        decisions: [{ summary: "Use latest.md first.", rationale: "Fast bootstrap." }],
        todos: [{ summary: "Verify search output.", status: "pending", priority: "high" }],
        recent_commands: [{ command: "codex-handoff --repo . status", purpose: "sanity check" }],
      },
      null,
      2,
    ),
    "utf8",
  );
  fs.writeFileSync(
    path.join(threadsDir, "thread-1.json"),
    JSON.stringify(
      [
        {
          session_id: "sess-1",
          turn_id: "turn-1",
          timestamp: "2026-04-07T00:00:01+09:00",
          role: "assistant",
          phase: "final_answer",
          message: "reader CLI should build a restore pack from scene-evidence notes",
        },
        {
          session_id: "sess-1",
          turn_id: "turn-2",
          timestamp: "2026-04-07T00:00:02+09:00",
          role: "assistant",
          phase: "commentary",
          message: "unrelated output",
        },
      ],
      null,
      2,
    ),
    "utf8",
  );
  return { repoDir, memoryDir };
}

test("searchRaw ranks matching raw records", () => {
  const { memoryDir } = makeFixtureMemory();
  const matches = searchRaw(memoryDir, "scene-evidence", 8);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].session_id, "sess-1");
  assert.equal(matches[0].turn_id, "turn-1");
});

test("extractRecords filters by session and turn", () => {
  const { memoryDir } = makeFixtureMemory();
  const records = extractRecords(memoryDir, { sessionId: "sess-1", turnId: "turn-1" });
  assert.equal(records.length, 1);
  assert.equal(records[0].turn_id, "turn-1");
});

test("renderStatus and renderContextPack include bootstrap and evidence", () => {
  const { repoDir, memoryDir } = makeFixtureMemory();
  const status = renderStatus(repoDir, memoryDir);
  assert.match(status, /current-thread\.json: missing/);
  assert.match(status, /current thread bundle: present/);
  assert.match(status, /memory\.md: present/);
  assert.match(status, /Durable memory note/);
  assert.match(status, /thread files: 1/);
  assert.match(status, /transcript records: 2/);

  const pack = renderContextPack(repoDir, memoryDir, "scene-evidence restore context", { evidenceLimit: 5 });
  assert.match(pack, /# Codex Restore Pack/);
  assert.match(pack, /## Repo Memory/);
  assert.match(pack, /Durable memory note/);
  assert.match(pack, /Validate restore output/);
  assert.match(pack, /Verify search output/);
  assert.match(pack, /session=sess-1/);

  const renderedSearch = renderSearchResults("scene-evidence", searchRaw(memoryDir, "scene-evidence", 8));
  assert.match(renderedSearch, /matches: 1/);
  assert.match(renderedSearch, /turn=turn-1/);
});
