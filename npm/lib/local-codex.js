const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");

const { gitOriginUrlFromRepo } = require("./git-config");

function codexPaths(codexHome) {
  const base = path.resolve(codexHome || path.join(os.homedir(), ".codex"));
  return {
    codexHome: base,
    sessionsRoot: path.join(base, "sessions"),
    sessionIndexPath: path.join(base, "session_index.jsonl"),
    stateDbPath: path.join(base, "state_5.sqlite"),
  };
}

function readRolloutRecords(filePath) {
  return fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function readSessionIndexMap(filePath) {
  if (!fs.existsSync(filePath)) {
    return new Map();
  }
  const map = new Map();
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    const payload = JSON.parse(line);
    if (typeof payload.id === "string") {
      map.set(payload.id, payload);
    }
  }
  return map;
}

function upsertSessionIndex(filePath, entry) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const existing = [];
  if (fs.existsSync(filePath)) {
    for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      const payload = JSON.parse(line);
      if (payload.id === entry.id) continue;
      existing.push(payload);
    }
  }
  existing.push(entry);
  const body = existing.map((item) => `${JSON.stringify(item)}\n`).join("");
  fs.writeFileSync(filePath, body, "utf8");
}

function rewriteSessionIndexWithout(filePath, threadId) {
  if (!fs.existsSync(filePath)) {
    return;
  }
  const keep = [];
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const payload = JSON.parse(line);
    if (payload.id === threadId) continue;
    keep.push(payload);
  }
  const body = keep.map((item) => `${JSON.stringify(item)}\n`).join("");
  fs.writeFileSync(filePath, body, "utf8");
}

function sessionIndexRemovalCount(filePath, threadId) {
  if (!fs.existsSync(filePath)) {
    return 0;
  }
  let count = 0;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const payload = JSON.parse(line);
    if (payload.id === threadId) count += 1;
  }
  return count;
}

function discoverThreadsForRepo(repoPath, codexHome, repoState = null) {
  const paths = codexPaths(codexHome);
  if (!fs.existsSync(paths.stateDbPath)) {
    return [];
  }
  const repoKey = normalizeCwd(repoPath);
  const repoNameHints = [
    path.basename(repoPath).trim().toLowerCase(),
    gitOriginRepoName(repoGitOriginUrl(repoPath)),
    gitOriginRepoName(repoState?.git_origin_url || null),
    ...(Array.isArray(repoState?.git_origin_urls) ? repoState.git_origin_urls.map((value) => gitOriginRepoName(value)) : []),
  ].filter(Boolean);
  const indexMap = readSessionIndexMap(paths.sessionIndexPath);
  const db = new Database(paths.stateDbPath, { readonly: true, fileMustExist: true });
  try {
    const stmt = db.prepare("SELECT * FROM threads ORDER BY updated_at DESC");
    const rows = stmt.all();
    const observedOrigins = gitOriginAliases(
      rows
        .filter((row) => normalizeCwd(row.cwd) === repoKey)
        .map((row) => row.git_origin_url || null)
        .filter((value) => {
          const repoName = gitOriginRepoName(value);
          return repoName && repoNameHints.includes(repoName);
        }),
    );
    const repoOrigins = gitOriginAliases(
      repoGitOriginUrl(repoPath),
      repoState?.git_origin_url || null,
      Array.isArray(repoState?.git_origin_urls) ? repoState.git_origin_urls : [],
      observedOrigins,
    );
    return rows
      .filter((row) => threadMatchesRepo(row, repoKey, repoOrigins))
      .map((row) => ({
        threadId: row.id,
        title: row.title,
        cwd: stripWindowsPrefix(row.cwd),
        rolloutPath: stripWindowsPrefix(row.rollout_path),
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
        row,
        sessionIndexEntry: indexMap.get(row.id) || null,
      }));
  } finally {
    db.close();
  }
}

function ensureThreadsTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS threads (
    id TEXT PRIMARY KEY,
    rollout_path TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    source TEXT NOT NULL,
    model_provider TEXT NOT NULL,
    cwd TEXT NOT NULL,
    title TEXT NOT NULL,
    sandbox_policy TEXT NOT NULL,
    approval_mode TEXT NOT NULL,
    tokens_used INTEGER NOT NULL DEFAULT 0,
    has_user_event INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    archived_at INTEGER,
    git_sha TEXT,
    git_branch TEXT,
    git_origin_url TEXT,
    cli_version TEXT NOT NULL DEFAULT '',
    first_user_message TEXT NOT NULL DEFAULT '',
    agent_nickname TEXT,
    agent_role TEXT,
    memory_mode TEXT NOT NULL DEFAULT 'enabled',
    model TEXT,
    reasoning_effort TEXT,
    agent_path TEXT
  )`);
}

function upsertThreadRow(filePath, row) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new Database(filePath);
  try {
    ensureThreadsTable(db);
    const columns = Object.keys(row);
    const placeholders = columns.map(() => "?").join(", ");
    const sql = `INSERT OR REPLACE INTO threads (${columns.join(", ")}) VALUES (${placeholders})`;
    db.prepare(sql).run(...columns.map((column) => row[column]));
  } finally {
    db.close();
  }
}

function threadRowExists(filePath, threadId) {
  if (!fs.existsSync(filePath)) {
    return false;
  }
  const db = new Database(filePath, { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare("SELECT 1 FROM threads WHERE id = ? LIMIT 1").get(threadId);
    return Boolean(row);
  } finally {
    db.close();
  }
}

function findThreadById(codexHome, threadId) {
  const paths = codexPaths(codexHome);
  if (!threadId || !fs.existsSync(paths.stateDbPath)) {
    return null;
  }
  const db = new Database(paths.stateDbPath, { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare("SELECT * FROM threads WHERE id = ? LIMIT 1").get(threadId);
    return normalizeThreadLookupRow(row);
  } finally {
    db.close();
  }
}

function findThreadByRolloutPath(codexHome, rolloutPath) {
  const paths = codexPaths(codexHome);
  if (!rolloutPath || !fs.existsSync(paths.stateDbPath)) {
    return null;
  }
  const targetPath = normalizeCwd(rolloutPath);
  if (!targetPath) {
    return null;
  }
  const db = new Database(paths.stateDbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = db.prepare("SELECT * FROM threads ORDER BY updated_at DESC").all();
    const row = rows.find((candidate) => normalizeCwd(candidate.rollout_path) === targetPath) || null;
    return normalizeThreadLookupRow(row);
  } finally {
    db.close();
  }
}

function findRolloutPath(filePath, threadId) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const db = new Database(filePath, { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare("SELECT rollout_path FROM threads WHERE id = ?").get(threadId);
    return row?.rollout_path ? stripWindowsPrefix(String(row.rollout_path)) : null;
  } finally {
    db.close();
  }
}

function deleteThreadRow(filePath, threadId) {
  if (!fs.existsSync(filePath)) {
    return;
  }
  const db = new Database(filePath);
  try {
    db.prepare("DELETE FROM threads WHERE id = ?").run(threadId);
  } finally {
    db.close();
  }
}

function writeRolloutFile(filePath, records) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const body = records.map((record) => `${JSON.stringify(record)}\n`).join("");
  fs.writeFileSync(filePath, body, "utf8");
}

function dbRolloutPath(filePath) {
  const resolved = path.resolve(filePath);
  if (process.platform === "win32" && !resolved.startsWith("\\\\?\\")) {
    return `\\\\?\\${resolved}`;
  }
  return resolved;
}

function dbCwd(filePath) {
  return dbRolloutPath(filePath);
}

function cleanupThread(paths, threadId, { apply = false } = {}) {
  const rolloutPath = findRolloutPath(paths.stateDbPath, threadId);
  const sessionIndexMatches = sessionIndexRemovalCount(paths.sessionIndexPath, threadId);
  const existsInDb = threadRowExists(paths.stateDbPath, threadId);
  const rolloutExists = Boolean(rolloutPath && fs.existsSync(rolloutPath));
  const result = {
    thread_id: threadId,
    thread_exists: existsInDb,
    session_index_matches: sessionIndexMatches,
    rollout_path: rolloutPath,
    rollout_exists: rolloutExists,
    applied: apply,
  };
  if (!apply) {
    return result;
  }
  if (rolloutPath && fs.existsSync(rolloutPath)) {
    fs.rmSync(rolloutPath, { force: true });
  }
  rewriteSessionIndexWithout(paths.sessionIndexPath, threadId);
  deleteThreadRow(paths.stateDbPath, threadId);
  result.thread_exists = false;
  result.session_index_matches = 0;
  result.rollout_exists = false;
  return result;
}

function threadMatchesRepo(row, repoKey, repoOrigins) {
  const rowOrigin = normalizeGitOriginUrl(String(row.git_origin_url || ""));
  if (rowOrigin) {
    if (Array.isArray(repoOrigins) && repoOrigins.length > 0) {
      return repoOrigins.some((origin) => normalizeGitOriginUrl(origin) === rowOrigin);
    }
    return normalizeCwd(row.cwd) === repoKey;
  }
  return normalizeCwd(row.cwd) === repoKey;
}

function normalizeCwd(value) {
  const raw = stripWindowsPrefix(String(value || ""));
  if (!raw) {
    return "";
  }
  const normalized = isWindowsStylePath(raw)
    ? path.win32.normalize(raw)
    : path.resolve(raw);
  return isWindowsStylePath(raw)
    ? normalized.replace(/\\/g, "/").toLowerCase()
    : normalized;
}

function repoGitOriginUrl(repoPath) {
  return gitOriginUrlFromRepo(repoPath);
}

function normalizeGitOriginUrl(value) {
  if (!value) {
    return null;
  }
  let normalized = String(value).trim();
  if (normalized.endsWith(".git")) {
    normalized = normalized.slice(0, -4);
  }
  if (normalized.includes("://")) {
    normalized = normalized.split("://", 2)[1];
  } else if (normalized.includes("@") && normalized.includes(":")) {
    const [userHost, rest] = normalized.split(":", 2);
    normalized = `${userHost.split("@").pop()}/${rest}`;
  }
  normalized = normalized.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").toLowerCase();
  return normalized || null;
}

function gitOriginRepoName(value) {
  const normalized = normalizeGitOriginUrl(value);
  if (!normalized) {
    return null;
  }
  const parts = normalized.split("/");
  return parts.length ? parts[parts.length - 1] : null;
}

function gitOriginAliases(...values) {
  const aliases = [];
  const seen = new Set();
  for (const value of values.flat()) {
    appendGitOriginAlias(aliases, seen, value);
  }
  return aliases;
}

function mergeGitOriginState(currentOrigin, previousOrigin = null, previousOrigins = []) {
  const current = String(currentOrigin || "").trim() || String(previousOrigin || "").trim() || null;
  const history = [];
  const seen = new Set();
  const currentKey = normalizeGitOriginUrl(current);
  if (currentKey) {
    seen.add(currentKey);
  }
  appendGitOriginAlias(history, seen, previousOrigin);
  for (const value of previousOrigins || []) {
    appendGitOriginAlias(history, seen, value);
  }
  return {
    git_origin_url: current,
    git_origin_urls: history,
  };
}

function appendGitOriginAlias(target, seen, value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return;
  }
  const normalized = normalizeGitOriginUrl(raw);
  if (!normalized || seen.has(normalized)) {
    return;
  }
  seen.add(normalized);
  target.push(raw);
}

function stripWindowsPrefix(value) {
  return value.startsWith("\\\\?\\") ? value.slice(4) : value;
}

function isWindowsStylePath(value) {
  return /^[A-Za-z]:[\\/]/.test(value);
}

function normalizeThreadLookupRow(row) {
  if (!row) {
    return null;
  }
  return {
    threadId: row.id,
    title: row.title || row.id,
    cwd: stripWindowsPrefix(String(row.cwd || "")) || null,
    rolloutPath: stripWindowsPrefix(String(row.rollout_path || "")) || null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    row,
  };
}

module.exports = {
  cleanupThread,
  codexPaths,
  dbCwd,
  dbRolloutPath,
  deleteThreadRow,
  discoverThreadsForRepo,
  findThreadById,
  findThreadByRolloutPath,
  findRolloutPath,
  gitOriginAliases,
  mergeGitOriginState,
  normalizeCwd,
  normalizeGitOriginUrl,
  readRolloutRecords,
  readSessionIndexMap,
  repoGitOriginUrl,
  stripWindowsPrefix,
  threadRowExists,
  upsertSessionIndex,
  upsertThreadRow,
  writeRolloutFile,
  rewriteSessionIndexWithout,
  sessionIndexRemovalCount,
};
