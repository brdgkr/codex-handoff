#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const process = require("node:process");

const { serviceState, clearServiceState } = require("../lib/agent-runtime");
const { memoryNeedsRefresh, refreshLocalMemory } = require("../lib/memory");
const { detectCodexProcesses, findScriptProcessPids } = require("../lib/process-utils");
const { loadRepoR2Profile } = require("../lib/repo-auth");
const { buildLocalResultFromMemoryDir, pullRepoMemorySnapshot, pushChangedThreads, pushRepoControlFiles } = require("../lib/sync");
const { watchServiceState, isWatchServiceRunning, startWatchService, stopWatchService } = require("../lib/watch-runtime");
const { loadRepoState, localThreadsDir, syncedThreadsDir } = require("../lib/workspace");
const { AgentController } = require("./agent_controller");
const { agentServiceStatePath, packageVersionFromHere, resolveCodexHome, resolveConfigDir, watchServiceStatePath } = require("./common");
const { ensureManagedRepoState, loadManagedRepos } = require("./repo_registry");

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

function repoStateMetadataChanged(previousRepoState, repoState) {
  return (
    previousRepoState.git_origin_url !== repoState.git_origin_url ||
    JSON.stringify(previousRepoState.git_origin_urls || []) !== JSON.stringify(repoState.git_origin_urls || []) ||
    previousRepoState.repo_path !== repoState.repo_path ||
    previousRepoState.workspace_root !== repoState.workspace_root
  );
}

async function runBackgroundRepoMetadataRefresh(configDir, logger) {
  const managedRepos = loadManagedRepos(configDir).filter((repo) => fs.existsSync(repo.repoPath));
  let refreshedRepoCount = 0;
  let remoteUpdatedRepoCount = 0;
  for (const repo of managedRepos) {
    const memoryDir = path.join(repo.repoPath, ".codex-handoff");
    const previousRepoState = loadRepoState(memoryDir);
    const repoState = ensureManagedRepoState(memoryDir, repo, { configDir });
    if (!repoState?.repo_slug || !repoStateMetadataChanged(previousRepoState, repoState)) {
      continue;
    }
    refreshedRepoCount += 1;
    logger.write(`background repo metadata refresh ${repo.repoPath}: git_origin_url=${repoState.git_origin_url || ""}`);
    try {
      const profile = loadRepoR2Profile(memoryDir);
      await pushRepoControlFiles(profile, memoryDir, [repoState.remote_prefix], ["manifest.json"]);
      remoteUpdatedRepoCount += 1;
    } catch (error) {
      logger.write(`background repo metadata remote update skipped ${repo.repoPath}: ${error.message}`);
    }
  }
  return {
    refreshed_repo_count: refreshedRepoCount,
    remote_updated_repo_count: remoteUpdatedRepoCount,
  };
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
    performActivationSync: async () => runStartupSync(options.configDir, options.codexHome, logger, { reason: "activation" }),
    performBackgroundRefresh: async () => runBackgroundRepoMetadataRefresh(options.configDir, logger),
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

function refreshRepoMemory(repoPath, memoryDir, logger) {
  try {
    const result = refreshLocalMemory(repoPath, memoryDir);
    return {
      status: result.skipped ? "skipped" : "refreshed",
      refreshed: result.refreshed === true,
      skipped: result.skipped === true,
      reason: result.reason || null,
      memory_path: result.memory_path || null,
      input_memory_dir: result.input_memory_dir || null,
    };
  } catch (error) {
    logger.write(`memory refresh error ${repoPath}: ${error.message}`);
    return {
      status: "error",
      refreshed: false,
      skipped: false,
      reason: "error",
      error: error.message,
    };
  }
}

function shouldRefreshRepoMemoryFromPull(pullResult) {
  return Number(pullResult?.downloaded_objects || 0) > 0;
}

function shouldRefreshRepoMemoryForRepo(memoryDir, pullResult) {
  if (shouldRefreshRepoMemoryFromPull(pullResult)) {
    return true;
  }
  return memoryNeedsRefresh(memoryDir, syncedThreadsDir(memoryDir));
}

function summarizeMemoryCase(memoryRefresh) {
  if (memoryRefresh?.error) {
    return "memory_error";
  }
  if (memoryRefresh?.refreshed) {
    return "memory_refreshed";
  }
  if (memoryRefresh?.reason === "no_synced_thread_change") {
    return "memory_skipped_no_synced_thread_change";
  }
  if (memoryRefresh?.reason === "not_needed") {
    return "memory_skipped_not_needed";
  }
  return "memory_skipped";
}

function summarizeThreadCase(result) {
  if (result?.current_thread && result?.imported_thread?.thread_id) {
    return "current_thread_imported";
  }
  if (result?.current_thread) {
    return "current_thread_available";
  }
  return "no_current_thread";
}

function summarizeRepoSyncCase({ status, syncedThreadsChanged, memoryRefresh, recoveryResult, result }) {
  if (status === "error") {
    return "repo_sync_error";
  }
  if (status === "skipped") {
    return "repo_skipped_missing_repo_state";
  }
  if (syncedThreadsChanged) {
    if (memoryRefresh?.error) {
      return "repo_changed_memory_error";
    }
    if (memoryRefresh?.refreshed) {
      return "repo_changed_memory_refreshed";
    }
    return "repo_changed_memory_skipped";
  }
  if ((recoveryResult?.objects_uploaded || 0) > 0 && result?.current_thread) {
    if (memoryRefresh?.refreshed) {
      return "repo_unchanged_memory_refreshed_recovery_uploaded_current_thread";
    }
    return "repo_unchanged_recovery_uploaded_current_thread";
  }
  if ((recoveryResult?.objects_uploaded || 0) > 0) {
    if (memoryRefresh?.refreshed) {
      return "repo_unchanged_memory_refreshed_recovery_uploaded";
    }
    return "repo_unchanged_recovery_uploaded";
  }
  if (memoryRefresh?.refreshed) {
    return "repo_unchanged_memory_refreshed";
  }
  return "repo_unchanged_no_synced_thread_change";
}

function summarizeCompletionCase({ changedRepoCount, unchangedRepoCount, skippedRepoCount, errorCount }) {
  if (errorCount > 0 && changedRepoCount === 0 && unchangedRepoCount === 0 && skippedRepoCount === 0) {
    return "errors_only";
  }
  if (errorCount > 0) {
    return "completed_with_errors";
  }
  if (changedRepoCount > 0 && unchangedRepoCount === 0 && skippedRepoCount === 0) {
    return "all_changed";
  }
  if (changedRepoCount === 0 && unchangedRepoCount > 0 && skippedRepoCount === 0) {
    return "all_unchanged";
  }
  if (changedRepoCount === 0 && unchangedRepoCount === 0 && skippedRepoCount > 0) {
    return "all_skipped";
  }
  if (changedRepoCount > 0 && unchangedRepoCount > 0 && skippedRepoCount === 0) {
    return "mixed_changed_and_unchanged";
  }
  if (changedRepoCount > 0 && unchangedRepoCount === 0 && skippedRepoCount > 0) {
    return "changed_with_skips";
  }
  if (changedRepoCount === 0 && unchangedRepoCount > 0 && skippedRepoCount > 0) {
    return "unchanged_with_skips";
  }
  if (changedRepoCount > 0 && unchangedRepoCount > 0 && skippedRepoCount > 0) {
    return "mixed_with_skips";
  }
  return "no_managed_repos";
}

function summarizeCompletionMemoryCase({ refreshedMemoryRepoCount, skippedMemoryRepoCount, errorCount }) {
  if (errorCount > 0) {
    return "memory_mixed_with_errors";
  }
  if (refreshedMemoryRepoCount > 0 && skippedMemoryRepoCount === 0) {
    return "all_memory_refreshed";
  }
  if (refreshedMemoryRepoCount === 0 && skippedMemoryRepoCount > 0) {
    return "all_memory_skipped";
  }
  if (refreshedMemoryRepoCount > 0 && skippedMemoryRepoCount > 0) {
    return "mixed_memory_actions";
  }
  return "no_memory_actions";
}

async function runStartupSync(configDir, codexHome, logger, { reason = "startup", deps = {} } = {}) {
  const loadManagedReposFn = deps.loadManagedRepos || loadManagedRepos;
  const loadRepoStateFn = deps.loadRepoState || loadRepoState;
  const ensureManagedRepoStateFn = deps.ensureManagedRepoState || ensureManagedRepoState;
  const loadRepoR2ProfileFn = deps.loadRepoR2Profile || loadRepoR2Profile;
  const pushRepoControlFilesFn = deps.pushRepoControlFiles || pushRepoControlFiles;
  const buildLocalResultFromMemoryDirFn = deps.buildLocalResultFromMemoryDir || buildLocalResultFromMemoryDir;
  const pushChangedThreadsFn = deps.pushChangedThreads || pushChangedThreads;
  const pullRepoMemorySnapshotFn = deps.pullRepoMemorySnapshot || pullRepoMemorySnapshot;
  const refreshRepoMemoryFn = deps.refreshRepoMemory || refreshRepoMemory;
  const shouldRefreshRepoMemoryForRepoFn = deps.shouldRefreshRepoMemoryForRepo || shouldRefreshRepoMemoryForRepo;
  const managedRepos = loadManagedReposFn(configDir).filter((repo) => fs.existsSync(repo.repoPath));
  const startedAt = new Date().toISOString();
  logger.write(`${reason} sync invoked for codex_home=${codexHome}`);
  recordManagedRepoEvent(configDir, `${reason}_sync_started`, {
    started_at: startedAt,
    codex_home: codexHome,
    managed_repo_count: managedRepos.length,
  });
  if (managedRepos.length === 0) {
    const completedAt = new Date().toISOString();
    recordManagedRepoEvent(configDir, `${reason}_sync_completed`, {
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
  let changedRepoCount = 0;
  let unchangedRepoCount = 0;
  let refreshedMemoryRepoCount = 0;
  let skippedMemoryRepoCount = 0;

  for (const repo of managedRepos) {
    const memoryDir = path.join(repo.repoPath, ".codex-handoff");
    const previousRepoState = loadRepoStateFn(memoryDir);
    const repoState = ensureManagedRepoStateFn(memoryDir, repo, { configDir });
    const repoStateChanged = repoStateMetadataChanged(previousRepoState, repoState);
    if (!repoState?.repo_slug || !repoState?.remote_prefix) {
      skippedRepoCount += 1;
      recordManagedRepoEvent(configDir, `${reason}_sync_repo`, {
        repo: repo.repoPath,
        repo_slug: repo.repoSlug,
        status: "skipped",
        reason: "missing_repo_state",
      }, [repo.repoPath]);
      continue;
    }
    try {
      const profile = loadRepoR2ProfileFn(memoryDir);
      if (repoStateChanged) {
        await pushRepoControlFilesFn(profile, memoryDir, [repoState.remote_prefix], ["manifest.json"]);
      }
      const recoveryDir = localThreadsDir(memoryDir);
      const recoveryLocalResult = buildLocalResultFromMemoryDirFn(recoveryDir);
      let recoveryResult = null;
      if (recoveryLocalResult.changed_paths.length > 0) {
        recoveryResult = await pushChangedThreadsFn(repo.repoPath, memoryDir, profile, {
          prefix: repoState.remote_prefix,
          localResult: recoveryLocalResult,
          sourceDir: recoveryDir,
          mirrorOnSuccess: false,
          command: "startup-recovery",
        });
      }
      const result = await pullRepoMemorySnapshotFn(repo.repoPath, memoryDir, profile, repoState, { codexHome });
      const syncedThreadsChanged = shouldRefreshRepoMemoryFromPull(result);
      const shouldRefreshMemory = shouldRefreshRepoMemoryForRepoFn(memoryDir, result);
      const memoryRefresh = shouldRefreshMemory
        ? refreshRepoMemoryFn(repo.repoPath, memoryDir, logger)
        : {
            status: "skipped",
            refreshed: false,
            skipped: true,
            reason: "no_synced_thread_change",
          };
      const entry = {
        repo: repo.repoPath,
        repo_slug: repo.repoSlug,
        status: syncedThreadsChanged ? "pulled" : "unchanged",
        downloaded_objects: result.downloaded_objects || 0,
        synced_threads_changed: syncedThreadsChanged,
        recovery_uploaded_objects: recoveryResult?.objects_uploaded || 0,
        current_thread: result.current_thread || null,
        imported_thread: result.imported_thread?.thread_id || null,
        memory_status: memoryRefresh.status,
        memory_refreshed: memoryRefresh.refreshed,
        memory_reason: memoryRefresh.reason || null,
        sync_case: summarizeRepoSyncCase({
          status: syncedThreadsChanged ? "pulled" : "unchanged",
          syncedThreadsChanged,
          memoryRefresh,
          recoveryResult,
          result,
        }),
        memory_case: summarizeMemoryCase(memoryRefresh),
        thread_case: summarizeThreadCase(result),
      };
      if (memoryRefresh.error) {
        entry.memory_error = memoryRefresh.error;
      }
      if (syncedThreadsChanged) {
        changedRepoCount += 1;
      } else {
        unchangedRepoCount += 1;
      }
      if (memoryRefresh.refreshed) {
        refreshedMemoryRepoCount += 1;
      } else {
        skippedMemoryRepoCount += 1;
      }
      syncedRepos.push(entry);
      recordManagedRepoEvent(configDir, `${reason}_sync_repo`, entry, [repo.repoPath]);
    } catch (error) {
      logger.write(`${reason} sync error ${repo.repoPath}: ${error.message}`);
      const entry = {
        repo: repo.repoPath,
        repo_slug: repo.repoSlug,
        status: "error",
        error: error.message,
      };
      errors.push(entry);
      recordManagedRepoEvent(configDir, `${reason}_sync_repo`, entry, [repo.repoPath]);
    }
  }

  const completedAt = new Date().toISOString();
  const completionEntry = {
    completed_at: completedAt,
    managed_repo_count: managedRepos.length,
    processed_repo_count: syncedRepos.length,
    synced_repo_count: changedRepoCount,
    changed_repo_count: changedRepoCount,
    unchanged_repo_count: unchangedRepoCount,
    skipped_repo_count: skippedRepoCount,
    refreshed_memory_repo_count: refreshedMemoryRepoCount,
    skipped_memory_repo_count: skippedMemoryRepoCount,
    error_count: errors.length,
    completion_case: summarizeCompletionCase({
      changedRepoCount,
      unchangedRepoCount,
      skippedRepoCount,
      errorCount: errors.length,
    }),
    memory_case: summarizeCompletionMemoryCase({
      refreshedMemoryRepoCount,
      skippedMemoryRepoCount,
      errorCount: errors.length,
    }),
  };
  recordManagedRepoEvent(configDir, `${reason}_sync_completed`, completionEntry);
  return {
    processed_repo_count: syncedRepos.length,
    synced_repo_count: changedRepoCount,
    changed_repo_count: changedRepoCount,
    unchanged_repo_count: unchangedRepoCount,
    skipped_repo_count: skippedRepoCount,
    refreshed_memory_repo_count: refreshedMemoryRepoCount,
    skipped_memory_repo_count: skippedMemoryRepoCount,
    synced_repos: syncedRepos,
    errors,
    completed_at: completedAt,
  };
}

async function runShutdownSync(configDir, codexHome, logger) {
  logger.write(`shutdown sync invoked for codex_home=${codexHome}`);
  recordManagedRepoEvent(configDir, "shutdown_sync_started", {
    started_at: new Date().toISOString(),
    codex_home: codexHome,
    managed_repo_count: loadManagedRepos(configDir).filter((repo) => fs.existsSync(repo.repoPath)).length,
  });
  const completedAt = new Date().toISOString();
  recordManagedRepoEvent(configDir, "shutdown_sync_completed", {
    completed_at: completedAt,
    managed_repo_count: loadManagedRepos(configDir).filter((repo) => fs.existsSync(repo.repoPath)).length,
    synced_repo_count: 0,
    skipped_repo_count: 0,
    error_count: 0,
    mode: "noop",
  });
  return {
    synced_repo_count: 0,
    skipped_repo_count: 0,
    synced_repos: [],
    errors: [],
    mode: "noop",
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

if (require.main === module) {
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
}

module.exports = {
  createLogger,
  main,
  parseArgs,
  recordManagedRepoEvent,
  refreshRepoMemory,
  repoStateMetadataChanged,
  runBackgroundRepoMetadataRefresh,
  runShutdownSync,
  runStartupSync,
  serializeEventValue,
  shouldRefreshRepoMemoryFromPull,
  summarizeCompletionCase,
  summarizeCompletionMemoryCase,
  summarizeMemoryCase,
  summarizeRepoSyncCase,
  summarizeThreadCase,
  writeState,
};
