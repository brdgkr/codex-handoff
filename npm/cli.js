#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const { serviceState, isRunning, startAgentService, stopAgentService } = require("./lib/agent-runtime");
const { autostartStatus, disableAutostart, enableAutostart } = require("./lib/autostart");
const { describeCurrentProject } = require("./lib/codex-projects");
const { gitOriginUrlFromRepo } = require("./lib/git-config");
const { cleanupThread, codexPaths, discoverThreadsForRepo, gitOriginAliases, normalizeGitOriginUrl } = require("./lib/local-codex");
const {
  extractRecords,
  renderContextPack,
  renderExtractResults,
  renderSearchResults,
  renderStatus,
  resolveMemoryDir,
  resolveRepoPath,
  searchRaw,
} = require("./lib/reader");
const { cleanupLegacyAuthArtifacts, loadConfig, saveConfig } = require("./lib/runtime-config");
const { findScriptProcessPids } = require("./lib/process-utils");
const {
  DEFAULT_REMOTE_AUTH_PATH,
  DEFAULT_REMOTE_AUTH_TYPE,
  clearRepoR2Profile,
  ensureRepoDotenvTemplate,
  loadRepoR2Profile,
  readR2CredentialsForSource,
  repoDotenvPath,
  repoR2ProfileStatus,
  saveRepoR2Profile,
} = require("./lib/repo-auth");
const { installSkill, installedSkillPath } = require("./lib/skills");
const {
  describeSyncState,
  exportRepoThreads,
  importThreadBundleToCodex,
  pullRepoMemorySnapshot,
  pullMemoryTree,
  pushMemoryTree,
  recordSyncEvent,
  syncNow,
} = require("./lib/sync");
const {
  buildRepoState,
  currentThreadPath,
  ensureAgentsBlock,
  ensureMemoryDirGitignored,
  inferRepoSlug,
  loadRepoState,
  materializedRootPaths,
  removeAgentsBlock,
  removeMemoryDirGitignoreEntry,
  registerRepoMapping,
  saveRepoState,
  unregisterRepoMapping,
} = require("./lib/workspace");
const { deleteR2Object, getR2Object, listR2Objects, putR2Object, validateR2Credentials } = require("./lib/r2");
const { configPath, lifecycleLockPath, packageVersionFromHere, resolveCodexHome, resolveConfigDir } = require("./service/common");

const PACKAGE_VERSION = packageVersionFromHere(__filename);

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const repoPath = resolveRepoPath(args.repo || process.cwd());
  const memoryDir = resolveMemoryDir(repoPath, args.memoryDir);
  const configDir = resolveConfigDir();
  const codexHome = path.resolve(args.codexHome || resolveCodexHome());

  if (!args.command || args.command === "help" || args.help) {
    printHelp();
    return 0;
  }

  if (args.command === "doctor") {
    printJson(doctor(repoPath, memoryDir, configDir, codexHome));
    return 0;
  }

  if (args.command === "status") {
    process.stdout.write(renderStatus(repoPath, memoryDir));
    return 0;
  }

  if (args.command === "search") {
    process.stdout.write(renderSearchResults(args.query || "", searchRaw(memoryDir, args.query || "", Number(args.limit) || 8)));
    return 0;
  }

  if (args.command === "extract") {
    const records = extractRecords(memoryDir, { sessionId: args.session || null, turnId: args.turn || null });
    process.stdout.write(renderExtractResults(records));
    return 0;
  }

  if (args.command === "resume" || args.command === "context-pack") {
    const pack = renderContextPack(repoPath, memoryDir, args.goal || "", { evidenceLimit: Number(args.evidenceLimit) || 5 });
    writeOrPrint(pack, args.output || null);
    return 0;
  }

  if (args.command === "agent") {
    const action = ["start", "stop", "restart", "enable", "disable"].includes(args.subcommand || "")
      ? withLifecycleLock(configDir, () => handleAgent(args, repoPath, memoryDir, configDir, codexHome))
      : Promise.resolve(handleAgent(args, repoPath, memoryDir, configDir, codexHome));
    return Promise.resolve(action).then((payload) => {
      printJson(payload);
      return 0;
    });
  }

  if (args.command === "remote") {
    return Promise.resolve(handleRemote(args, repoPath, memoryDir, configDir));
  }

  if (args.command === "enable") {
    return Promise.resolve(handleEnable(repoPath, memoryDir, configDir, codexHome, args));
  }

  if (args.command === "setup") {
    return Promise.resolve(withLifecycleLock(configDir, () => handleSetup(repoPath, memoryDir, configDir, codexHome, args)));
  }

  if (args.command === "uninstall") {
    return Promise.resolve(withLifecycleLock(configDir, () => handleUninstall(repoPath, memoryDir, configDir, codexHome, args)));
  }

  if (args.command === "receive") {
    return Promise.resolve(withLifecycleLock(configDir, () => handleReceive(repoPath, memoryDir, configDir, codexHome, args)));
  }

  if (args.command === "threads") {
    return Promise.resolve(handleThreads(args, repoPath, memoryDir, codexHome));
  }

  if (args.command === "sync") {
    return Promise.resolve(handleSync(args, repoPath, memoryDir, configDir, codexHome));
  }

  if (args.command === "skill") {
    return handleSkill(args, repoPath);
  }

  console.error(`Not yet ported to Node: ${[args.command, args.subcommand].filter(Boolean).join(" ")}`);
  return 2;
}

async function handleRemote(args, _repoPath, memoryDir, configDir) {
  if (args.subcommand === "whoami") {
    const profile = loadRepoR2Profile(memoryDir);
    printJson({
      provider: "cloudflare-r2",
      account_id: profile.account_id,
      bucket: profile.bucket,
      endpoint: profile.endpoint,
      memory_prefix: profile.memory_prefix,
      access_key_id: mask(profile.access_key_id || ""),
      auth_type: DEFAULT_REMOTE_AUTH_TYPE,
      dotenv_path: repoDotenvPath(memoryDir),
    });
    return 0;
  }
  if (args.subcommand === "validate") {
    const profile = loadRepoR2Profile(memoryDir);
    printJson(await validateR2Credentials(profile));
    return 0;
  }
  if (args.subcommand === "logout") {
    const dotenvPath = clearRepoR2Profile(memoryDir);
    cleanupLegacyAuthArtifacts(configDir);
    saveConfig(configDir, loadConfig(configDir));
    printJson({ cleared: true, auth_type: DEFAULT_REMOTE_AUTH_TYPE, dotenv_path: dotenvPath });
    return 0;
  }
  if (args.subcommand === "login" && args.remoteProvider === "r2") {
    printJson(loginRepoR2Profile(memoryDir, args, configDir));
    return 0;
  }
  if (args.subcommand === "repos") {
    const profile = loadRepoR2Profile(memoryDir);
    const slugs = await listRemoteRepoSlugs(profile);
    const response = {
      auth_type: DEFAULT_REMOTE_AUTH_TYPE,
      dotenv_path: repoDotenvPath(memoryDir),
      repo_slugs: slugs,
    };
    if (args.detail) {
      response.repos = await Promise.all(slugs.map((slug) => fetchRemoteRepoDetail(profile, slug)));
    }
    printJson(response);
    return 0;
  }
  if (args.subcommand === "purge-prefix") {
    const profile = loadRepoR2Profile(memoryDir);
    const result = await purgeRemotePrefix(profile, args.repoSlug, { apply: Boolean(args.apply) });
    result.auth_type = DEFAULT_REMOTE_AUTH_TYPE;
    result.dotenv_path = repoDotenvPath(memoryDir);
    printJson(result);
    return 0;
  }
  if (args.subcommand === "purge-thread") {
    const profile = loadRepoR2Profile(memoryDir);
    const result = await purgeRemoteThread(profile, args.repoSlug, args.thread, { apply: Boolean(args.apply) });
    result.auth_type = DEFAULT_REMOTE_AUTH_TYPE;
    result.dotenv_path = repoDotenvPath(memoryDir);
    printJson(result);
    return 0;
  }
  throw new Error(`Unsupported remote command: ${args.subcommand || ""}`);
}

function repoIncludesRawThreads(repoState) {
  return repoState?.include_raw_threads === true;
}

function resolveIncludeRawThreads(args, fallback = false) {
  if (typeof args.includeRawThreads === "boolean") {
    return args.includeRawThreads;
  }
  return fallback;
}

async function performEnable(repoPath, memoryDir, configDir, codexHome, args) {
  const config = loadConfig(configDir);
  const existingRepoState = loadRepoState(memoryDir);
  ensureRepoCredentialsForInstall(memoryDir, args, configDir);
  const profile = loadRepoR2Profile(memoryDir);
  const remoteDetails = await listRemoteRepoDetails(profile);
  const currentProject = describeCurrentProject(repoPath, codexHome);
  const matchResult = resolveRepoSlug(repoPath, memoryDir, args, remoteDetails, currentProject);
  if (matchResult.selection_required) {
    return {
      repo: repoPath,
      memory_dir: memoryDir,
      machine_id: config.machine_id || null,
      selection_required: true,
      current_project: currentProject,
      remote_candidates: matchResult.remote_candidates,
      recommended_remote_project_id: matchResult.recommended_remote_project_id,
      message: matchResult.message,
    };
  }
  const repoSlug = matchResult.repo_slug;
  if (!config.machine_id) {
    config.machine_id = cryptoRandomId();
  }
  const repoState = buildRepoState(repoPath, {
    machineId: config.machine_id,
    remoteSlug: repoSlug,
    includeRawThreads: resolveIncludeRawThreads(args, false),
    summaryMode: args.summaryMode || "auto",
    matchMode: args.matchMode || "auto",
    matchStatus: matchResult.match_status,
    projectName: currentProject.project_name,
    previousRepoState: existingRepoState,
  });
  saveRepoState(memoryDir, repoState);
  if (!args.skipSkillInstall) {
    repoState.installed_skill_path = installSkill(repoPath);
    saveRepoState(memoryDir, repoState);
  }
  registerRepoMapping(config, repoPath, repoState);
  ensureMemoryDirGitignored(repoPath, memoryDir);
  ensureAgentsBlock(repoPath, repoState);
  saveConfig(configDir, config);
  return {
    repo: repoPath,
    memory_dir: memoryDir,
    repo_slug: repoSlug,
    remote_auth_type: repoState.remote_auth_type,
    remote_auth_path: repoState.remote_auth_path,
    remote_prefix: repoState.remote_prefix,
    summary_mode: repoState.summary_mode,
    include_raw_threads: repoState.include_raw_threads,
    match_mode: repoState.match_mode,
    match_status: repoState.match_status,
    remote_candidates: remoteDetails.map((item) => item.repo_slug),
    remote_candidate_details: remoteDetails,
    current_project: currentProject,
    installed_skill_path: repoState.installed_skill_path || null,
    sync_now: false,
  };
}

async function handleEnable(repoPath, memoryDir, configDir, codexHome, args) {
  const result = await performEnable(repoPath, memoryDir, configDir, codexHome, args);
  if (result.selection_required) {
    printSelectionRequired(result);
  } else {
    printJson(result);
  }
  return 0;
}

async function handleSetup(repoPath, memoryDir, configDir, codexHome, args) {
  const enableResult = await performEnable(repoPath, memoryDir, configDir, codexHome, args);
  if (enableResult.selection_required) {
    printJson({
      repo: repoPath,
      setup: true,
      selection_required: true,
      enable_result: enableResult,
      sync_action: null,
      sync_result: null,
      autostart_result: null,
      autostart_error: null,
      agent_result: null,
    });
    return 0;
  }
  const repoState = loadRepoState(memoryDir);
  const profile = loadRepoR2Profile(memoryDir);
  const remoteSlugs = await listRemoteRepoSlugs(profile);
  const remoteExists = remoteSlugs.includes(repoState.repo_slug);
  let syncResult = null;
  let syncAction = null;
  if (!args.skipSyncNow) {
    if (remoteExists) {
      syncResult = await performSyncPull(repoPath, memoryDir, profile, repoState, { codexHome, thread: args.thread || null });
      syncAction = "pull";
    } else {
      syncResult = await syncNow(repoPath, memoryDir, profile, {
        codexHome,
        includeRawThreads: repoIncludesRawThreads(repoState),
        prefix: repoState.remote_prefix,
      });
      syncAction = "push";
    }
  }
  let autostartResult = null;
  let autostartError = null;
  if (!args.skipAutostart) {
    try {
      autostartResult = enableAutostart({ repoPath, repoSlug: repoState.repo_slug, codexHome, configDir });
    } catch (error) {
      autostartError = error.message;
    }
  }
  let agentResult = null;
  if (!args.skipAgentStart) {
    agentResult = await ensureInstalledAgentRunningLatestVersion(args, repoPath, memoryDir, configDir, codexHome);
  }
  printJson({
    repo: repoPath,
    setup: true,
    enable_result: enableResult,
    sync_action: syncAction,
    sync_result: syncResult,
    autostart_result: autostartResult,
    autostart_error: autostartError,
    agent_result: agentResult,
  });
  return 0;
}

async function handleUninstall(repoPath, memoryDir, configDir, _codexHome, _args) {
  const config = loadConfig(configDir);
  const repoState = loadRepoState(memoryDir);
  const unregistered = unregisterRepoMapping(config, repoPath);
  saveConfig(configDir, unregistered.config);

  const agentsResult = removeAgentsBlock(repoPath);
  const gitignoreResult = removeMemoryDirGitignoreEntry(repoPath, memoryDir);

  let agentAction = "unchanged";
  let autostartAction = "unchanged";
  if (unregistered.remaining_repo_count === 0) {
    const agentState = liveServiceState(configDir);
    if (agentState?.pid) {
      await stopAgentService(configDir);
      agentAction = "stopped";
    } else {
      agentAction = "not_running";
    }
    const autostart = autostartStatus(repoState.repo_slug, configDir);
    if (autostart.enabled) {
      disableAutostart(repoState.repo_slug, configDir);
      autostartAction = "disabled";
    } else {
      autostartAction = "not_enabled";
    }
  }

  printJson({
    repo: repoPath,
    uninstall: true,
    detached: true,
    repo_removed: unregistered.removed,
    remaining_repo_count: unregistered.remaining_repo_count,
    agent_action: agentAction,
    autostart_action: autostartAction,
    agents_block_removed: agentsResult.removed,
    gitignore_entry_removed: gitignoreResult.removed,
    memory_dir: memoryDir,
    memory_dir_preserved: true,
    credentials_file_preserved: true,
  });
  return 0;
}

async function handleReceive(repoPath, memoryDir, configDir, codexHome, args) {
  const enableResult = await performEnable(repoPath, memoryDir, configDir, codexHome, {
    ...args,
    matchMode: "existing",
    summaryMode: args.summaryMode || "auto",
  });
  if (enableResult.selection_required) {
    printSelectionRequired({
      repo: repoPath,
      receive: true,
      selection_required: true,
      enable_result: enableResult,
    });
    return 0;
  }
  const repoState = loadRepoState(memoryDir);
  const profile = loadRepoR2Profile(memoryDir);
  const syncResult = await performSyncPull(repoPath, memoryDir, profile, repoState, { codexHome, thread: args.thread || null });
  let autostartResult = null;
  let autostartError = null;
  if (!args.skipAutostart) {
    try {
      autostartResult = enableAutostart({ repoPath, repoSlug: repoState.repo_slug, codexHome, configDir });
    } catch (error) {
      autostartError = error.message;
    }
  }
  let agentResult = null;
  if (!args.skipAgentStart) {
    agentResult = await ensureInstalledAgentRunningLatestVersion(args, repoPath, memoryDir, configDir, codexHome);
  }
  printJson({
    repo: repoPath,
    receive: true,
    enable_result: enableResult,
    sync_action: "pull",
    sync_result: syncResult,
    autostart_result: autostartResult,
    autostart_error: autostartError,
    agent_result: agentResult,
  });
  return 0;
}

async function handleThreads(args, repoPath, memoryDir, codexHome) {
  if (args.subcommand === "scan") {
    const threads = discoverThreadsForRepo(repoPath, codexHome, loadRepoState(memoryDir));
    printJson({
      repo: repoPath,
      thread_count: threads.length,
      threads: threads.map((thread) => ({
        thread_id: thread.threadId,
        title: thread.title,
        cwd: thread.cwd,
        rollout_path: thread.rolloutPath,
        updated_at: thread.updatedAt,
        thread_name: thread.sessionIndexEntry?.thread_name || null,
      })),
    });
    return 0;
  }
  if (args.subcommand === "export") {
    const threads = await exportRepoThreads(repoPath, memoryDir, {
      codexHome,
      includeRawThreads: resolveIncludeRawThreads(args, false),
    });
    printJson({
      repo: repoPath,
      memory_dir: memoryDir,
      thread_count: threads.length,
      current_thread: threads[0]?.threadId || null,
    });
    return 0;
  }
  if (args.subcommand === "import") {
    const result = importThreadBundleToCodex(repoPath, memoryDir, args.thread, { codexHome });
    printJson({ repo: repoPath, thread_id: args.thread, import_result: result });
    return 0;
  }
  if (args.subcommand === "cleanup") {
    const result = cleanupThread(codexPaths(codexHome), args.thread, { apply: Boolean(args.apply) });
    printJson({ repo: repoPath, thread_id: args.thread, cleanup_result: result });
    return 0;
  }
  throw new Error(`Unsupported threads subcommand: ${args.subcommand || ""}`);
}

async function handleSync(args, repoPath, memoryDir, configDir, codexHome) {
  const repoState = requireRepoState(memoryDir);
  if (args.subcommand === "status") {
    printJson(augmentSyncResult(memoryDir, repoState, {
      repo: repoPath,
      memory_dir: memoryDir,
      repo_slug: repoState.repo_slug,
      remote_auth_type: repoState.remote_auth_type,
      remote_auth_path: repoState.remote_auth_path,
      remote_prefix: repoState.remote_prefix,
    }));
    return 0;
  }
  const profile = loadRepoR2Profile(memoryDir);
  if (args.subcommand === "push") {
    const uploaded = await pushMemoryTree(profile, memoryDir, repoState.remote_prefix);
    recordSyncEvent(memoryDir, {
      repoPath,
      prefix: repoState.remote_prefix,
      direction: "push",
      command: "push",
      objectsUploaded: uploaded.length,
    });
    printJson(augmentSyncResult(memoryDir, repoState, {
      repo: repoPath,
      repo_slug: repoState.repo_slug,
      remote_auth_type: repoState.remote_auth_type,
      remote_auth_path: repoState.remote_auth_path,
      remote_prefix: repoState.remote_prefix,
      prefix: repoState.remote_prefix,
      uploaded_objects: uploaded.length,
    }));
    return 0;
  }
  if (args.subcommand === "pull") {
    const result = await performSyncPull(repoPath, memoryDir, profile, repoState, { codexHome, thread: args.thread || null });
    printJson(result);
    return 0;
  }
  if (args.subcommand === "now") {
    const result = await syncNow(repoPath, memoryDir, profile, {
      codexHome,
      includeRawThreads: resolveIncludeRawThreads(args, repoIncludesRawThreads(repoState)),
      prefix: repoState.remote_prefix,
    });
    printJson(result);
    return 0;
  }
  if (args.subcommand === "watch") {
    const result = await handleAgent({ ...args, subcommand: "start" }, repoPath, memoryDir, configDir, codexHome);
    printJson({
      repo: repoPath,
      watching: true,
      prefix: repoState.remote_prefix,
      interval_seconds: Number(args.interval) || 15,
      agent: result,
    });
    return 0;
  }
  throw new Error(`Unsupported sync subcommand: ${args.subcommand || ""}`);
}

function handleSkill(args, repoPath) {
  if (args.subcommand === "install") {
    const installed = installSkill(repoPath, args.skillsDir || null);
    printJson({ installed_skill_path: installed });
    return 0;
  }
  if (args.subcommand === "status") {
    printJson({ skill_path: installedSkillPath(), skill_installed: fs.existsSync(installedSkillPath()) });
    return 0;
  }
  throw new Error(`Unsupported skill subcommand: ${args.subcommand || ""}`);
}

async function handleAgent(args, repoPath, memoryDir, configDir, codexHome) {
  const repoState = loadRepoState(memoryDir);
  const state = liveServiceState(configDir);
  if (args.subcommand === "status") {
    return { ...statusPayload(repoPath, repoState, state, configDir), autostart: autostartStatus(repoState.repo_slug, configDir) };
  }
  if (args.subcommand === "stop") {
    await stopAgentService(configDir);
    return statusPayload(repoPath, repoState, null, configDir);
  }
  if (args.subcommand === "start") {
    if (state?.pid && isRunning(state.pid)) {
      return { already_running: true, ...statusPayload(repoPath, repoState, state, configDir) };
    }
    const started = startAgentService({ cwd: repoPath, configDir, codexHome });
    return {
      already_running: false,
      mode: "global",
      repo_slug: repoState.repo_slug,
      configured: true,
      running: true,
      pid: started.pid,
      remote_auth_type: repoState.remote_auth_type || DEFAULT_REMOTE_AUTH_TYPE,
      remote_auth_path: repoState.remote_auth_path || DEFAULT_REMOTE_AUTH_PATH,
      repo: repoPath,
      interval_seconds: 15,
      summary_mode: "none",
      include_raw_threads: repoIncludesRawThreads(repoState),
      codex_home: codexHome,
      initial_sync: true,
      phase: "idle",
      package_version: PACKAGE_VERSION,
      log_path: path.join(configDir, "logs", "agent-service.log"),
      watch_service_log_path: path.join(configDir, "logs", "watch-service.log"),
      event_log_path: path.join(configDir, "logs", "watch-events.log"),
      raw_event_log_path: path.join(configDir, "logs", "watch-raw-events.log"),
      changed_files_log_path: path.join(configDir, "logs", "watch-changed-files.log"),
      content_log_path: path.join(configDir, "logs", "watch-content.log"),
      command: [started.command, ...started.args],
    };
  }
  if (args.subcommand === "restart") {
    const stopResult = await stopAgentService(configDir);
    if (stopResult.running) {
      throw new Error(`Timed out waiting for the existing agent to stop: ${stopResult.remaining_pids.join(", ")}`);
    }
    const started = startAgentService({ cwd: repoPath, configDir, codexHome });
    return {
      restarted: true,
      mode: "global",
      repo_slug: repoState.repo_slug,
      configured: true,
      running: true,
      pid: started.pid,
      remote_auth_type: repoState.remote_auth_type || DEFAULT_REMOTE_AUTH_TYPE,
      remote_auth_path: repoState.remote_auth_path || DEFAULT_REMOTE_AUTH_PATH,
      repo: repoPath,
      interval_seconds: 15,
      summary_mode: "none",
      include_raw_threads: repoIncludesRawThreads(repoState),
      codex_home: codexHome,
      initial_sync: true,
      phase: "idle",
      package_version: PACKAGE_VERSION,
      log_path: path.join(configDir, "logs", "agent-service.log"),
      watch_service_log_path: path.join(configDir, "logs", "watch-service.log"),
      event_log_path: path.join(configDir, "logs", "watch-events.log"),
      raw_event_log_path: path.join(configDir, "logs", "watch-raw-events.log"),
      changed_files_log_path: path.join(configDir, "logs", "watch-changed-files.log"),
      content_log_path: path.join(configDir, "logs", "watch-content.log"),
      command: [started.command, ...started.args],
    };
  }
  if (args.subcommand === "enable") {
    return enableAutostart({ repoPath, repoSlug: repoState.repo_slug, codexHome, configDir });
  }
  if (args.subcommand === "disable") {
    return disableAutostart(repoState.repo_slug, configDir);
  }
  throw new Error(`Unsupported agent subcommand: ${args.subcommand || "<missing>"}`);
}

async function handleSyncNow(repoPath, memoryDir, configDir, codexHome) {
  const repoState = loadRepoState(memoryDir);
  const profile = loadRepoR2Profile(memoryDir);
  const result = await syncNow(repoPath, memoryDir, profile, {
    codexHome,
    includeRawThreads: repoIncludesRawThreads(repoState),
    prefix: repoState.remote_prefix,
  });
  printJson(result);
  return 0;
}

function doctor(repoPath, memoryDir, configDir, codexHome) {
  const repoState = loadRepoState(memoryDir);
  const authStatus = repoR2ProfileStatus(memoryDir);
  const syncReport = describeSyncState(memoryDir);
  const roots = materializedRootPaths(memoryDir);
  const state = liveServiceState(configDir);
  return {
    repo: repoPath,
    memory_dir: memoryDir,
    node: process.execPath,
    codex_home: codexHome,
    config_path: configPath(configDir),
    repo_enabled: Object.keys(repoState).length > 0,
    remote_auth: authStatus,
    repo_state: repoState,
    sync_state: syncReport.sync_state,
    sync_state_path: syncReport.sync_state_path,
    sync_health: syncReport.sync_health,
    materialized_root: {
      current_thread_present: fs.existsSync(currentThreadPath(memoryDir)),
      thread_index_present: fs.existsSync(path.join(memoryDir, "thread-index.json")),
    },
    watch_service: state,
  };
}

function statusPayload(repoPath, repoState, state, configDir) {
  const running = Boolean(state?.pid && isRunning(state.pid));
  const runningPackageVersion = state?.package_version || null;
  const restartRequired = Boolean(running && runningPackageVersion && PACKAGE_VERSION && runningPackageVersion !== PACKAGE_VERSION);
  return {
    mode: "global",
    repo_slug: repoState.repo_slug,
    configured: Boolean(state),
    running,
    pid: state?.pid || null,
    remote_auth_type: repoState.remote_auth_type || DEFAULT_REMOTE_AUTH_TYPE,
    remote_auth_path: repoState.remote_auth_path || DEFAULT_REMOTE_AUTH_PATH,
    repo: repoPath,
    interval_seconds: state?.poll_interval_ms ? state.poll_interval_ms / 1000 : 2,
    summary_mode: "none",
    include_raw_threads: repoIncludesRawThreads(repoState),
    codex_home: state?.codex_home || resolveCodexHome(),
    initial_sync: true,
    phase: state?.phase || "idle",
    installed_package_version: PACKAGE_VERSION,
    running_package_version: runningPackageVersion,
    restart_required: restartRequired,
    watcher_running: Boolean(state?.watcher?.pid && running),
    log_path: path.join(configDir, "logs", "agent-service.log"),
    watch_service_log_path: path.join(configDir, "logs", "watch-service.log"),
    event_log_path: path.join(configDir, "logs", "watch-events.log"),
    raw_event_log_path: path.join(configDir, "logs", "watch-raw-events.log"),
    changed_files_log_path: path.join(configDir, "logs", "watch-changed-files.log"),
    content_log_path: path.join(configDir, "logs", "watch-content.log"),
  };
}

function liveServiceState(configDir) {
  const state = serviceState(configDir);
  if (state?.pid && isRunning(state.pid)) {
    return state;
  }
  const fallbackPid = findScriptProcessPids("agent_service.js", { configDir })[0] || null;
  if (!fallbackPid) {
    return null;
  }
  return {
    ...(state || {}),
    pid: fallbackPid,
  };
}

async function ensureInstalledAgentRunningLatestVersion(args, repoPath, memoryDir, configDir, codexHome) {
  const state = liveServiceState(configDir);
  if (state?.pid) {
    const restarted = await handleAgent({ ...args, subcommand: "restart" }, repoPath, memoryDir, configDir, codexHome);
    return {
      install_restarted_agent: true,
      previous_pid: state.pid,
      previous_package_version: state.package_version || null,
      ...restarted,
    };
  }
  const started = await handleAgent({ ...args, subcommand: "start" }, repoPath, memoryDir, configDir, codexHome);
  return {
    install_restarted_agent: false,
    ...started,
  };
}

async function withLifecycleLock(configDir, fn, { timeoutMs = 15000, pollMs = 100 } = {}) {
  const lockPath = lifecycleLockPath(configDir);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    try {
      const handle = fs.openSync(lockPath, "wx");
      try {
        fs.writeFileSync(handle, `${JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString() })}\n`, "utf8");
      } finally {
        fs.closeSync(handle);
      }
      try {
        return await fn();
      } finally {
        try {
          fs.rmSync(lockPath, { force: true });
        } catch {
          // Ignore lock cleanup failures.
        }
      }
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      const existing = readLifecycleLock(lockPath);
      if (existing?.pid && !isRunning(existing.pid)) {
        try {
          fs.rmSync(lockPath, { force: true });
        } catch {
          // Ignore stale lock cleanup failure and retry.
        }
        continue;
      }
      await sleep(pollMs);
    }
  }
  throw new Error("Timed out waiting for another codex-handoff lifecycle operation to finish.");
}

function readLifecycleLock(lockPath) {
  try {
    return JSON.parse(fs.readFileSync(lockPath, "utf8"));
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requireRepoState(memoryDir) {
  const repoState = loadRepoState(memoryDir);
  if (!Object.keys(repoState).length) {
    throw new Error("This repo is not enabled for codex-handoff yet. Run `codex-handoff --repo . enable` first.");
  }
  return repoState;
}

function augmentSyncResult(memoryDir, repoState, payload) {
  const result = { ...payload };
  const syncReport = describeSyncState(memoryDir);
  result.repo_slug = result.repo_slug || repoState.repo_slug;
  result.remote_auth_type = result.remote_auth_type || repoState.remote_auth_type || DEFAULT_REMOTE_AUTH_TYPE;
  result.remote_auth_path = result.remote_auth_path || repoState.remote_auth_path || DEFAULT_REMOTE_AUTH_PATH;
  result.remote_prefix = result.remote_prefix || repoState.remote_prefix || result.prefix;
  result.prefix = result.prefix || result.remote_prefix;
  if (result.current_thread === undefined || result.current_thread === null) {
    result.current_thread = syncReport.sync_health.current_thread;
  }
  if (result.thread_count === undefined || result.thread_count === null) {
    result.thread_count = syncReport.sync_health.thread_count;
  }
  if (result.thread_ids === undefined || result.thread_ids === null) {
    result.thread_ids = syncReport.sync_health.thread_ids;
  }
  result.sync_state_path = syncReport.sync_state_path;
  result.sync_state = syncReport.sync_state;
  result.sync_health = syncReport.sync_health;
  return result;
}

async function performSyncPull(repoPath, memoryDir, profile, repoState, { codexHome, thread = null } = {}) {
  const result = await pullRepoMemorySnapshot(repoPath, memoryDir, profile, repoState, { codexHome, thread });
  return augmentSyncResult(memoryDir, repoState, result);
}

async function listRemoteRepoSlugs(profile) {
  return (await listRemoteRepoDetails(profile)).map((item) => item.repo_slug);
}

async function listRemoteRepoDetails(profile) {
  const keys = (await listR2Objects(profile, "repos/")).map((item) => item.key);
  const slugs = [...new Set(
    keys
      .filter((key) => key.startsWith("repos/"))
      .map((key) => key.split("/", 3)[1])
      .filter(Boolean),
  )].sort();
  return Promise.all(slugs.map((slug) => fetchRemoteRepoDetail(profile, slug)));
}

async function fetchRemoteRepoDetail(profile, slug) {
  for (const candidate of [`repos/${slug}/repo.json`, `repos/${slug}/manifest.json`]) {
    try {
      const payload = JSON.parse((await getR2Object(profile, candidate)).toString("utf8"));
      payload.repo_slug = payload.repo_slug || slug;
      payload.manifest_key = payload.manifest_key || candidate;
      return payload;
    } catch {
      // Continue to the next manifest candidate.
    }
  }
  return { repo_slug: slug };
}

function resolveRepoSlug(repoPath, memoryDir, args, remoteDetails, currentProject) {
  if (args.remoteSlug) {
    return { repo_slug: args.remoteSlug, match_status: "explicit" };
  }
  const existing = loadRepoState(memoryDir);
  const inferred = inferRepoSlug(repoPath);
  const remoteSlugs = remoteDetails.map((item) => item.repo_slug);
  const staleExistingSlug = isStaleExistingRepoSlug(repoPath, existing, inferred);
  if (existing.repo_slug && !staleExistingSlug) {
    return { repo_slug: String(existing.repo_slug), match_status: "existing_local" };
  }
  if (staleExistingSlug) {
    if (remoteSlugs.includes(inferred)) {
      return { repo_slug: inferred, match_status: "matched_remote_inferred" };
    }
    if (args.matchMode !== "existing") {
      return { repo_slug: inferred, match_status: "create_new" };
    }
  }
  if (args.matchMode === "existing") {
    return resolveExistingRemoteMatch(repoPath, inferred, remoteDetails, currentProject);
  }
  if (args.matchMode === "new") {
    return { repo_slug: inferred, match_status: "create_new" };
  }
  if (remoteSlugs.includes(inferred)) {
    return { repo_slug: inferred, match_status: "matched_remote_inferred" };
  }
  if (remoteDetails.length) {
    const best = bestRemoteCandidate(repoPath, inferred, remoteDetails, currentProject, { strongOnly: true });
    if (best) {
      return { repo_slug: best.repo_slug, match_status: "matched_remote_best_candidate" };
    }
  }
  return { repo_slug: inferred, match_status: "create_new" };
}

function isStaleExistingRepoSlug(repoPath, existing, inferredSlug) {
  const existingSlug = existing?.repo_slug ? String(existing.repo_slug) : null;
  if (!existingSlug) {
    return false;
  }
  if (String(existing?.match_status || "") === "explicit") {
    return false;
  }
  if (!gitOriginUrlFromRepo(repoPath)) {
    return false;
  }
  return Boolean(inferredSlug) && existingSlug !== inferredSlug;
}

function resolveExistingRemoteMatch(repoPath, inferredSlug, remoteDetails, currentProject) {
  const remoteSlugs = remoteDetails.map((item) => item.repo_slug);
  if (remoteSlugs.includes(inferredSlug)) {
    return { repo_slug: inferredSlug, match_status: "matched_remote_inferred" };
  }
  if (remoteDetails.length === 1) {
    return { repo_slug: remoteDetails[0].repo_slug, match_status: "matched_remote_single_candidate" };
  }
  const best = bestRemoteCandidate(repoPath, inferredSlug, remoteDetails, currentProject);
  if (best) {
    return { repo_slug: best.repo_slug, match_status: "matched_remote_best_candidate" };
  }
  const ranked = rankRemoteCandidates(repoPath, inferredSlug, remoteDetails, currentProject);
  return {
    selection_required: true,
    recommended_remote_project_id: ranked.length && ranked[0].score > 0 ? ranked[0].repo_slug : null,
    remote_candidates: ranked,
    message: remoteSelectionRequiredMessage(repoPath, inferredSlug, currentProject, remoteDetails),
  };
}

function bestRemoteCandidate(repoPath, inferredSlug, remoteDetails, currentProject, { strongOnly = false } = {}) {
  let ranked = rankRemoteCandidates(repoPath, inferredSlug, remoteDetails, currentProject);
  if (strongOnly) {
    ranked = ranked.filter((item) => item.reasons.includes("slug") || item.reasons.includes("git_origin"));
  }
  if (!ranked.length || ranked[0].score <= 0) return null;
  if (ranked.length > 1 && ranked[0].score === ranked[1].score) return null;
  return ranked[0];
}

function rankRemoteCandidates(repoPath, inferredSlug, remoteDetails, currentProject) {
  const repoName = path.basename(repoPath).toLowerCase();
  const repoOrigin = normalizeGitOriginUrl(getGitOrigin(repoPath));
  const projectName = String(currentProject.project_name || path.basename(repoPath)).trim().toLowerCase();
  return remoteDetails
    .map((item) => {
      let score = 0;
      const reasons = [];
      if (item.repo_slug === inferredSlug) {
        score += 100;
        reasons.push("slug");
      }
      const candidateOrigins = gitOriginAliases(
        item.git_origin_url || null,
        Array.isArray(item.git_origin_urls) ? item.git_origin_urls : [],
      );
      if (repoOrigin && candidateOrigins.some((origin) => normalizeGitOriginUrl(origin) === repoOrigin)) {
        score += 80;
        reasons.push("git_origin");
      }
      const candidatePathName = item.repo_path ? path.basename(String(item.repo_path)).toLowerCase() : "";
      if (candidatePathName && candidatePathName === repoName) {
        score += 20;
        reasons.push("repo_name");
      }
      const candidateProjectName = String(item.project_name || "").trim().toLowerCase();
      if (candidateProjectName && candidateProjectName === projectName) {
        score += 25;
        reasons.push("project_name");
      }
      if (repoName && String(item.repo_slug || "").toLowerCase().includes(repoName)) {
        score += 5;
        reasons.push("slug_contains_repo_name");
      }
      return { ...item, score, reasons };
    })
    .sort((a, b) => b.score - a.score);
}

function remoteSelectionRequiredMessage(repoPath, inferredSlug, currentProject, remoteDetails) {
  const lines = [
    "Multiple remote repos are available and codex-handoff could not safely choose one automatically.",
    `- local repo path: ${repoPath}`,
    `- current project name: ${currentProject.project_name || path.basename(repoPath)}`,
    `- inferred slug: ${inferredSlug}`,
    "- remote candidates:",
  ];
  for (const item of remoteDetails) {
    lines.push(`  - ${item.repo_slug} (project_name=${item.project_name || ""}, git_origin_url=${item.git_origin_url || ""}, repo_path=${item.repo_path || ""})`);
  }
  lines.push("Re-run with `--remote-slug <repo-slug>` to choose one, or use `--match-mode new` to create a new remote repo.");
  return lines.join("\n");
}

function printSelectionRequired(result) {
  process.stdout.write(formatSelectionRequiredText(result));
}

function formatSelectionRequiredText(result) {
  const enableResult = result.enable_result || result;
  const currentProject = enableResult.current_project || {};
  const candidates = enableResult.remote_candidates || [];
  const recommended = enableResult.recommended_remote_project_id;
  const lines = [
    "Remote project selection is required.",
    "",
    `Current project: ${currentProject.project_name || ""}`,
    `Workspace root: ${currentProject.workspace_root || result.repo || ""}`,
    "",
  ];
  if (enableResult.message) {
    lines.push(enableResult.message, "");
  }
  lines.push("Candidates:");
  candidates.forEach((item, index) => {
    const marker = recommended && item.repo_slug === recommended ? " (recommended)" : "";
    let line = `${index + 1}. ${item.repo_slug}${marker}`;
    if (item.project_name) line += ` | project_name=${item.project_name}`;
    if (item.repo_path) line += ` | repo_path=${item.repo_path}`;
    if (item.score !== undefined) line += ` | score=${item.score}`;
    if (Array.isArray(item.reasons) && item.reasons.length) line += ` | reasons=${item.reasons.join(", ")}`;
    lines.push(line);
  });
  lines.push("", "Choose one remote project id and re-run with:", "  codex-handoff receive --remote-slug <remote-project-id>");
  return `${lines.join("\n").trim()}\n`;
}

async function purgeRemotePrefix(profile, repoSlug, { apply = false } = {}) {
  const prefix = `repos/${repoSlug}/`;
  const keys = (await listR2Objects(profile, prefix)).map((item) => item.key);
  const payload = {
    repo_slug: repoSlug,
    prefix,
    object_count: keys.length,
    keys: keys.slice(0, 50),
    applied: apply,
  };
  if (!apply) return payload;
  for (const key of keys) {
    await deleteR2Object(profile, key);
  }
  payload.deleted_keys = keys.length;
  return payload;
}

async function purgeRemoteThread(profile, repoSlug, threadId, { apply = false } = {}) {
  const prefix = `repos/${repoSlug}/`;
  const threadPrefix = `${prefix}threads/${threadId}/`;
  const threadKeys = (await listR2Objects(profile, threadPrefix)).map((item) => item.key);
  const threadIndexKey = `${prefix}thread-index.json`;
  const currentThreadKey = `${prefix}current-thread.json`;
  const currentThreadId = await readRemoteCurrentThread(profile, currentThreadKey);
  const threadIndex = await readRemoteThreadIndex(profile, threadIndexKey);
  const remainingIndex = threadIndex.filter((item) => item.thread_id !== threadId);
  const nextThreadId = currentThreadId === threadId && remainingIndex.length ? remainingIndex[0].thread_id : null;
  const payload = {
    repo_slug: repoSlug,
    thread_id: threadId,
    thread_prefix: threadPrefix,
    object_count: threadKeys.length,
    keys: threadKeys.slice(0, 50),
    current_thread_id: currentThreadId,
    next_thread_id: nextThreadId,
    applied: apply,
  };
  if (!apply) return payload;
  for (const key of threadKeys) {
    await deleteR2Object(profile, key);
  }
  if (remainingIndex.length) {
    await putRemoteJson(profile, threadIndexKey, remainingIndex);
  } else {
    await deleteR2Object(profile, threadIndexKey);
  }
  if (currentThreadId === threadId) {
    if (nextThreadId) {
      await rematerializeRemoteRootFromThread(profile, prefix, nextThreadId);
    } else {
      await deleteRemoteKeysIfPresent(profile, [currentThreadKey, `${prefix}latest.md`, `${prefix}handoff.json`]);
    }
  }
  payload.deleted_keys = threadKeys.length;
  payload.remaining_threads = remainingIndex.map((item) => item.thread_id);
  return payload;
}

async function readRemoteJson(profile, key) {
  try {
    return JSON.parse((await getR2Object(profile, key)).toString("utf8"));
  } catch {
    return null;
  }
}

async function putRemoteJson(profile, key, payload) {
  return putR2Object(profile, key, Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, "utf8"));
}

async function readRemoteThreadIndex(profile, key) {
  const payload = await readRemoteJson(profile, key);
  return Array.isArray(payload) ? payload.filter((item) => item && typeof item === "object") : [];
}

async function readRemoteCurrentThread(profile, key) {
  const payload = await readRemoteJson(profile, key);
  return payload && typeof payload.thread_id === "string" ? payload.thread_id : null;
}

async function rematerializeRemoteRootFromThread(profile, prefix, threadId) {
  const bundle = await readRemoteJson(profile, `${prefix}threads/${threadId}.json`);
  if (!bundle) {
    throw new Error(`Missing remote thread bundle for ${threadId}`);
  }
  await putR2Object(profile, `${prefix}latest.md`, Buffer.from(bundle.latest_md || "", "utf8"));
  await putRemoteJson(profile, `${prefix}handoff.json`, bundle.handoff || {});
  await putRemoteJson(profile, `${prefix}current-thread.json`, { thread_id: threadId });
}

async function deleteRemoteKeysIfPresent(profile, keys) {
  const existing = new Set((await listR2Objects(profile, "")).map((item) => item.key));
  for (const key of keys) {
    if (existing.has(key)) {
      await deleteR2Object(profile, key);
    }
  }
}

function getGitOrigin(repoPath) {
  return gitOriginUrlFromRepo(repoPath);
}

function writeOrPrint(output, outputPath) {
  if (!outputPath) {
    process.stdout.write(output);
    return;
  }
  const resolved = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, output, "utf8");
  process.stdout.write(`${resolved}\n`);
}

function parseArgs(argv) {
  const out = {
    repo: ".",
    memoryDir: null,
    command: null,
    subcommand: null,
    remoteProvider: null,
    help: false,
    fromClipboard: false,
    fromEnv: false,
    dotenv: null,
    remoteSlug: null,
    repoSlug: null,
    profile: null,
    codexHome: null,
    goal: null,
    evidenceLimit: 5,
    output: null,
    query: null,
    limit: 8,
    session: null,
    turn: null,
    thread: null,
    interval: 15,
    summaryMode: null,
    includeRawThreads: null,
    noInitialSync: false,
    loginIfNeeded: false,
    skipAgentStart: false,
    skipAutostart: false,
    skipSkillInstall: false,
    skipSyncNow: true,
    matchMode: "auto",
    authSource: "dotenv",
    apply: false,
    detail: false,
    skillsDir: null,
  };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--repo") {
      out.repo = argv[i + 1];
      i += 1;
    } else if (arg === "--memory-dir") {
      out.memoryDir = argv[i + 1];
      i += 1;
    } else if (arg === "--profile") {
      out.profile = argv[i + 1];
      i += 1;
    } else if (arg === "--codex-home") {
      out.codexHome = argv[i + 1];
      i += 1;
    } else if (arg === "--goal") {
      out.goal = argv[i + 1];
      i += 1;
    } else if (arg === "--evidence-limit") {
      out.evidenceLimit = Number(argv[i + 1]) || 5;
      i += 1;
    } else if (arg === "--output") {
      out.output = argv[i + 1];
      i += 1;
    } else if (arg === "--limit") {
      out.limit = Number(argv[i + 1]) || 8;
      i += 1;
    } else if (arg === "--session") {
      out.session = argv[i + 1];
      i += 1;
    } else if (arg === "--turn") {
      out.turn = argv[i + 1];
      i += 1;
    } else if (arg === "--thread") {
      out.thread = argv[i + 1];
      i += 1;
    } else if (arg === "--interval" || arg === "--agent-interval") {
      out.interval = Number(argv[i + 1]) || 15;
      i += 1;
    } else if (arg === "--summary-mode") {
      out.summaryMode = argv[i + 1];
      i += 1;
    } else if (arg === "--skip-raw-threads") out.includeRawThreads = false;
    else if (arg === "--include-raw-threads") out.includeRawThreads = true;
    else if (arg === "--no-initial-sync") out.noInitialSync = true;
    else if (arg === "--login-if-needed") out.loginIfNeeded = true;
    else if (arg === "--skip-agent-start") out.skipAgentStart = true;
    else if (arg === "--skip-autostart") out.skipAutostart = true;
    else if (arg === "--skip-skill-install") out.skipSkillInstall = true;
    else if (arg === "--sync-now") out.skipSyncNow = false;
    else if (arg === "--skip-sync-now") out.skipSyncNow = true;
    else if (arg === "--match-mode") {
      out.matchMode = argv[i + 1];
      i += 1;
    } else if (arg === "--auth-source") {
      out.authSource = argv[i + 1];
      i += 1;
    } else if (arg === "--skills-dir") {
      out.skillsDir = argv[i + 1];
      i += 1;
    } else if (arg === "--from-clipboard") out.fromClipboard = true;
    else if (arg === "--from-env") out.fromEnv = true;
    else if (arg === "--detail") out.detail = true;
    else if (arg === "--apply") out.apply = true;
    else if (arg === "--dotenv") {
      out.dotenv = argv[i + 1];
      i += 1;
    } else if (arg === "--remote-slug") {
      out.remoteSlug = argv[i + 1];
      i += 1;
    } else if (arg === "--repo-slug") {
      out.repoSlug = argv[i + 1];
      i += 1;
    } else {
      positional.push(arg);
    }
  }
  out.command = positional[0] || null;
  out.subcommand = positional[1] || null;
  out.remoteProvider = positional[2] || null;
  if (out.command === "search") out.query = positional[1] || null;
  return out;
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printHelp() {
  process.stdout.write(
    "Usage: codex-handoff [--repo PATH] <command>\n" +
      "Commands currently ported to Node:\n" +
      "  status\n" +
      "  doctor\n" +
      "  search <query>\n" +
      "  extract --session <id> [--turn <id>]\n" +
      "  resume --goal <text>\n" +
      "  context-pack --goal <text>\n" +
      "  remote login r2|whoami|validate|logout\n" +
      "  remote repos|purge-prefix|purge-thread\n" +
      "  enable\n" +
      "  setup\n" +
      "  uninstall\n" +
      "  receive\n" +
      "  threads scan|export|import|cleanup\n" +
      "  agent start|stop|status|restart|enable|disable\n" +
      "  skill install|status\n" +
      "  sync status|push|pull|now|watch\n" +
      "Flags:\n" +
      "  --skip-raw-threads      Default behavior: do not export rollout.jsonl.gz archives\n" +
      "  --include-raw-threads   Opt in to exporting rollout.jsonl.gz archives\n",
  );
}

function cryptoRandomId() {
  return require("node:crypto").randomUUID();
}

function ensureRepoCredentialsForInstall(memoryDir, args, configDir) {
  try {
    loadRepoR2Profile(memoryDir);
    return {
      auth_type: DEFAULT_REMOTE_AUTH_TYPE,
      dotenv_path: repoDotenvPath(memoryDir),
      created: false,
    };
  } catch (error) {
    const source = resolveAuthSource(args);
    if (source === "clipboard" || source === "env" || args.dotenv) {
      return loginRepoR2Profile(memoryDir, args, configDir);
    }
    const dotenvPath = ensureRepoDotenvTemplate(memoryDir);
    throw new Error(
      `R2 credentials are required in ${dotenvPath}. Fill in that file or run \`codex-handoff remote login r2 --from-clipboard\` first. ${error.message}`,
    );
  }
}

function loginRepoR2Profile(memoryDir, args, configDir) {
  const source = resolveAuthSource(args);
  const creds = readR2CredentialsForSource(source, args, memoryDir);
  const dotenvPath = saveRepoR2Profile(memoryDir, creds);
  cleanupLegacyAuthArtifacts(configDir);
  saveConfig(configDir, loadConfig(configDir));
  const profile = loadRepoR2Profile(memoryDir);
  return {
    provider: "cloudflare-r2",
    bucket: profile.bucket,
    endpoint: profile.endpoint,
    auth_source: source,
    auth_type: DEFAULT_REMOTE_AUTH_TYPE,
    dotenv_path: dotenvPath,
  };
}

function resolveAuthSource(args) {
  if (args.fromClipboard) return "clipboard";
  if (args.fromEnv) return "env";
  return args.authSource || "dotenv";
}

function mask(value) {
  const text = String(value || "");
  if (text.length <= 4) return "*".repeat(text.length);
  return `${"*".repeat(text.length - 4)}${text.slice(-4)}`;
}

module.exports = {
  main,
  parseArgs,
  resolveRepoSlug,
};

if (require.main === module) {
  Promise.resolve(main()).then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
