const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { parseArgs, resolveRepoSlug } = require("./cli");
const { buildRepoState } = require("./lib/workspace");

const cliPath = path.join(__dirname, "bin", "codex-handoff.js");

function makeFixtureRepo() {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-handoff-cli-"));
  const memoryDir = path.join(repoDir, ".codex-handoff");
  const threadsDir = path.join(memoryDir, "threads");
  fs.mkdirSync(threadsDir, { recursive: true });
  fs.writeFileSync(
    path.join(threadsDir, "thread-1.json"),
    JSON.stringify(
      [
        {
          session_id: "sess-1",
          turn_id: "turn-0",
          timestamp: "2026-04-07T00:00:00+09:00",
          role: "user",
          phase: null,
          message: "Validate restore output.",
        },
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
  fs.writeFileSync(
    path.join(memoryDir, "repo.json"),
    JSON.stringify(
      {
        repo_path: repoDir,
        repo_slug: "fixture-remote",
        remote_auth_type: "global_dotenv",
        remote_auth_path: "~/.codex-handoff/.env.local",
        remote_prefix: "repos/fixture-remote/",
        summary_mode: "heuristic",
        include_raw_threads: false,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(memoryDir, "sync-state.json"),
    JSON.stringify(
      {
        schema_version: "1.0",
        repo: repoDir,
        repo_slug: "fixture-remote",
        remote_auth_type: "global_dotenv",
        remote_auth_path: "~/.codex-handoff/.env.local",
        remote_prefix: "repos/fixture-remote/",
        last_sync_at: "2026-04-07T00:00:00Z",
        last_sync_direction: "push",
        last_sync_command: "now",
        current_thread: "thread-1",
        thread_count: 1,
        thread_ids: ["thread-1"],
        materialized_root: {
          current_thread_present: true,
          thread_index_present: true,
        },
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(memoryDir, "thread-index.json"),
    JSON.stringify([{
      thread_id: "thread-1",
      title: "Fixture Thread",
      thread_name: "Fixture Thread",
      created_at: 1,
      updated_at: 1,
      source_session_relpath: "sessions/2026/04/07/rollout-thread-1.jsonl",
      bundle_path: "threads/thread-1.json"
    }], null, 2) + "\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(memoryDir, "current-thread.json"),
    JSON.stringify({ thread_id: "thread-1" }, null, 2) + "\n",
    "utf8",
  );
  return repoDir;
}

function runGit(repoDir, ...args) {
  execFileSync("git", args, {
    cwd: repoDir,
    stdio: "ignore",
  });
}

test("CLI defaults to skipping raw thread archives and allows explicit opt-in", () => {
  const defaults = parseArgs(["threads", "export"]);
  assert.equal(defaults.includeRawThreads, null);

  const skipped = parseArgs(["threads", "export", "--skip-raw-threads"]);
  assert.equal(skipped.includeRawThreads, false);

  const included = parseArgs(["threads", "export", "--include-raw-threads"]);
  assert.equal(included.includeRawThreads, true);

  const loginIfNeeded = parseArgs(["setup", "--login-if-needed"]);
  assert.equal(loginIfNeeded.loginIfNeeded, true);
});

test("new repo state defaults to raw thread archives disabled", () => {
  const repoState = buildRepoState("/tmp/codex-handoff-cli-fixture", {
    profileName: "default",
    machineId: "machine-1",
  });

  assert.equal(repoState.include_raw_threads, false);
});

test("resolveRepoSlug prefers the current origin-derived slug over stale local state", () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-handoff-slug-refresh-"));
  const memoryDir = path.join(repoDir, ".codex-handoff");
  fs.mkdirSync(memoryDir, { recursive: true });
  runGit(repoDir, "init");
  runGit(repoDir, "remote", "add", "origin", "https://github.com/brdgkr/codex-handoff.git");
  fs.writeFileSync(
    path.join(memoryDir, "repo.json"),
    JSON.stringify({
      repo_slug: "ideook-codex-handoff",
      match_status: "create_new",
      git_origin_url: "https://github.com/brdgkr/codex-handoff.git",
      git_origin_urls: ["https://github.com/ideook/codex-handoff.git"],
    }, null, 2) + "\n",
    "utf8",
  );

  const result = resolveRepoSlug(repoDir, memoryDir, {}, [
    { repo_slug: "ideook-codex-handoff" },
    { repo_slug: "brdgkr-codex-handoff" },
  ], { project_name: "codex-handoff" });

  assert.deepEqual(result, {
    repo_slug: "brdgkr-codex-handoff",
    match_status: "matched_remote_inferred",
  });
});

test("resolveRepoSlug creates a new inferred slug when local state is stale and the new remote does not exist yet", () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-handoff-slug-create-"));
  const memoryDir = path.join(repoDir, ".codex-handoff");
  fs.mkdirSync(memoryDir, { recursive: true });
  runGit(repoDir, "init");
  runGit(repoDir, "remote", "add", "origin", "https://github.com/brdgkr/codex-handoff.git");
  fs.writeFileSync(
    path.join(memoryDir, "repo.json"),
    JSON.stringify({
      repo_slug: "ideook-codex-handoff",
      match_status: "create_new",
    }, null, 2) + "\n",
    "utf8",
  );

  const result = resolveRepoSlug(repoDir, memoryDir, {}, [
    { repo_slug: "ideook-codex-handoff", git_origin_url: "https://github.com/brdgkr/codex-handoff.git" },
  ], { project_name: "codex-handoff" });

  assert.deepEqual(result, {
    repo_slug: "brdgkr-codex-handoff",
    match_status: "create_new",
  });
});

test("resolveRepoSlug preserves an explicit local remote slug selection", () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-handoff-slug-explicit-"));
  const memoryDir = path.join(repoDir, ".codex-handoff");
  fs.mkdirSync(memoryDir, { recursive: true });
  runGit(repoDir, "init");
  runGit(repoDir, "remote", "add", "origin", "https://github.com/brdgkr/codex-handoff.git");
  fs.writeFileSync(
    path.join(memoryDir, "repo.json"),
    JSON.stringify({
      repo_slug: "ideook-codex-handoff",
      match_status: "explicit",
    }, null, 2) + "\n",
    "utf8",
  );

  const result = resolveRepoSlug(repoDir, memoryDir, {}, [
    { repo_slug: "ideook-codex-handoff" },
    { repo_slug: "brdgkr-codex-handoff" },
  ], { project_name: "codex-handoff" });

  assert.deepEqual(result, {
    repo_slug: "ideook-codex-handoff",
    match_status: "existing_local",
  });
});

function runCli(repoDir, ...args) {
  return execFileSync(process.execPath, [cliPath, "--repo", repoDir, ...args], {
    cwd: path.join(__dirname, ".."),
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_NO_WARNINGS: "1",
    },
  });
}

test("CLI status/search/resume/sync status work through the Node entrypoint", () => {
  const repoDir = makeFixtureRepo();

  const status = runCli(repoDir, "status");
  assert.match(status, /current-thread\.json: present/);
  assert.match(status, /current thread bundle: present/);
  assert.match(status, /thread files: 1/);
  assert.match(status, /transcript records: 3/);

  const search = runCli(repoDir, "search", "scene-evidence");
  assert.match(search, /matches: 1/);
  assert.match(search, /turn=turn-1/);

  const resume = runCli(repoDir, "resume", "--goal", "scene-evidence restore context");
  assert.match(resume, /# Codex Restore Pack/);
  assert.match(resume, /Validate restore output/);

  const syncStatus = runCli(repoDir, "sync", "status");
  const payload = JSON.parse(syncStatus);
  assert.equal(payload.repo_slug, "fixture-remote");
  assert.equal(payload.thread_count, 1);
  assert.equal(payload.sync_health.status, "ok");
});

test("CLI setup reports a friendly error when global R2 credentials are missing", () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-handoff-setup-"));
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-handoff-config-"));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-handoff-home-"));

  let failure = null;
  try {
    execFileSync(process.execPath, [cliPath, "--repo", repoDir, "setup"], {
      cwd: path.join(__dirname, ".."),
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: homeDir,
        CODEX_HANDOFF_CONFIG_DIR: configDir,
        NODE_NO_WARNINGS: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    failure = error;
  }

  assert.ok(failure);
  assert.match(String(failure.stderr || ""), /R2 credentials are required in/);
  assert.equal(fs.existsSync(path.join(configDir, ".env.local")), true);
  assert.doesNotMatch(String(failure.stderr || ""), /npm\/cli\.js:/);
});

test("CLI install command is no longer supported", () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-handoff-install-cmd-"));

  let failure = null;
  try {
    execFileSync(process.execPath, [cliPath, "--repo", repoDir, "install"], {
      cwd: path.join(__dirname, ".."),
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_NO_WARNINGS: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    failure = error;
  }

  assert.ok(failure);
  assert.match(String(failure.stderr || ""), /Not yet ported to Node: install/);
});

test("CLI uninstall detaches the repo and preserves local memory", () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-handoff-uninstall-"));
  const memoryDir = path.join(repoDir, ".codex-handoff");
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(
    path.join(memoryDir, "repo.json"),
    JSON.stringify({ repo_slug: "fixture-remote", remote_auth_type: "global_dotenv", remote_auth_path: "~/.codex-handoff/.env.local" }, null, 2) + "\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(repoDir, "AGENTS.md"),
    [
      "# Local instructions",
      "",
      "<!-- codex-handoff:start -->",
      "managed block",
      "<!-- codex-handoff:end -->",
      "",
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(path.join(repoDir, ".gitignore"), ".codex-handoff/\n", "utf8");

  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-handoff-config-"));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-handoff-home-"));
  fs.writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify(
      {
        repos: {
          [repoDir]: { repo_slug: "fixture-remote" },
        },
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  const output = execFileSync(process.execPath, [cliPath, "--repo", repoDir, "uninstall"], {
    cwd: path.join(__dirname, ".."),
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: homeDir,
      CODEX_HANDOFF_CONFIG_DIR: configDir,
      NODE_NO_WARNINGS: "1",
    },
  });

  const payload = JSON.parse(output);
  assert.equal(payload.uninstall, true);
  assert.equal(payload.detached, true);
  assert.equal(payload.repo_removed, true);
  assert.equal(payload.memory_dir_preserved, true);
  assert.equal(fs.existsSync(memoryDir), true);
  assert.doesNotMatch(fs.readFileSync(path.join(repoDir, "AGENTS.md"), "utf8"), /codex-handoff:start/);
  assert.equal(fs.existsSync(path.join(repoDir, ".gitignore")), false);
});

test("CLI remote login stores credentials in global .codex-handoff/.env.local", () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-handoff-remote-login-"));
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-handoff-config-"));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-handoff-home-"));

  const output = execFileSync(process.execPath, [cliPath, "--repo", repoDir, "remote", "login", "r2", "--from-env"], {
    cwd: path.join(__dirname, ".."),
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: homeDir,
      CODEX_HANDOFF_CONFIG_DIR: configDir,
      CODEX_HANDOFF_R2_ACCOUNT_ID: "acct",
      CODEX_HANDOFF_R2_BUCKET: "bucket",
      CODEX_HANDOFF_R2_ACCESS_KEY_ID: "key",
      CODEX_HANDOFF_R2_SECRET_ACCESS_KEY: "secret",
      NODE_NO_WARNINGS: "1",
    },
  });

  const payload = JSON.parse(output);
  assert.equal(payload.auth_type, "global_dotenv");
  assert.equal(fs.existsSync(path.join(configDir, ".env.local")), true);

  const whoami = JSON.parse(execFileSync(process.execPath, [cliPath, "--repo", repoDir, "remote", "whoami"], {
    cwd: path.join(__dirname, ".."),
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: homeDir,
      CODEX_HANDOFF_CONFIG_DIR: configDir,
      NODE_NO_WARNINGS: "1",
    },
  }));
  assert.equal(whoami.bucket, "bucket");
  assert.equal(whoami.auth_type, "global_dotenv");
  assert.equal(whoami.dotenv_path, path.join(configDir, ".env.local"));
});
