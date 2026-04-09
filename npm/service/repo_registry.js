const fs = require("node:fs");
const path = require("node:path");

const {
  isSameOrDescendantPath,
  normalizeComparablePath,
} = require("./common");
const { loadConfig } = require("../lib/runtime-config");

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
        remotePrefix: repoState.remote_prefix || `repos/${repoState.repo_slug || path.basename(repoPath)}/`,
        summaryMode: repoState.summary_mode || "auto",
        includeRawThreads: repoState.include_raw_threads === true,
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

module.exports = {
  findManagedRepoForCwd,
  hasManagedRepos,
  loadManagedRepos,
};
