const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { buildRepoState, ensureAgentsBlock, refreshRepoStateForCurrentRepo, relocalizeRepoState, removeAgentsBlock, removeMemoryDirGitignoreEntry, unregisterRepoMapping } = require("./workspace");

function runGit(repoDir, ...args) {
  execFileSync("git", args, {
    cwd: repoDir,
    stdio: "ignore",
  });
}

test("buildRepoState excludes raw thread archives by default", () => {
  const repoState = buildRepoState("/tmp/codex-handoff-fixture", {
    profileName: "default",
    machineId: "machine-1",
  });

  assert.equal(repoState.include_raw_threads, false);
});

test("buildRepoState can opt into raw thread archives", () => {
  const repoState = buildRepoState("/tmp/codex-handoff-fixture", {
    profileName: "default",
    machineId: "machine-1",
    includeRawThreads: true,
  });

  assert.equal(repoState.include_raw_threads, true);
});

test("buildRepoState carries previous git origins forward when origin changes", () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-handoff-origin-history-"));
  runGit(repoDir, "init");
  runGit(repoDir, "remote", "add", "origin", "https://github.com/ideook/codex-handoff.git");

  const first = buildRepoState(repoDir, {
    profileName: "default",
    machineId: "machine-1",
  });

  runGit(repoDir, "remote", "set-url", "origin", "https://github.com/brdgkr/codex-handoff.git");
  const second = buildRepoState(repoDir, {
    profileName: "default",
    machineId: "machine-1",
    previousRepoState: first,
  });

  runGit(repoDir, "remote", "set-url", "origin", "git@github.com:new-owner/codex-handoff.git");
  const third = buildRepoState(repoDir, {
    profileName: "default",
    machineId: "machine-1",
    previousRepoState: second,
  });

  assert.equal(first.git_origin_url, "https://github.com/ideook/codex-handoff.git");
  assert.deepEqual(first.git_origin_urls, []);
  assert.deepEqual(first.repo_slug_aliases, []);
  assert.equal(second.git_origin_url, "https://github.com/brdgkr/codex-handoff.git");
  assert.deepEqual(second.git_origin_urls, ["https://github.com/ideook/codex-handoff.git"]);
  assert.deepEqual(second.repo_slug_aliases, ["ideook-codex-handoff"]);
  assert.equal(third.git_origin_url, "git@github.com:new-owner/codex-handoff.git");
  assert.deepEqual(third.git_origin_urls, [
    "https://github.com/brdgkr/codex-handoff.git",
    "https://github.com/ideook/codex-handoff.git",
  ]);
  assert.deepEqual(third.repo_slug_aliases, [
    "ideook-codex-handoff",
    "brdgkr-codex-handoff",
  ]);
});

test("unregisterRepoMapping removes the normalized repo entry", () => {
  const payload = {
    repos: {
      "/workspace/project": { repo_slug: "project" },
      "/workspace/other": { repo_slug: "other" },
    },
  };

  const result = unregisterRepoMapping(payload, "/workspace/project");

  assert.equal(result.removed, true);
  assert.equal(result.remaining_repo_count, 1);
  assert.deepEqual(Object.keys(result.config.repos), ["/workspace/other"]);
});

test("removeAgentsBlock strips the managed block and preserves user content", () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-handoff-agents-"));
  const agentsPath = path.join(repoDir, "AGENTS.md");
  fs.writeFileSync(
    agentsPath,
    [
      "# Local instructions",
      "",
      "Keep tests green.",
      "",
      "<!-- codex-handoff:start -->",
      "managed block",
      "<!-- codex-handoff:end -->",
      "",
    ].join("\n"),
    "utf8",
  );

  const result = removeAgentsBlock(repoDir);

  assert.equal(result.removed, true);
  assert.match(fs.readFileSync(agentsPath, "utf8"), /# Local instructions/);
  assert.doesNotMatch(fs.readFileSync(agentsPath, "utf8"), /codex-handoff:start/);
});

test("ensureAgentsBlock points consumers to memory first and targeted synced thread reads second", () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-handoff-agents-memory-"));
  const repoState = buildRepoState(repoDir, {
    machineId: "machine-1",
    remoteSlug: "project",
  });

  const agentsPath = ensureAgentsBlock(repoDir, repoState);
  const content = fs.readFileSync(agentsPath, "utf8");

  assert.match(content, /Read `.codex-handoff\/memory\.md` first/);
  assert.match(content, /current-thread\.json/);
  assert.match(content, /thread-index\.json/);
  assert.match(content, /remote auth file: `~\/.codex-handoff\/.env.local`/);
  assert.doesNotMatch(content, /local workspace root/);
  assert.doesNotMatch(content, /installed skill path/);
  assert.match(content, /Never enumerate or bulk-read `.codex-handoff\/synced-threads\/threads\/\*\*`/);
});

test("removeMemoryDirGitignoreEntry removes the codex-handoff entry", () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-handoff-ignore-"));
  const memoryDir = path.join(repoDir, ".codex-handoff");
  const gitignorePath = path.join(repoDir, ".gitignore");
  fs.writeFileSync(gitignorePath, "node_modules/\n.codex-handoff/\n", "utf8");

  const result = removeMemoryDirGitignoreEntry(repoDir, memoryDir);

  assert.equal(result.removed, true);
  assert.equal(fs.readFileSync(gitignorePath, "utf8"), "node_modules/\n");
});

test("relocalizeRepoState rewrites foreign machine paths to the current local repo path", () => {
  const repoState = relocalizeRepoState("D:\\source\\repos\\ideook\\codex-handoff", {
    machine_id: "machine-mac",
    project_name: "codex-handoff",
    workspace_root: "/Users/dukhyunlee/development/repos/ideook/codex-handoff",
    repo_path: "/Users/dukhyunlee/development/repos/ideook/codex-handoff",
    repo_slug: "ideook-codex-handoff",
    remote_prefix: "repos/ideook-codex-handoff/",
    include_raw_threads: false,
    summary_mode: "auto",
    match_mode: "auto",
    match_status: "existing_local",
    git_origin_url: "https://github.com/ideook/codex-handoff.git",
  });

  assert.equal(repoState.workspace_root, "D:\\source\\repos\\ideook\\codex-handoff");
  assert.equal(repoState.repo_path, "d:/source/repos/ideook/codex-handoff");
  assert.equal(repoState.remote_auth_type, "global_dotenv");
  assert.equal(repoState.remote_auth_path, "~/.codex-handoff/.env.local");
  assert.equal(repoState.repo_slug, "ideook-codex-handoff");
});

test("refreshRepoStateForCurrentRepo rekeys the remote prefix when git origin changes", () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-handoff-refresh-state-"));
  runGit(repoDir, "init");
  runGit(repoDir, "remote", "add", "origin", "https://github.com/ideook/codex-handoff.git");

  const initial = buildRepoState(repoDir, {
    machineId: "machine-1",
  });

  runGit(repoDir, "remote", "set-url", "origin", "https://github.com/brdgkr/codex-handoff.git");
  const refreshed = refreshRepoStateForCurrentRepo(repoDir, initial);

  assert.equal(refreshed.repo_slug, "brdgkr-codex-handoff");
  assert.equal(refreshed.remote_prefix, "repos/brdgkr-codex-handoff/");
  assert.equal(refreshed.git_origin_url, "https://github.com/brdgkr/codex-handoff.git");
  assert.deepEqual(refreshed.git_origin_urls, ["https://github.com/ideook/codex-handoff.git"]);
});
