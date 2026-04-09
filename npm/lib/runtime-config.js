const fs = require("node:fs");
const path = require("node:path");

const { canonicalizeRepoPath, configPath, normalizeComparablePath, readJsonFile } = require("../service/common");
const { DEFAULT_REMOTE_AUTH_PATH, DEFAULT_REMOTE_AUTH_TYPE } = require("./repo-auth");

function loadConfig(configDir) {
  return normalizeConfig(readJsonFile(configPath(configDir), {}));
}

function saveConfig(configDir, payload) {
  const filePath = configPath(configDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  cleanupLegacyAuthArtifacts(configDir);
  fs.writeFileSync(filePath, JSON.stringify(normalizeConfig(payload), null, 2) + "\n", "utf8");
  return filePath;
}

function cleanupLegacyAuthArtifacts(configDir) {
  const secretsDir = path.join(configDir, "secrets");
  if (fs.existsSync(secretsDir)) {
    fs.rmSync(secretsDir, { recursive: true, force: true });
  }
}

function normalizeConfig(payload) {
  return {
    schema_version: "1.0",
    repos: normalizeRepoMappings(payload?.repos || {}),
    machine_id: payload?.machine_id || null,
  };
}

function normalizeRepoMappings(reposPayload) {
  const normalized = {};
  for (const [rawRepoPath, rawRepoState] of Object.entries(reposPayload || {})) {
    const comparableKey = normalizeComparablePath(rawRepoPath);
    const canonicalKey = canonicalizeRepoPath(rawRepoPath);
    if (!comparableKey || !canonicalKey) {
      continue;
    }
    const nextState = normalizeRepoMappingState(rawRepoState, canonicalKey);
    const existingState = normalized[canonicalKey];
    if (!existingState || repoStateUpdatedAt(nextState) >= repoStateUpdatedAt(existingState)) {
      normalized[canonicalKey] = nextState;
      continue;
    }
    normalized[canonicalKey] = {
      ...existingState,
      repo_slug: existingState.repo_slug || nextState.repo_slug,
      remote_prefix: existingState.remote_prefix || nextState.remote_prefix,
      summary_mode: existingState.summary_mode || nextState.summary_mode,
      match_mode: existingState.match_mode || nextState.match_mode,
      match_status: existingState.match_status || nextState.match_status,
      include_raw_threads: existingState.include_raw_threads === true || nextState.include_raw_threads === true,
      remote_auth_type: existingState.remote_auth_type || nextState.remote_auth_type,
      remote_auth_path: existingState.remote_auth_path || nextState.remote_auth_path,
      project_name: existingState.project_name || nextState.project_name,
      workspace_root: existingState.workspace_root || nextState.workspace_root,
      machine_id: existingState.machine_id || nextState.machine_id,
      updated_at: existingState.updated_at || nextState.updated_at,
    };
  }
  return normalized;
}

function normalizeRepoMappingState(repoState, canonicalRepoPath) {
  const normalized = { ...(repoState || {}) };
  delete normalized.remote_profile;
  normalized.remote_auth_type = DEFAULT_REMOTE_AUTH_TYPE;
  normalized.remote_auth_path = DEFAULT_REMOTE_AUTH_PATH;
  normalized.workspace_root = canonicalRepoPath;
  return normalized;
}

function repoStateUpdatedAt(repoState) {
  const value = Date.parse(repoState?.updated_at || "");
  return Number.isFinite(value) ? value : 0;
}

module.exports = {
  cleanupLegacyAuthArtifacts,
  loadConfig,
  saveConfig,
};
