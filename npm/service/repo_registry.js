const fs = require("node:fs");
const path = require("node:path");

const {
  isSameOrDescendantPath,
  normalizeComparablePath,
} = require("./common");
const { loadConfig, saveConfig } = require("../lib/runtime-config");
const { buildRepoState, loadRepoState, refreshRepoStateForCurrentRepo, registerRepoMapping, saveRepoState } = require("../lib/workspace");

function loadManagedRepos(configDir) {
  const payload = loadConfig(configDir);
  const repos = payload.repos || {};
  return Object.entries(repos)
    .map(([repoPath, repoState]) => {
      const normalizedPath = normalizeComparablePath(repoPath);
      if (!normalizedPath) {
        return null;
      }
      return {
        repoPath,
        normalizedPath,
        repoSlug: repoState.repo_slug || path.basename(repoPath),
        repoSlugAliases: Array.isArray(repoState.repo_slug_aliases) ? repoState.repo_slug_aliases : [],
        machineId: repoState.machine_id || payload.machine_id || null,
        remotePrefix: repoState.remote_prefix || `repos/${repoState.repo_slug || path.basename(repoPath)}/`,
        remoteAuthType: repoState.remote_auth_type || "global_dotenv",
        remoteAuthPath: repoState.remote_auth_path || "~/.codex-handoff/.env.local",
        summaryMode: repoState.summary_mode || "auto",
        includeRawThreads: repoState.include_raw_threads === true,
        matchMode: repoState.match_mode || "auto",
        matchStatus: repoState.match_status || "existing_local",
        projectName: repoState.project_name || path.basename(repoPath),
        gitOriginUrl: repoState.git_origin_url || null,
        gitOriginUrls: Array.isArray(repoState.git_origin_urls) ? repoState.git_origin_urls : [],
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.normalizedPath.length - a.normalizedPath.length);
}

function findManagedRepoForCwd(cwd, managedRepos) {
  const normalizedCwd = normalizeComparablePath(cwd);
  if (!normalizedCwd) {
    return null;
  }
  return (
    managedRepos.find((repo) => isSameOrDescendantPath(normalizedCwd, repo.normalizedPath)) || null
  );
}

function hasManagedRepos(configDir) {
  return loadManagedRepos(configDir).length > 0;
}

function syncManagedRepoConfig(configDir, repoPath, repoState) {
  if (!configDir || !repoState?.repo_slug) {
    return;
  }
  const config = loadConfig(configDir);
  registerRepoMapping(config, repoPath, repoState);
  saveConfig(configDir, config);
}

function ensureManagedRepoState(repoPathOrMemoryDir, managedRepo, { configDir = null } = {}) {
  const memoryDir = path.basename(repoPathOrMemoryDir) === ".codex-handoff"
    ? repoPathOrMemoryDir
    : path.join(repoPathOrMemoryDir, ".codex-handoff");
  const repoState = loadRepoState(memoryDir);
  if (repoState?.repo_slug && repoState?.remote_prefix) {
    const refreshed = refreshRepoStateForCurrentRepo(managedRepo.repoPath, repoState);
    saveRepoState(memoryDir, refreshed);
    syncManagedRepoConfig(configDir, managedRepo.repoPath, refreshed);
    return refreshed;
  }
  const rebuilt = buildRepoState(managedRepo.repoPath, {
    machineId: managedRepo.machineId,
    remoteSlug: managedRepo.repoSlug,
    includeRawThreads: managedRepo.includeRawThreads === true,
    summaryMode: managedRepo.summaryMode || "auto",
    matchMode: managedRepo.matchMode || "auto",
    matchStatus: managedRepo.matchStatus || "existing_local",
    projectName: managedRepo.projectName || path.basename(managedRepo.repoPath),
    previousRepoState: {
      repo_slug_aliases: managedRepo.repoSlugAliases || [],
      git_origin_url: managedRepo.gitOriginUrl || null,
      git_origin_urls: managedRepo.gitOriginUrls || [],
      remote_auth_type: managedRepo.remoteAuthType,
      remote_auth_path: managedRepo.remoteAuthPath,
    },
  });
  rebuilt.remote_prefix = managedRepo.remotePrefix || rebuilt.remote_prefix;
  rebuilt.remote_auth_type = managedRepo.remoteAuthType || rebuilt.remote_auth_type;
  rebuilt.remote_auth_path = managedRepo.remoteAuthPath || rebuilt.remote_auth_path;
  saveRepoState(memoryDir, rebuilt);
  syncManagedRepoConfig(configDir, managedRepo.repoPath, rebuilt);
  return rebuilt;
}

module.exports = {
  ensureManagedRepoState,
  findManagedRepoForCwd,
  hasManagedRepos,
  loadManagedRepos,
  syncManagedRepoConfig,
};
