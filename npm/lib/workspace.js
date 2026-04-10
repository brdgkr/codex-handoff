const fs = require("node:fs");
const path = require("node:path");

const { canonicalizeRepoPath } = require("../service/common");
const { writeJsonFileIfChanged } = require("./file-ops");
const { gitOriginUrlFromRepo } = require("./git-config");
const { mergeGitOriginState, normalizeCwd } = require("./local-codex");
const { DEFAULT_REMOTE_AUTH_PATH, DEFAULT_REMOTE_AUTH_TYPE } = require("./repo-auth");

const MANAGED_BLOCK_START = "<!-- codex-handoff:start -->";
const MANAGED_BLOCK_END = "<!-- codex-handoff:end -->";

function repoStatePath(memoryDir) {
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

function loadRepoState(memoryDir) {
  return normalizeRepoState(readJson(repoStatePath(memoryDir), {}));
}

function saveRepoState(memoryDir, payload) {
  ensureMemoryLayout(memoryDir);
  const filePath = repoStatePath(memoryDir);
  writeJsonFileIfChanged(filePath, normalizeRepoState(payload));
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
  fs.mkdirSync(path.join(memoryDir, "threads"), { recursive: true });
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

function buildRepoState(repoPath, { profileName, machineId, remoteSlug = null, includeRawThreads = false, summaryMode = "auto", matchMode = "auto", matchStatus = "create_new", projectName = null, previousRepoState = null }) {
  const slug = remoteSlug || inferRepoSlug(repoPath);
  const previousOrigins = normalizeRepoState(previousRepoState);
  const gitOrigins = mergeGitOriginState(
    gitOriginUrl(repoPath),
    previousOrigins.git_origin_url || null,
    previousOrigins.git_origin_urls || [],
  );
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
    remote_auth_type: DEFAULT_REMOTE_AUTH_TYPE,
    remote_auth_path: DEFAULT_REMOTE_AUTH_PATH,
    remote_prefix: `repos/${slug}/`,
    include_raw_threads: includeRawThreads,
    summary_mode: summaryMode,
    match_mode: matchMode,
    match_status: matchStatus,
    git_origin_url: gitOrigins.git_origin_url,
    git_origin_urls: gitOrigins.git_origin_urls,
    updated_at: new Date().toISOString(),
  };
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
    machine_id: repoState.machine_id,
    project_name: repoState.project_name || "",
    workspace_root: repoState.workspace_root || canonicalRepoPath,
    repo_slug: repoState.repo_slug,
    remote_auth_type: repoState.remote_auth_type || DEFAULT_REMOTE_AUTH_TYPE,
    remote_auth_path: repoState.remote_auth_path || DEFAULT_REMOTE_AUTH_PATH,
    remote_prefix: repoState.remote_prefix,
    summary_mode: repoState.summary_mode,
    include_raw_threads: repoState.include_raw_threads,
    match_mode: repoState.match_mode,
    match_status: repoState.match_status,
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
    `- local workspace root: \`${repoState.workspace_root || ""}\``,
    `- remote auth: \`${repoState.remote_auth_type || DEFAULT_REMOTE_AUTH_TYPE}\``,
    `- remote auth file: \`${repoState.remote_auth_path || DEFAULT_REMOTE_AUTH_PATH}\``,
    `- remote repo slug: \`${repoState.repo_slug}\``,
    `- remote prefix: \`${repoState.remote_prefix}\``,
    `- summary mode: \`${repoState.summary_mode}\``,
    `- include raw threads: \`${String(repoState.include_raw_threads).toLowerCase()}\``,
    `- match status: \`${repoState.match_status}\``,
    `- installed skill path: \`${repoState.installed_skill_path || ""}\``,
    "",
    "Before doing substantive work in this repository:",
    "0. If the local `codex-handoff` skill is installed, use it for sync, pull, import, and resume orchestration.",
    "1. Read `.codex-handoff/latest.md` first if it exists.",
    "2. Read `.codex-handoff/memory.md` if it exists; it is the compact repo-level memory intended for new Codex sessions.",
    "3. If the user asks to continue previous work, run `codex-handoff --repo . resume --goal \"<user-goal>\"`.",
    "4. If the bootstrap summary is insufficient, inspect `.codex-handoff/handoff.json`.",
    "5. Never enumerate or bulk-read `.codex-handoff/threads/**` or raw session jsonl files. Only inspect a specific thread bundle when `.codex-handoff/memory.md`, `handoff.json`, or a user request points to that exact thread.",
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
    normalized.remote_auth_type = DEFAULT_REMOTE_AUTH_TYPE;
    normalized.remote_auth_path = DEFAULT_REMOTE_AUTH_PATH;
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
  const projectName = fallback.project_name || source.project_name || path.basename(repoPath);
  const localized = buildRepoState(repoPath, {
    machineId: fallback.machine_id || source.machine_id || null,
    remoteSlug: source.repo_slug || fallback.repo_slug || null,
    includeRawThreads: source.include_raw_threads === true || fallback.include_raw_threads === true,
    summaryMode: source.summary_mode || fallback.summary_mode || "auto",
    matchMode: fallback.match_mode || source.match_mode || "auto",
    matchStatus: fallback.match_status || source.match_status || "existing_local",
    projectName,
    previousRepoState: {
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
  loadRepoState,
  loadSyncState,
  materializedRootPaths,
  removeAgentsBlock,
  removeMemoryDirGitignoreEntry,
  registerRepoMapping,
  relocalizeRepoState,
  unregisterRepoMapping,
  saveRepoState,
  repoStatePath,
  saveSyncState,
  syncStatePath,
  threadIndexPath,
};
