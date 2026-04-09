const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  clearRepoR2Profile,
  ensureRepoDotenvTemplate,
  loadRepoR2Profile,
  repoDotenvPath,
  repoR2ProfileStatus,
  saveRepoR2Profile,
} = require("./repo-auth");

test("ensureRepoDotenvTemplate creates a global .env.local template", () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-handoff-repo-auth-"));
  const filePath = ensureRepoDotenvTemplate(null, configDir);

  assert.equal(filePath, repoDotenvPath(null, configDir));
  assert.equal(fs.existsSync(filePath), true);
  assert.match(fs.readFileSync(filePath, "utf8"), /account_id=/);
});

test("saveRepoR2Profile writes credentials that loadRepoR2Profile reads back", () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-handoff-repo-auth-"));
  saveRepoR2Profile(null, {
    account_id: "acct",
    bucket: "bucket",
    access_key_id: "key",
    secret_access_key: "secret",
  }, configDir);

  const profile = loadRepoR2Profile(null, configDir);
  assert.equal(profile.account_id, "acct");
  assert.equal(profile.bucket, "bucket");
  assert.equal(profile.access_key_id, "key");
  assert.equal(profile.secret_access_key, "secret");
  assert.equal(profile.endpoint, "https://acct.r2.cloudflarestorage.com");
  assert.equal(profile.memory_prefix, "projects/");
});

test("repoR2ProfileStatus reports missing fields for a blank template", () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-handoff-repo-auth-"));
  clearRepoR2Profile(null, configDir);

  const status = repoR2ProfileStatus(null, configDir);
  assert.equal(status.exists, true);
  assert.equal(status.valid, false);
  assert.deepEqual(status.missing_fields, ["account_id", "bucket", "access_key_id", "secret_access_key"]);
});
