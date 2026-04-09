const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { loadConfig, saveConfig } = require("./runtime-config");

test("loadConfig dedupes Windows repo path variants by normalized path", () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-handoff-runtime-config-"));
  const filePath = path.join(configDir, "config.json");
  fs.writeFileSync(
    filePath,
    JSON.stringify(
      {
        repos: {
          "D:\\source\\repos\\ideook\\codex-handoff": {
            repo_slug: "old-entry",
            updated_at: "2026-04-01T00:00:00.000Z",
          },
          "d:/source/repos/ideook/codex-handoff": {
            repo_slug: "new-entry",
            updated_at: "2026-04-09T00:00:00.000Z",
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  const config = loadConfig(configDir);
  assert.deepEqual(Object.keys(config.repos), ["D:\\source\\repos\\ideook\\codex-handoff"]);
  assert.equal(config.repos["D:\\source\\repos\\ideook\\codex-handoff"].repo_slug, "new-entry");
  assert.equal(config.repos["D:\\source\\repos\\ideook\\codex-handoff"].remote_auth_type, "global_dotenv");
  assert.equal(config.repos["D:\\source\\repos\\ideook\\codex-handoff"].remote_auth_path, "~/.codex-handoff/.env.local");
});

test("saveConfig writes normalized repo mapping keys", () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-handoff-runtime-config-"));

  saveConfig(configDir, {
    repos: {
      "d:/source/repos/ideook/codex-handoff": {
        repo_slug: "ideook-codex-handoff",
      },
    },
  });

  const persisted = JSON.parse(fs.readFileSync(path.join(configDir, "config.json"), "utf8"));
  assert.deepEqual(Object.keys(persisted.repos), ["D:\\source\\repos\\ideook\\codex-handoff"]);
});
