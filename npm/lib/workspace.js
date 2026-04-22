const fs = require("node:fs");
const path = require("node:path");

const { canonicalizeRepoPath, normalizeComparablePath, resolveConfigDir } = require("../service/common");
const { writeJsonFileIfChanged } = require("./file-ops");
const { gitOriginUrlFromRepo } = require("./git-config");
const { mergeGitOriginState, normalizeCwd } = require("./local-codex");
const { loadConfig, saveConfig } = require("./runtime-config");
const { DEFAULT_REMOTE_AUTH_PATH, DEFAULT_REMOTE_AUTH_TYPE } = require("./repo-auth");

const MANAGED_BLOCK_START = "<!-- codex-handoff:start -->";
const MANAGED_BLOCK_END = "<!-- codex-handoff:end -->";
const SYNCED_THREADS_DIRNAME = "synced-threads";
const LOCAL_THREADS_DIRNAME = "local-threads";

function legacyRepoStatePath(memoryDir) {
  return path.join(memoryDir, "repo.json");
}

function threadIndexPath(memoryDir) {
  return path.join(memoryDir, "thread-index.json");
}

function currentThreadPath(memoryDir) {
  return path.join(memoryDir, "current-thread.json");
}

function syncStatePath(memoryDir) {
  return path.join(memoryDir, "sync-state.json");
}

function repoRootFromMemoryDir(memoryDir) {
  let current = path.resolve(memoryDir || "");
  while (current && current !== path.dirname(current)) {
    if (path.basename(current) === ".codex-handoff") {
      return path.dirname(current);
    }
    current = path.dirname(current);
  }
  return path.dirname(path.resolve(memoryDir || "."));
}

function configRepoState(repoPath, configDir = resolveConfigDir()) {
  const config = loadConfig(configDir);
  const canonicalRepoPath = canonicalizeRepoPath(repoPath);
  const repos = config.repos || {};
  for (const [candidatePath, repoState] of Object.entries(repos)) {
    if (normalizeComparablePath(candidatePath) === normalizeComparablePath(canonicalRepoPath)) {
      return normalizeRepoState({
        ...repoState,
        machine_id: config.machine_id || null,
        workspace_root: canonicalRepoPath,
        repo_path: normalizeCwd(canonicalRepoPath),
        remote_auth_type: DEFAULT_REMOTE_AUTH_TYPE,
        remote_auth_path: DEFAULT_REMOTE_AUTH_PATH,
      });
    }
  }
  return {};
}

function loadRepoState(memoryDir, { repoPath = null, configDir = resolveConfigDir() } = {}) {
  const resolvedRepoPath = repoPath ? path.resolve(repoPath) : repoRootFromMemoryDir(memoryDir);
  return configRepoState(resolvedRepoPath, configDir);
}

function saveRepoState(memoryDir, payload, { repoPath = null, configDir = resolveConfigDir() } = {}) {
  const resolvedRepoPath = repoPath ? path.resolve(repoPath) : repoRootFromMemoryDir(memoryDir);
  const normalized = normalizeRepoState({
    ...payload,
    workspace_root: resolvedRepoPath,
    repo_path: normalizeCwd(resolvedRepoPath),
  });
  const config = loadConfig(configDir);
  if (!config.machine_id && normalized.machine_id) {
    config.machine_id = normalized.machine_id;
  }
  registerRepoMapping(config, resolvedRepoPath, normalized);
  const filePath = saveConfig(configDir, config);
  try {
    fs.rmSync(legacyRepoStatePath(memoryDir), { force: true });
  } catch {
    // Ignore legacy local repo-state cleanup failures.
  }
  return filePath;
}

function loadSyncState(memoryDir) {
  return normalizeSyncState(readJson(syncStatePath(memoryDir), {}));
}

function saveSyncState(memoryDir, payload) {
  ensureMemoryLayout(memoryDir);
  const filePath = syncStatePath(memoryDir);
  writeJsonFileIfChanged(filePath, normalizeSyncState(payload));
  return filePath;
}

function ensureMemoryLayout(memoryDir) {
  fs.mkdirSync(memoryDir, { recursive: true });
}

function syncedThreadsDir(memoryDir) {
  return path.join(memoryDir, SYNCED_THREADS_DIRNAME);
}

function localThreadsDir(memoryDir) {
  return path.join(memoryDir, LOCAL_THREADS_DIRNAME);
}

function materializedRootPaths(memoryDir) {
  return {
    latest: path.join(memoryDir, "latest.md"),
    handoff: path.join(memoryDir, "handoff.json"),
    memory: path.join(memoryDir, "memory.md"),
    transcript: path.join(memoryDir, "transcript.md"),
  };
}

function gitOriginUrl(repoPath) {
  return gitOriginUrlFromRepo(repoPath);
}

function inferRepoSlug(repoPath) {
  const origin = gitOriginUrl(repoPath);
  if (origin) {
    const parsed = slugFromOrigin(origin);
    if (parsed) return parsed;
  }
  return slugify(path.basename(repoPath));
}

function normalizeRepoSlugValue(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return null;
  }
  const normalized = raw
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "")
    .toLowerCase();
  return normalized || null;
}

function repoPrefixForSlug(slug) {
  const normalizedSlug = normalizeRepoSlugValue(slug);
  return normalizedSlug ? `repos/${normalizedSlug}/` : null;
}

function normalizeRepoSlugAliases(currentSlug, aliases = []) {
  const normalizedCurrent = normalizeRepoSlugValue(currentSlug);
  const normalizedAliases = [];
  const seen = new Set();
  for (const value of aliases || []) {
    const normalized = normalizeRepoSlugValue(value);
    if (!normalized || normalized === normalizedCurrent || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    normalizedAliases.push(normalized);
  }
  return normalizedAliases;
}

function repoSyncSlugs(repoState) {
  const normalized = normalizeRepoState(repoState);
  if (!normalized.repo_slug) {
    return [];
  }
  return [
    normalized.repo_slug,
    ...normalizeRepoSlugAliases(normalized.repo_slug, normalized.repo_slug_aliases),
  ];
}

function repoSyncPrefixes(repoState, extraPrefixes = []) {
  const normalized = normalizeRepoState(repoState);
  const prefixes = [];
  const seen = new Set();
  const append = (value) => {
    let normalizedPrefix = String(value || "").trim();
    if (!normalizedPrefix) {
      return;
    }
    normalizedPrefix = normalizedPrefix.replace(/^\/+|\/+$/g, "");
    normalizedPrefix = `${normalizedPrefix}/`;
    if (seen.has(normalizedPrefix)) {
      return;
    }
    seen.add(normalizedPrefix);
    prefixes.push(normalizedPrefix);
  };

  if (normalized.remote_prefix) {
    append(normalized.remote_prefix);
  } else if (normalized.repo_slug) {
    append(repoPrefixForSlug(normalized.repo_slug));
  }

  for (const value of extraPrefixes || []) {
    append(value);
  }

  return prefixes;
}

function buildRepoState(repoPath, { profileName, machineId, remoteSlug = null, includeRawThreads = false, summaryMode = "auto", matchMode = "auto", matchStatus = "create_new", projectName = null, previousRepoState = null }) {
  const slug = remoteSlug || inferRepoSlug(repoPath);
  const previousOrigins = normalizeRepoState(previousRepoState);
  const gitOrigins = mergeGitOriginState(
    gitOriginUrl(repoPath),
    previousOrigins.git_origin_url || null,
    previousOrigins.git_origin_urls || [],
  );
  const repoSlugAliases = normalizeRepoSlugAliases(slug, [
    ...(Array.isArray(previousOrigins.repo_slug_aliases) ? previousOrigins.repo_slug_aliases : []),
    ...(remoteSlug ? [] : [previousOrigins.repo_slug]),
  ]);
  return {
    schema_version: "1.0",
    machine_id: machineId,
    project_name: projectName || path.basename(repoPath),
    workspace_root: repoPath,
    codex_project: {
      project_name: projectName || path.basename(repoPath),
      workspace_root: repoPath,
      is_active: false,
      is_saved: false,
      is_in_project_order: false,
      is_in_sidebar_groups: false,
    },
    repo_path: normalizeCwd(repoPath),
    repo_slug: slug,
    repo_slug_aliases: repoSlugAliases,
    remote_auth_type: DEFAULT_REMOTE_AUTH_TYPE,
    remote_auth_path: DEFAULT_REMOTE_AUTH_PATH,
    remote_prefix: repoPrefixForSlug(slug),
    include_raw_threads: includeRawThreads,
    summary_mode: summaryMode,
    match_mode: matchMode,
    match_status: matchStatus,
    git_origin_url: gitOrigins.git_origin_url,
    git_origin_urls: gitOrigins.git_origin_urls,
    updated_at: new Date().toISOString(),
  };
}

function refreshRepoStateForCurrentRepo(repoPath, repoState = {}) {
  const existing = normalizeRepoState(repoState);
  if (!existing.repo_slug) {
    return existing;
  }
  const currentOrigin = gitOriginUrl(repoPath);
  const inferredSlug = currentOrigin ? slugFromOrigin(currentOrigin) : null;
  const gitOrigins = mergeGitOriginState(
    currentOrigin,
    existing.git_origin_url || null,
    existing.git_origin_urls || [],
  );
  const nextRepoSlug = String(existing.match_status || "") === "explicit"
    ? existing.repo_slug
    : (inferredSlug || existing.repo_slug);
  const nextRepoSlugAliases = normalizeRepoSlugAliases(nextRepoSlug, [
    existing.repo_slug,
    ...(Array.isArray(existing.repo_slug_aliases) ? existing.repo_slug_aliases : []),
  ]);
  return normalizeRepoState({
    ...existing,
    project_name: existing.project_name || path.basename(repoPath),
    workspace_root: repoPath,
    codex_project: {
      project_name: existing.project_name || path.basename(repoPath),
      workspace_root: repoPath,
      is_active: Boolean(existing.codex_project?.is_active),
      is_saved: Boolean(existing.codex_project?.is_saved),
      is_in_project_order: Boolean(existing.codex_project?.is_in_project_order),
      is_in_sidebar_groups: Boolean(existing.codex_project?.is_in_sidebar_groups),
    },
    repo_path: normalizeCwd(repoPath),
    repo_slug: nextRepoSlug,
    repo_slug_aliases: nextRepoSlugAliases,
    remote_prefix: repoPrefixForSlug(nextRepoSlug),
    git_origin_url: gitOrigins.git_origin_url,
    git_origin_urls: gitOrigins.git_origin_urls,
    updated_at: new Date().toISOString(),
  });
}

function registerRepoMapping(configPayload, repoPath, repoState) {
  const repos = configPayload.repos || (configPayload.repos = {});
  const canonicalRepoPath = canonicalizeRepoPath(repoPath);
  for (const existingKey of Object.keys(repos)) {
    if (normalizeCwd(existingKey) === normalizeCwd(canonicalRepoPath)) {
      delete repos[existingKey];
    }
  }
  repos[canonicalRepoPath] = {
    repo_slug: repoState.repo_slug,
    git_origin_url: repoState.git_origin_url || null,
    git_origin_urls: Array.isArray(repoState.git_origin_urls) ? repoState.git_origin_urls : [],
    summary_mode: repoState.summary_mode || "auto",
    include_raw_threads: repoState.include_raw_threads === true,
    updated_at: new Date().toISOString(),
  };
  return configPayload;
}

function unregisterRepoMapping(configPayload, repoPath) {
  const repos = configPayload.repos || (configPayload.repos = {});
  const key = normalizeCwd(repoPath);
  let removed = false;
  for (const existingKey of Object.keys(repos)) {
    if (existingKey === repoPath || normalizeCwd(existingKey) === key) {
      delete repos[existingKey];
      removed = true;
    }
  }
  return {
    config: configPayload,
    removed,
    remaining_repo_count: Object.keys(repos).length,
  };
}

function ensureAgentsBlock(repoPath, repoState) {
  const agentsPath = path.join(repoPath, "AGENTS.md");
  const existing = fs.existsSync(agentsPath) ? fs.readFileSync(agentsPath, "utf8") : "";
  const block = renderAgentsBlock(repoState);
  let updated;
  if (existing.includes(MANAGED_BLOCK_START) && existing.includes(MANAGED_BLOCK_END)) {
    updated = existing.replace(new RegExp(`${escapeRegExp(MANAGED_BLOCK_START)}[\\s\\S]*?${escapeRegExp(MANAGED_BLOCK_END)}`), block);
  } else if (existing.trim()) {
    updated = `${existing.trimEnd()}\n\n${block}\n`;
  } else {
    updated = `${block}\n`;
  }
  fs.writeFileSync(agentsPath, updated, "utf8");
  return agentsPath;
}

function removeAgentsBlock(repoPath) {
  const agentsPath = path.join(repoPath, "AGENTS.md");
  if (!fs.existsSync(agentsPath)) {
    return { path: agentsPath, removed: false, exists: false };
  }
  const existing = fs.readFileSync(agentsPath, "utf8");
  if (!existing.includes(MANAGED_BLOCK_START) || !existing.includes(MANAGED_BLOCK_END)) {
    return { path: agentsPath, removed: false, exists: true };
  }
  const pattern = new RegExp(`\\n?${escapeRegExp(MANAGED_BLOCK_START)}[\\s\\S]*?${escapeRegExp(MANAGED_BLOCK_END)}\\n?`, "m");
  const updated = existing.replace(pattern, "\n").replace(/\n{3,}/g, "\n\n").trimEnd();
  if (updated) {
    fs.writeFileSync(agentsPath, `${updated}\n`, "utf8");
  } else {
    fs.rmSync(agentsPath, { force: true });
  }
  return { path: agentsPath, removed: true, exists: true };
}

function ensureMemoryDirGitignored(repoPath, memoryDir) {
  const relative = path.relative(repoPath, memoryDir).split(path.sep).join("/");
  if (!relative || relative.startsWith("..")) {
    return null;
  }
  const entry = `${relative.replace(/\/+$/, "")}/`;
  const gitignorePath = path.join(repoPath, ".gitignore");
  const existing = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, "utf8") : "";
  const lines = existing.split(/\r?\n/).map((line) => line.trim());
  if (!lines.includes(entry)) {
    const next = existing && !existing.endsWith("\n") ? `${existing}\n${entry}\n` : `${existing}${entry}\n`;
    fs.writeFileSync(gitignorePath, next, "utf8");
  }
  return gitignorePath;
}

function removeMemoryDirGitignoreEntry(repoPath, memoryDir) {
  const relative = path.relative(repoPath, memoryDir).split(path.sep).join("/");
  if (!relative || relative.startsWith("..")) {
    return { path: null, removed: false };
  }
  const entry = `${relative.replace(/\/+$/, "")}/`;
  const gitignorePath = path.join(repoPath, ".gitignore");
  if (!fs.existsSync(gitignorePath)) {
    return { path: gitignorePath, removed: false };
  }
  const original = fs.readFileSync(gitignorePath, "utf8");
  const filtered = original
    .split(/\r?\n/)
    .filter((line) => line.trim() !== entry)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s+$/u, "");
  if (filtered === original.replace(/\s+$/u, "")) {
    return { path: gitignorePath, removed: false };
  }
  if (filtered) {
    fs.writeFileSync(gitignorePath, `${filtered}\n`, "utf8");
  } else {
    fs.rmSync(gitignorePath, { force: true });
  }
  return { path: gitignorePath, removed: true };
}

function renderAgentsBlock(repoState) {
  return [
    MANAGED_BLOCK_START,
    "## Codex Handoff Sync",
    "",
    "This repository is attached to codex-handoff sync.",
    `- local project name: \`${repoState.project_name || ""}\``,
    `- remote auth: \`${repoState.remote_auth_type || DEFAULT_REMOTE_AUTH_TYPE}\``,
    `- remote auth file: \`${repoState.remote_auth_path || DEFAULT_REMOTE_AUTH_PATH}\``,
    `- remote repo slug: \`${repoState.repo_slug}\``,
    `- remote prefix: \`${repoState.remote_prefix}\``,
    `- summary mode: \`${repoState.summary_mode}\``,
    `- include raw threads: \`${String(repoState.include_raw_threads).toLowerCase()}\``,
    `- match status: \`${repoState.match_status}\``,
    "",
    "Before doing substantive work in this repository:",
    "0. If the local `codex-handoff` skill is installed, use it for sync, receive, and resume orchestration.",
    "1. Read `.codex-handoff/memory.md` first when it exists; it is the compact repo-level summary.",
    "2. If you need detailed context, read `.codex-handoff/synced-threads/current-thread.json`, then inspect the referenced bundle under `.codex-handoff/synced-threads/threads/`.",
    "3. If you need broader context beyond the current thread, use `.codex-handoff/synced-threads/thread-index.json` to choose additional specific thread bundles before reading them.",
    "4. If the user asks to continue previous work, run `codex-handoff --repo . resume --goal \"<user-goal>\"`.",
    "5. Never enumerate or bulk-read `.codex-handoff/synced-threads/threads/**` or raw session jsonl files. Only inspect the specific bundle(s) selected from `current-thread.json`, `thread-index.json`, or an explicit user request.",
    MANAGED_BLOCK_END,
  ].join("\n");
}

function slugify(value) {
  const slug = String(value || "").trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-._]+|[-._]+$/g, "").toLowerCase();
  return slug || "repo";
}

function slugFromOrigin(origin) {
  let normalized = String(origin || "").trim();
  if (normalized.endsWith(".git")) normalized = normalized.slice(0, -4);
  let parts;
  if (normalized.includes("://")) parts = normalized.split("://", 2)[1].split("/");
  else if (normalized.includes("@") && normalized.includes(":")) parts = normalized.split(":", 2)[1].split("/");
  else parts = normalized.split("/");
  if (parts.length < 2) return null;
  const owner = slugify(parts[parts.length - 2]);
  const repo = slugify(parts[parts.length - 1]);
  return owner ? `${owner}-${repo}` : repo;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function normalizeRepoState(payload) {
  if (!payload || typeof payload !== "object") {
    return {};
  }
  const normalized = { ...payload };
  delete normalized.remote_profile;
  if (normalized.repo_slug) {
    normalized.repo_slug = normalizeRepoSlugValue(normalized.repo_slug);
  }
  normalized.repo_slug_aliases = normalizeRepoSlugAliases(
    normalized.repo_slug,
    Array.isArray(normalized.repo_slug_aliases) ? normalized.repo_slug_aliases : [],
  );
  if (normalized.repo_slug) {
    normalized.remote_auth_type = DEFAULT_REMOTE_AUTH_TYPE;
    normalized.remote_auth_path = DEFAULT_REMOTE_AUTH_PATH;
    normalized.remote_prefix = repoPrefixForSlug(normalized.repo_slug);
  }
  const gitOrigins = mergeGitOriginState(
    normalized.git_origin_url || null,
    null,
    Array.isArray(normalized.git_origin_urls) ? normalized.git_origin_urls : [],
  );
  normalized.git_origin_url = gitOrigins.git_origin_url;
  normalized.git_origin_urls = gitOrigins.git_origin_urls;
  return normalized;
}

function normalizeSyncState(payload) {
  if (!payload || typeof payload !== "object") {
    return {};
  }
  const normalized = { ...payload };
  delete normalized.remote_profile;
  if (normalized.repo_slug) {
    normalized.remote_auth_type = DEFAULT_REMOTE_AUTH_TYPE;
    normalized.remote_auth_path = DEFAULT_REMOTE_AUTH_PATH;
  }
  return normalized;
}

function relocalizeRepoState(repoPath, repoState, fallbackState = {}) {
  const source = normalizeRepoState(repoState);
  const fallback = normalizeRepoState(fallbackState);
  if (!source.repo_slug && !fallback.repo_slug) {
    return normalizeRepoState(source);
  }
  const preserveFallbackCanonical = Boolean(
    source.repo_slug &&
    fallback.repo_slug &&
    source.repo_slug !== fallback.repo_slug &&
    normalizeRepoSlugAliases(fallback.repo_slug, fallback.repo_slug_aliases).includes(source.repo_slug),
  );
  const projectName = fallback.project_name || source.project_name || path.basename(repoPath);
  const localized = buildRepoState(repoPath, {
    machineId: fallback.machine_id || source.machine_id || null,
    remoteSlug: preserveFallbackCanonical
      ? fallback.repo_slug
      : (source.repo_slug || fallback.repo_slug || null),
    includeRawThreads: source.include_raw_threads === true || fallback.include_raw_threads === true,
    summaryMode: source.summary_mode || fallback.summary_mode || "auto",
    matchMode: fallback.match_mode || source.match_mode || "auto",
    matchStatus: fallback.match_status || source.match_status || "existing_local",
    projectName,
    previousRepoState: {
      repo_slug: preserveFallbackCanonical ? source.repo_slug : fallback.repo_slug,
      repo_slug_aliases: [
        ...(Array.isArray(source.repo_slug_aliases) ? source.repo_slug_aliases : []),
        ...(Array.isArray(fallback.repo_slug_aliases) ? fallback.repo_slug_aliases : []),
      ],
      git_origin_url: source.git_origin_url || fallback.git_origin_url || null,
      git_origin_urls: [
        ...(Array.isArray(source.git_origin_urls) ? source.git_origin_urls : []),
        ...(Array.isArray(fallback.git_origin_urls) ? fallback.git_origin_urls : []),
      ],
    },
  });
  const codexProject = source.codex_project || fallback.codex_project || {};
  localized.codex_project = {
    project_name: projectName,
    workspace_root: repoPath,
    is_active: Boolean(codexProject.is_active),
    is_saved: Boolean(codexProject.is_saved),
    is_in_project_order: Boolean(codexProject.is_in_project_order),
    is_in_sidebar_groups: Boolean(codexProject.is_in_sidebar_groups),
  };
  if (fallback.installed_skill_path || source.installed_skill_path) {
    localized.installed_skill_path = fallback.installed_skill_path || source.installed_skill_path;
  }
  return localized;
}

module.exports = {
  currentThreadPath,
  buildRepoState,
  ensureMemoryLayout,
  ensureAgentsBlock,
  ensureMemoryDirGitignored,
  gitOriginUrl,
  inferRepoSlug,
  localThreadsDir,
  syncedThreadsDir,
  loadRepoState,
  loadSyncState,
  materializedRootPaths,
  removeAgentsBlock,
  removeMemoryDirGitignoreEntry,
  repoPrefixForSlug,
  refreshRepoStateForCurrentRepo,
  repoSyncPrefixes,
  repoSyncSlugs,
  registerRepoMapping,
  relocalizeRepoState,
  normalizeRepoSlugAliases,
  unregisterRepoMapping,
  saveRepoState,
  saveSyncState,
  syncStatePath,
  threadIndexPath,
};
