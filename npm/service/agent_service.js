#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const process = require("node:process");

const { serviceState, clearServiceState } = require("../lib/agent-runtime");
const { detectCodexProcesses, findScriptProcessPids } = require("../lib/process-utils");
const { summarizeMemoryWithCodex } = require("../lib/memory");
const { loadRepoR2Profile } = require("../lib/repo-auth");
const { exportRepoThreads, pullRepoMemorySnapshot, syncNow } = require("../lib/sync");
const { watchServiceState, isWatchServiceRunning, startWatchService, stopWatchService } = require("../lib/watch-runtime");
const { loadRepoState } = require("../lib/workspace");
const { AgentController } = require("./agent_controller");
const { agentServiceStatePath, packageVersionFromHere, resolveCodexHome, resolveConfigDir, watchServiceStatePath } = require("./common");
const { loadManagedRepos } = require("./repo_registry");

const DEFAULT_POLL_INTERVAL_MS = 2000;
const PACKAGE_VERSION = packageVersionFromHere(__filename);

function parseArgs(argv) {
  const result = {
    codexHome: resolveCodexHome(),
    configDir: resolveConfigDir(),
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--codex-home") {
      result.codexHome = path.resolve(argv[index + 1]);
      index += 1;
    } else if (arg === "--config-dir") {
      result.configDir = path.resolve(argv[index + 1]);
      index += 1;
    } else if (arg === "--poll-interval-ms") {
      result.pollIntervalMs = Number(argv[index + 1]) || DEFAULT_POLL_INTERVAL_MS;
      index += 1;
    }
  }
  return result;
}

function createLogger(configDir) {
  const logPath = path.join(configDir, "logs", "agent-service.log");
  return {
    logPath,
    write(message) {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.appendFileSync(logPath, `[agent-service] ${new Date().toISOString()} ${message}\n`, "utf8");
    },
  };
}

function writeState(configDir, payload) {
  const statePath = agentServiceStatePath(configDir);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const previous = serviceState(configDir) || {};
  fs.writeFileSync(statePath, JSON.stringify({ ...previous, ...payload }, null, 2) + "\n", "utf8");
}

function writeWatchState(configDir, payload) {
  const statePath = watchServiceStatePath(configDir);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(payload, null, 2) + "\n", "utf8");
}

function clearWatchState(configDir) {
  try {
    fs.rmSync(watchServiceStatePath(configDir), { force: true });
  } catch {
    // Ignore cleanup failures.
  }
}

function ensureSingleton(configDir) {
  const existing = serviceState(configDir);
  if (!existing?.pid) {
    return findScriptProcessPids("agent_service.js", { configDir }).some((pid) => pid !== process.pid);
  }
  if (existing.pid === process.pid) {
    return false;
  }
  try {
    process.kill(existing.pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const logger = createLogger(options.configDir);
  const statePath = agentServiceStatePath(options.configDir);
  const startedAt = new Date().toISOString();

  if (ensureSingleton(options.configDir)) {
    logger.write("helper already running");
    return;
  }

  logger.write(`starting helper for ${options.codexHome}`);
  recordManagedRepoEvent(options.configDir, "helper_started", {
    codex_home: options.codexHome,
    pid: process.pid,
  });
  writeState(options.configDir, {
    pid: process.pid,
    started_at: startedAt,
    config_dir: options.configDir,
    codex_home: options.codexHome,
    poll_interval_ms: options.pollIntervalMs,
    package_version: PACKAGE_VERSION,
    phase: "idle",
    watcher: null,
    implementation_mode: "live",
  });

  const controller = new AgentController({
    detectCodexProcesses: async () => detectCodexProcesses(),
    logger: (message) => logger.write(message),
    recordEvent: async (eventName, details) => {
      recordManagedRepoEvent(options.configDir, eventName, details);
    },
    activateWatcher: async () => {
      if (isWatchServiceRunning(options.configDir)) {
        const existing = watchServiceState(options.configDir) || {};
        logger.write(`watch service already running pid=${existing.pid || ""}`);
        recordManagedRepoEvent(options.configDir, "watch_started", {
          pid: existing.pid || null,
          reused: true,
        });
        return {
          ...existing,
          reused: true,
        };
      }
      const watcher = startWatchService({
        configDir: options.configDir,
        codexHome: options.codexHome,
      });
      logger.write(`watch service started pid=${watcher.pid}`);
      recordManagedRepoEvent(options.configDir, "watch_started", watcher);
      return watcher;
    },
    deactivateWatcher: async () => {
      const existing = watchServiceState(options.configDir) || null;
      const stopped = await stopWatchService(options.configDir);
      logger.write(`watch service stopped pid=${existing?.pid || ""}`);
      recordManagedRepoEvent(options.configDir, "watch_stopped", {
        pid: existing?.pid || null,
        stopped_at: new Date().toISOString(),
      });
      clearWatchState(options.configDir);
      return {
        ...stopped,
        previous_pid: existing?.pid || null,
      };
    },
    performStartupSync: async () => runStartupSync(options.configDir, options.codexHome, logger),
    performShutdownSync: async () => runShutdownSync(options.configDir, options.codexHome, logger),
    writeState: async (payload) => {
      writeState(options.configDir, payload);
    },
  });

  const shutdown = async () => {
    logger.write("shutting down helper");
    const existingWatcher = watchServiceState(options.configDir) || null;
    if (existingWatcher?.pid) {
      await stopWatchService(options.configDir);
      recordManagedRepoEvent(options.configDir, "watch_stopped", {
        pid: existingWatcher.pid,
        stopped_at: new Date().toISOString(),
        reason: "helper_shutdown",
      });
    }
    recordManagedRepoEvent(options.configDir, "helper_stopped", {
      stopped_at: new Date().toISOString(),
    });
    clearWatchState(options.configDir);
    clearServiceState(options.configDir);
  };

  process.on("SIGINT", async () => {
    await shutdown();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    await shutdown();
    process.exit(0);
  });
  process.on("exit", () => {
    if (!fs.existsSync(statePath)) {
      clearServiceState(options.configDir);
    }
  });

  await controller.initialize();
  await controller.tick();
  setInterval(() => {
    void controller.tick().catch((error) => {
      logger.write(`tick error: ${error.stack || error.message}`);
      writeState(options.configDir, {
        phase: "error",
        last_error: error.message,
      });
    });
  }, options.pollIntervalMs);
  await new Promise(() => {});
}

async function runStartupSync(configDir, codexHome, logger) {
  const managedRepos = loadManagedRepos(configDir).filter((repo) => fs.existsSync(repo.repoPath));
  const startedAt = new Date().toISOString();
  logger.write(`startup sync invoked for codex_home=${codexHome}`);
  recordManagedRepoEvent(configDir, "startup_sync_started", {
    started_at: startedAt,
    codex_home: codexHome,
    managed_repo_count: managedRepos.length,
  });
  if (managedRepos.length === 0) {
    const completedAt = new Date().toISOString();
    recordManagedRepoEvent(configDir, "startup_sync_completed", {
      completed_at: completedAt,
      managed_repo_count: 0,
    });
    return {
      synced_repo_count: 0,
      skipped_repo_count: 0,
      synced_repos: [],
      errors: [],
      completed_at: completedAt,
    };
  }

  const syncedRepos = [];
  const errors = [];
  let skippedRepoCount = 0;

  for (const repo of managedRepos) {
    const memoryDir = path.join(repo.repoPath, ".codex-handoff");
    const repoState = loadRepoState(memoryDir);
    if (!repoState?.repo_slug || !repoState?.remote_prefix) {
      skippedRepoCount += 1;
      recordManagedRepoEvent(configDir, "startup_sync_repo", {
        repo: repo.repoPath,
        repo_slug: repo.repoSlug,
        status: "skipped",
        reason: "missing_repo_state",
      }, [repo.repoPath]);
      continue;
    }
    try {
      const profile = loadRepoR2Profile(memoryDir);
      const result = await pullRepoMemorySnapshot(repo.repoPath, memoryDir, profile, repoState, { codexHome });
      const entry = {
        repo: repo.repoPath,
        repo_slug: repo.repoSlug,
        status: "pulled",
        downloaded_objects: result.downloaded_objects || 0,
        current_thread: result.current_thread || null,
        imported_thread: result.imported_thread?.thread_id || null,
      };
      syncedRepos.push(entry);
      recordManagedRepoEvent(configDir, "startup_sync_repo", entry, [repo.repoPath]);
    } catch (error) {
      logger.write(`startup sync error ${repo.repoPath}: ${error.message}`);
      const entry = {
        repo: repo.repoPath,
        repo_slug: repo.repoSlug,
        status: "error",
        error: error.message,
      };
      errors.push(entry);
      recordManagedRepoEvent(configDir, "startup_sync_repo", entry, [repo.repoPath]);
    }
  }

  const completedAt = new Date().toISOString();
  recordManagedRepoEvent(configDir, "startup_sync_completed", {
    completed_at: completedAt,
    managed_repo_count: managedRepos.length,
    synced_repo_count: syncedRepos.length,
    skipped_repo_count: skippedRepoCount,
    error_count: errors.length,
  });
  return {
    synced_repo_count: syncedRepos.length,
    skipped_repo_count: skippedRepoCount,
    synced_repos: syncedRepos,
    errors,
    completed_at: completedAt,
  };
}

async function runShutdownSync(configDir, codexHome, logger) {
  const managedRepos = loadManagedRepos(configDir).filter((repo) => fs.existsSync(repo.repoPath));
  const startedAt = new Date().toISOString();
  logger.write(`shutdown sync invoked for codex_home=${codexHome}`);
  recordManagedRepoEvent(configDir, "shutdown_sync_started", {
    started_at: startedAt,
    codex_home: codexHome,
    managed_repo_count: managedRepos.length,
  });
  const syncedRepos = [];
  const errors = [];
  let skippedRepoCount = 0;

  for (const repo of managedRepos) {
    const memoryDir = path.join(repo.repoPath, ".codex-handoff");
    const repoState = loadRepoState(memoryDir);
    if (!repoState?.repo_slug || !repoState?.remote_prefix) {
      skippedRepoCount += 1;
      recordManagedRepoEvent(configDir, "shutdown_sync_repo", {
        repo: repo.repoPath,
        repo_slug: repo.repoSlug,
        status: "skipped",
        reason: "missing_repo_state",
      }, [repo.repoPath]);
      continue;
    }
    try {
      const threads = await exportRepoThreads(repo.repoPath, memoryDir, {
        codexHome,
        includeRawThreads: repoState.include_raw_threads === true,
      });
      const memoryResult = summarizeMemoryWithCodex(repo.repoPath, memoryDir, {
        goal: "Update compact repo-level memory after the Codex window closed.",
        maxThreads: 0,
        maxWords: 900,
        reasoningEffort: "low",
        timeoutMs: 180000,
      });
      const profile = loadRepoR2Profile(memoryDir);
      const pushResult = await syncNow(repo.repoPath, memoryDir, profile, {
        codexHome,
        includeRawThreads: repoState.include_raw_threads === true,
        prefix: repoState.remote_prefix,
      });
      const entry = {
        repo: repo.repoPath,
        repo_slug: repo.repoSlug,
        status: "pushed",
        thread_count: threads.length,
        memory_written: memoryResult.wrote_memory === true,
        objects_uploaded: pushResult.objects_uploaded || 0,
        current_thread: pushResult.current_thread || null,
      };
      syncedRepos.push(entry);
      recordManagedRepoEvent(configDir, "shutdown_sync_repo", entry, [repo.repoPath]);
    } catch (error) {
      logger.write(`shutdown sync error ${repo.repoPath}: ${error.message}`);
      const entry = {
        repo: repo.repoPath,
        repo_slug: repo.repoSlug,
        status: "error",
        error: error.message,
      };
      errors.push(entry);
      recordManagedRepoEvent(configDir, "shutdown_sync_repo", entry, [repo.repoPath]);
    }
  }

  const completedAt = new Date().toISOString();
  recordManagedRepoEvent(configDir, "shutdown_sync_completed", {
    completed_at: completedAt,
    managed_repo_count: managedRepos.length,
    synced_repo_count: syncedRepos.length,
    skipped_repo_count: skippedRepoCount,
    error_count: errors.length,
  });
  return {
    synced_repo_count: syncedRepos.length,
    skipped_repo_count: skippedRepoCount,
    synced_repos: syncedRepos,
    errors,
    completed_at: completedAt,
  };
}

function recordManagedRepoEvent(configDir, eventName, details = {}, repoPaths = null) {
  const timestamp = new Date().toISOString();
  const targets = Array.isArray(repoPaths) && repoPaths.length
    ? repoPaths
    : loadManagedRepos(configDir).map((repo) => repo.repoPath);
  const line = [
    `ts=${timestamp}`,
    `event=${eventName}`,
    ...Object.entries(details).map(([key, value]) => `${key}=${serializeEventValue(value)}`),
  ].join(" | ");
  for (const repoPath of targets) {
    const memoryDir = path.join(repoPath, ".codex-handoff");
    try {
      fs.mkdirSync(memoryDir, { recursive: true });
      fs.appendFileSync(path.join(memoryDir, "agent-events.log"), `${line}\n`, "utf8");
    } catch {
      // Ignore event log write failures for individual repos.
    }
  }
}

function serializeEventValue(value) {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

main().catch((error) => {
  const configDir = resolveConfigDir();
  const logger = createLogger(configDir);
  logger.write(`fatal: ${error.stack || error.message}`);
  writeState(configDir, {
    phase: "error",
    last_error: error.message,
  });
  process.exit(1);
});
