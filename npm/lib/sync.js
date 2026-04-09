const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const {
  cleanupThread,
  codexPaths,
  dbCwd,
  dbRolloutPath,
  discoverThreadsForRepo,
  normalizeCwd,
  normalizeGitOriginUrl,
  readRolloutRecords,
  readSessionIndexMap,
  repoGitOriginUrl,
  stripWindowsPrefix,
  upsertSessionIndex,
  upsertThreadRow,
} = require("./local-codex");
const { deleteR2Object, getR2Object, listR2Objects, putR2Object } = require("./r2");
const { extractCanonicalMessages, summarizeRollout } = require("./summarize");
const {
  currentThreadPath,
  ensureMemoryLayout,
  loadRepoState,
  relocalizeRepoState,
  loadSyncState,
  materializedRootPaths,
  saveRepoState,
  saveSyncState,
  syncStatePath,
  threadIndexPath,
} = require("./workspace");
const { DEFAULT_REMOTE_AUTH_PATH, DEFAULT_REMOTE_AUTH_TYPE } = require("./repo-auth");

async function exportRepoThreads(repoPath, memoryDir, { codexHome, includeRawThreads = false }) {
  ensureMemoryLayout(memoryDir);
  cleanupLegacyThreadArtifacts(memoryDir);
  cleanupRootHistoryArtifacts(memoryDir);
  const repoState = loadRepoState(memoryDir);
  const threads = discoverThreadsForRepo(repoPath, codexHome, repoState);
  const existingIndex = new Map(loadThreadIndex(memoryDir).map((entry) => [entry.thread_id, entry]));
  const indexPayload = [];
  const exportedThreads = [];
  for (const thread of threads) {
    const previousEntry = existingIndex.get(thread.threadId) || null;
    if (thread.rolloutPath && fs.existsSync(thread.rolloutPath)) {
      exportThreadBundle(repoPath, memoryDir, thread, { includeRawThreads });
      indexPayload.push(buildThreadIndexEntry(thread, previousEntry));
      exportedThreads.push(thread);
      continue;
    }
    if (loadThreadTranscript(memoryDir, thread.threadId)) {
      indexPayload.push(buildThreadIndexEntry(thread, previousEntry, { preserveSourceRelpath: true }));
      exportedThreads.push(thread);
    }
  }

  saveThreadIndex(memoryDir, indexPayload);
  if (exportedThreads.length) {
    fs.writeFileSync(currentThreadPath(memoryDir), JSON.stringify({ thread_id: exportedThreads[0].threadId }, null, 2) + "\n", "utf8");
    materializeRootFromThread(memoryDir, exportedThreads[0].threadId);
  } else {
    clearMaterializedRoot(memoryDir);
  }
  return exportedThreads;
}

function buildThreadIndexEntry(thread, previousEntry = null, { preserveSourceRelpath = false } = {}) {
  return {
    thread_id: thread.threadId,
    title: thread.title || previousEntry?.title || thread.threadId,
    thread_name: thread.sessionIndexEntry?.thread_name || previousEntry?.thread_name || null,
    created_at: thread.createdAt ?? previousEntry?.created_at ?? null,
    updated_at: thread.updatedAt ?? previousEntry?.updated_at ?? null,
    source_session_relpath: preserveSourceRelpath
      ? (previousEntry?.source_session_relpath || relativeSessionPath(thread.rolloutPath || ""))
      : relativeSessionPath(thread.rolloutPath || ""),
    bundle_path: path.join("threads", `${thread.threadId}.json`),
  };
}

function exportThreadBundle(repoPath, memoryDir, thread, { includeRawThreads = false }) {
  const threadsDir = path.join(memoryDir, "threads");
  fs.mkdirSync(threadsDir, { recursive: true });
  const bundlePath = path.join(threadsDir, `${thread.threadId}.json`);
  const sourceArchivePath = path.join(threadsDir, `${thread.threadId}.rollout.jsonl.gz`);

  const rolloutRecords = readRolloutRecords(thread.rolloutPath);
  const summary = summarizeRollout(repoPath, thread, rolloutRecords);
  saveThreadTranscript(memoryDir, thread.threadId, summary.rawRecords);

  if (includeRawThreads) {
    const payload = fs.readFileSync(thread.rolloutPath);
    fs.writeFileSync(sourceArchivePath, zlib.gzipSync(payload));
  } else if (fs.existsSync(sourceArchivePath)) {
    fs.rmSync(sourceArchivePath, { force: true });
  }

  return bundlePath;
}

function loadThreadTranscript(memoryDir, threadId) {
  const bundlePath = path.join(memoryDir, "threads", `${threadId}.json`);
  if (!fs.existsSync(bundlePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(bundlePath, "utf8"));
}

function saveThreadTranscript(memoryDir, threadId, transcript) {
  const threadsDir = path.join(memoryDir, "threads");
  fs.mkdirSync(threadsDir, { recursive: true });
  const bundlePath = path.join(threadsDir, `${threadId}.json`);
  fs.writeFileSync(bundlePath, JSON.stringify(transcript, null, 2) + "\n", "utf8");
  return bundlePath;
}

function updateThreadBundleFromRolloutChange(repoPath, memoryDir, thread, { newLines, parserState, includeRawThreads = false }) {
  const records = [];
  for (const line of newLines || []) {
    try {
      records.push(JSON.parse(line));
    } catch {
      // Ignore malformed incremental lines.
    }
  }
  const extracted = extractCanonicalMessages(records, parserState || {});
  const messages = extracted.messages;
  const nextParserState = extracted.state;

  const existingTranscript = loadThreadTranscript(memoryDir, thread.threadId);
  const transcript = Array.isArray(existingTranscript) ? [...existingTranscript] : [];
  const seen = new Set(
    transcript.map((item) => JSON.stringify([item.turn_id || "", item.role || "", item.phase || "", String(item.message || "").replace(/\s+/g, " ")])),
  );
  for (const message of messages) {
    const key = JSON.stringify([message.turn_id || "", message.role || "", message.phase || "", String(message.message || "").replace(/\s+/g, " ")]);
    if (!seen.has(key)) {
      seen.add(key);
      transcript.push(message);
    }
  }

  if (!existingTranscript && transcript.length === 0) {
    return { transcript: null, nextParserState, touched: false };
  }

  const sourceArchivePath = path.join(memoryDir, "threads", `${thread.threadId}.rollout.jsonl.gz`);
  saveThreadTranscript(memoryDir, thread.threadId, transcript);
  upsertThreadIndexEntry(memoryDir, {
    thread_id: thread.threadId,
    title: thread.title,
    thread_name: thread.sessionIndexEntry?.thread_name || null,
    created_at: thread.createdAt,
    updated_at: thread.updatedAt,
    source_session_relpath: relativeSessionPath(thread.rolloutPath),
    bundle_path: path.join("threads", `${thread.threadId}.json`),
  });
  if (includeRawThreads && fs.existsSync(thread.rolloutPath)) {
    fs.writeFileSync(sourceArchivePath, zlib.gzipSync(fs.readFileSync(thread.rolloutPath)));
  }
  return { transcript, nextParserState, touched: transcript.length > 0 };
}

function loadThreadIndex(memoryDir) {
  const filePath = threadIndexPath(memoryDir);
  if (!fs.existsSync(filePath)) {
    return [];
  }
  const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return Array.isArray(payload) ? payload : [];
}

function saveThreadIndex(memoryDir, payload) {
  const next = [...payload].sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
  fs.writeFileSync(threadIndexPath(memoryDir), JSON.stringify(next, null, 2) + "\n", "utf8");
  return next;
}

function upsertThreadIndexEntry(memoryDir, entry) {
  const payload = loadThreadIndex(memoryDir).filter((item) => item.thread_id !== entry.thread_id);
  payload.push(entry);
  return saveThreadIndex(memoryDir, payload);
}

function buildThreadManifest(repoPath, thread) {
  return {
    schema_version: "1.0",
    thread_id: thread.threadId,
    thread_title: thread.title,
    thread_name: thread.sessionIndexEntry?.thread_name,
    cwd: repoPath,
    original_cwd: thread.cwd,
    rollout_path: thread.rolloutPath,
    source_session_relpath: relativeSessionPath(thread.rolloutPath),
    updated_at: thread.updatedAt,
    created_at: thread.createdAt,
    exported_at: new Date().toISOString(),
    source: thread.row.source,
    model_provider: thread.row.model_provider,
    model: thread.row.model,
    reasoning_effort: thread.row.reasoning_effort,
  };
}

function materializeRootFromThread(memoryDir, threadId) {
  const bundlePath = path.join(memoryDir, "threads", `${threadId}.json`);
  if (!fs.existsSync(bundlePath)) {
    throw new Error(`Missing thread bundle: ${bundlePath}`);
  }
  cleanupRootHistoryArtifacts(memoryDir);
  fs.writeFileSync(currentThreadPath(memoryDir), JSON.stringify({ thread_id: threadId }, null, 2) + "\n", "utf8");
}

function clearMaterializedRoot(memoryDir) {
  cleanupRootHistoryArtifacts(memoryDir);
  const currentPath = currentThreadPath(memoryDir);
  if (fs.existsSync(currentPath)) fs.rmSync(currentPath, { force: true });
}

async function pushMemoryTree(profile, memoryDir, prefix) {
  const uploaded = [];
  const desired = new Map();
  for (const filePath of iterMemoryFiles(memoryDir)) {
    const relPath = path.relative(memoryDir, filePath).split(path.sep).join("/");
    const key = `${prefix.replace(/\/+$/, "")}/${relPath}`;
    desired.set(key, fs.readFileSync(filePath));
  }
  for (const [key, payload] of desired.entries()) {
    await putR2Object(profile, key, payload);
    uploaded.push(key);
  }
  const remoteKeys = new Set((await listR2Objects(profile, prefix.replace(/\/+$/, "") + "/")).map((item) => item.key));
  for (const key of remoteKeys) {
    if (!desired.has(key)) {
      await deleteR2Object(profile, key);
    }
  }
  return uploaded;
}

async function pullMemoryTree(profile, memoryDir, prefix) {
  const downloaded = [];
  const remotePaths = new Set();
  const normalizedPrefix = prefix.replace(/\/+$/, "") + "/";
  for (const item of await listR2Objects(profile, normalizedPrefix)) {
    const key = item.key;
    const relPath = key.slice(normalizedPrefix.length);
    const localPath = path.join(memoryDir, relPath);
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    fs.writeFileSync(localPath, await getR2Object(profile, key));
    downloaded.push(localPath);
    remotePaths.add(path.resolve(localPath));
  }
  pruneRemovedLocalFiles(memoryDir, remotePaths);
  cleanupLegacyThreadArtifacts(memoryDir);
  return downloaded;
}

async function pullRepoMemorySnapshot(repoPath, memoryDir, profile, repoState, { codexHome, thread = null } = {}) {
  const downloaded = await pullMemoryTree(profile, memoryDir, repoState.remote_prefix);
  const pulledRepoState = loadRepoState(memoryDir);
  const localizedRepoState = relocalizeRepoState(repoPath, pulledRepoState, repoState);
  saveRepoState(memoryDir, localizedRepoState);
  let threadId = thread;
  if (!threadId && fs.existsSync(currentThreadPath(memoryDir))) {
    threadId = JSON.parse(fs.readFileSync(currentThreadPath(memoryDir), "utf8")).thread_id || null;
  }
  let imported = null;
  const bundlePath = threadId ? path.join(memoryDir, "threads", `${threadId}.json`) : null;
  if (threadId && bundlePath && fs.existsSync(bundlePath)) {
    imported = importThreadBundleToCodex(repoPath, memoryDir, threadId, { codexHome });
  }
  const syncState = recordSyncEvent(memoryDir, {
    repoPath,
    prefix: localizedRepoState.remote_prefix,
    direction: "pull",
    command: "pull",
    downloadedObjects: downloaded.length,
    importedThread: imported,
  });
  return {
    repo: repoPath,
    repo_slug: localizedRepoState.repo_slug,
    remote_auth_type: localizedRepoState.remote_auth_type || DEFAULT_REMOTE_AUTH_TYPE,
    remote_auth_path: localizedRepoState.remote_auth_path || DEFAULT_REMOTE_AUTH_PATH,
    remote_prefix: localizedRepoState.remote_prefix,
    prefix: localizedRepoState.remote_prefix,
    downloaded_objects: downloaded.length,
    imported_thread: imported,
    sync_state_path: syncStatePath(memoryDir),
    sync_state: syncState,
    sync_health: buildSyncHealth(memoryDir, syncState),
  };
}

function pruneRemovedLocalFiles(memoryDir, remotePaths) {
  for (const filePath of listLocalFiles(memoryDir).sort().reverse()) {
    const resolved = path.resolve(filePath);
    const relPath = path.relative(memoryDir, filePath).split(path.sep).join("/");
    if (!remotePaths.has(resolved) && !shouldPreserveLocalRelpath(relPath)) {
      fs.rmSync(filePath, { force: true });
    }
  }
  removeEmptyDirs(memoryDir);
}

function listLocalFiles(dirPath) {
  const out = [];
  walk(dirPath, out);
  return out;
}

function removeEmptyDirs(rootDir) {
  const dirs = [];
  walkDirs(rootDir, dirs);
  dirs.sort((a, b) => b.length - a.length);
  for (const dirPath of dirs) {
    try {
      if (dirPath !== rootDir) {
        fs.rmdirSync(dirPath);
      }
    } catch {
      // Ignore non-empty directories.
    }
  }
}

function walkDirs(dirPath, dirs) {
  if (!fs.existsSync(dirPath)) return;
  dirs.push(dirPath);
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      walkDirs(path.join(dirPath, entry.name), dirs);
    }
  }
}

function importThreadBundleToCodex(repoPath, memoryDir, threadId, { codexHome } = {}) {
  const bundlePath = path.join(memoryDir, "threads", `${threadId}.json`);
  const transcript = JSON.parse(fs.readFileSync(bundlePath, "utf8"));
  const indexEntry = loadThreadIndex(memoryDir).find((item) => item.thread_id === threadId);
  const paths = codexPaths(codexHome);

  let rolloutPath = path.join(paths.sessionsRoot, "missing-rollout.jsonl");
  const rolloutArchive = fs.existsSync(path.join(memoryDir, "threads", `${threadId}.rollout.jsonl.gz`))
    ? path.join(memoryDir, "threads", `${threadId}.rollout.jsonl.gz`)
    : null;
  if (rolloutArchive && fs.existsSync(rolloutArchive)) {
    rolloutPath = path.join(paths.codexHome, indexEntry?.source_session_relpath || `sessions/missing-${threadId}.jsonl`);
    fs.mkdirSync(path.dirname(rolloutPath), { recursive: true });
    fs.writeFileSync(rolloutPath, zlib.gunzipSync(fs.readFileSync(rolloutArchive)));
  }

  const sessionIndexEntry = {
    id: threadId,
    thread_name: indexEntry?.thread_name || indexEntry?.title || threadId,
    updated_at: new Date(((indexEntry?.updated_at || Math.floor(Date.now() / 1000)) * 1000)).toISOString(),
  };
  upsertSessionIndex(paths.sessionIndexPath, sessionIndexEntry);

  const firstUserMessage = Array.isArray(transcript)
    ? (transcript.find((item) => item.role === "user")?.message || "")
    : "";
  const threadRow = {
    id: threadId,
    rollout_path: dbRolloutPath(rolloutPath),
    created_at: Number(indexEntry?.created_at || Math.floor(Date.now() / 1000)),
    updated_at: Number(indexEntry?.updated_at || Math.floor(Date.now() / 1000)),
    source: "vscode",
    model_provider: "openai",
    cwd: dbCwd(repoPath),
    title: indexEntry?.title || indexEntry?.thread_name || threadId,
    sandbox_policy: JSON.stringify({ type: "danger-full-access" }),
    approval_mode: "never",
    tokens_used: 0,
    has_user_event: 0,
    archived: 0,
    archived_at: null,
    git_sha: null,
    git_branch: null,
    git_origin_url: repoGitOriginUrl(repoPath),
    cli_version: "",
    first_user_message: firstUserMessage,
    agent_nickname: null,
    agent_role: null,
    memory_mode: "enabled",
    model: "gpt-5.4",
    reasoning_effort: "xhigh",
    agent_path: null,
  };
  const targetOrigin = normalizeGitOriginUrl(repoGitOriginUrl(repoPath));
  const sourceOrigin = normalizeGitOriginUrl(String(threadRow.git_origin_url || ""));
  if (targetOrigin && sourceOrigin && targetOrigin !== sourceOrigin) {
    throw new Error(`Thread ${threadId} belongs to ${threadRow.git_origin_url} and cannot be imported into ${repoPath}.`);
  }
  upsertThreadRow(paths.stateDbPath, threadRow);
  materializeRootFromThread(memoryDir, threadId);
  return {
    thread_id: threadId,
    rollout_path: rolloutPath,
    cwd: repoPath,
  };
}

async function syncNow(repoPath, memoryDir, profile, { codexHome, includeRawThreads = false, prefix }) {
  ensureMemoryLayout(memoryDir);
  cleanupLegacyThreadArtifacts(memoryDir);
  cleanupRootHistoryArtifacts(memoryDir);
  const indexPayload = loadThreadIndex(memoryDir);
  const currentThread = currentThreadId(memoryDir) || null;
  const uploaded = await pushMemoryTree(profile, memoryDir, prefix);
  const threadIds = indexPayload.map((item) => item.thread_id).filter(Boolean);
  const syncState = recordSyncEvent(memoryDir, {
    repoPath,
    prefix,
    direction: "push",
    command: "now",
    threadIds,
    currentThread,
    threadsExported: 0,
    objectsUploaded: uploaded.length,
  });
  const repoState = loadRepoState(memoryDir);
  return {
    repo: repoPath,
    repo_slug: repoState.repo_slug,
    remote_auth_type: repoState.remote_auth_type || DEFAULT_REMOTE_AUTH_TYPE,
    remote_auth_path: repoState.remote_auth_path || DEFAULT_REMOTE_AUTH_PATH,
    remote_prefix: prefix,
    prefix,
    threads_exported: 0,
    thread_count: threadIds.length,
    thread_ids: threadIds,
    current_thread: currentThread,
    objects_uploaded: uploaded.length,
    sync_state_path: syncStatePath(memoryDir),
    sync_state: syncState,
    sync_health: buildSyncHealth(memoryDir, syncState),
  };
}

async function syncChangedThreads(repoPath, memoryDir, profile, { codexHome, includeRawThreads = false, prefix, changes = [], discoverThreads = discoverThreadsForRepo } = {}) {
  const repoState = loadRepoState(memoryDir);
  const threadUpdate = applyChangedThreadsLocally(repoPath, memoryDir, {
    codexHome,
    includeRawThreads,
    changes,
    discoverThreads,
  });
  if (!profile) {
    return buildChangedThreadSyncResult(repoPath, memoryDir, repoState, prefix, threadUpdate, {
      objectsUploaded: 0,
      remotePushAttempted: false,
      remotePushSucceeded: false,
      remoteError: null,
    });
  }

  try {
    const uploaded = await pushMemoryTree(profile, memoryDir, prefix);
    const syncState = recordSyncEvent(memoryDir, {
      repoPath,
      prefix,
      direction: "push",
      command: "watch",
      threadIds: threadUpdate.thread_ids,
      currentThread: threadUpdate.current_thread,
      threadsExported: threadUpdate.threads_exported,
      objectsUploaded: uploaded.length,
    });
    return buildChangedThreadSyncResult(repoPath, memoryDir, loadRepoState(memoryDir), prefix, threadUpdate, {
      objectsUploaded: uploaded.length,
      remotePushAttempted: true,
      remotePushSucceeded: true,
      remoteError: null,
      syncState,
    });
  } catch (error) {
    return buildChangedThreadSyncResult(repoPath, memoryDir, loadRepoState(memoryDir), prefix, threadUpdate, {
      objectsUploaded: 0,
      remotePushAttempted: true,
      remotePushSucceeded: false,
      remoteError: error.message,
    });
  }
}

function applyChangedThreadsLocally(repoPath, memoryDir, { codexHome, includeRawThreads = false, changes = [], discoverThreads = discoverThreadsForRepo } = {}) {
  ensureMemoryLayout(memoryDir);
  cleanupLegacyThreadArtifacts(memoryDir);
  cleanupRootHistoryArtifacts(memoryDir);
  const repoState = loadRepoState(memoryDir);
  const paths = codexPaths(codexHome);
  const sessionIndexMap = readSessionIndexMap(paths.sessionIndexPath);
  const touchedThreadIds = [];
  const threadMap = new Map(
    discoverThreads(repoPath, codexHome, repoState).map((thread) => [thread.threadId, thread]),
  );

  for (const change of changes) {
    if (!change?.threadId) continue;
    let thread = threadMap.get(change.threadId) || null;
    if (!thread) {
      thread = synthesizeThreadFromChange(repoPath, change, sessionIndexMap);
      if (thread) {
        threadMap.set(thread.threadId, thread);
      }
    }
    if (!thread) continue;
    const result = updateThreadBundleFromRolloutChange(repoPath, memoryDir, thread, {
      newLines: change.newLines,
      parserState: change.parserState,
      includeRawThreads,
    });
    if (result.touched) {
      touchedThreadIds.push(thread.threadId);
    }
  }

  const indexPayload = loadThreadIndex(memoryDir);
  const currentThread = touchedThreadIds[touchedThreadIds.length - 1] || currentThreadId(memoryDir) || null;
  if (currentThread) {
    fs.writeFileSync(currentThreadPath(memoryDir), JSON.stringify({ thread_id: currentThread }, null, 2) + "\n", "utf8");
  }

  const threadIds = indexPayload.map((item) => item.thread_id).filter(Boolean);
  return {
    threads_exported: touchedThreadIds.length,
    thread_count: threadIds.length,
    thread_ids: threadIds,
    current_thread: currentThread,
  };
}

function synthesizeThreadFromChange(repoPath, change, sessionIndexMap) {
  const threadId = typeof change?.threadId === "string" ? change.threadId : null;
  const rolloutPath = typeof change?.rolloutPath === "string" ? change.rolloutPath : null;
  if (!threadId || !rolloutPath) {
    return null;
  }
  const sessionIndexEntry = sessionIndexMap.get(threadId) || null;
  const stat = fs.existsSync(rolloutPath) ? fs.statSync(rolloutPath) : null;
  const updatedAt = stat
    ? Math.floor(stat.mtimeMs / 1000)
    : parseSessionIndexUpdatedAt(sessionIndexEntry?.updated_at) || Math.floor(Date.now() / 1000);
  const createdAt = stat
    ? Math.floor((stat.birthtimeMs || stat.mtimeMs) / 1000)
    : updatedAt;
  const cwd = typeof change?.cwd === "string" && change.cwd.trim() ? change.cwd : repoPath;
  const title = sessionIndexEntry?.thread_name || threadId;
  return {
    threadId,
    title,
    cwd,
    rolloutPath,
    createdAt,
    updatedAt,
    row: {
      id: threadId,
      source: "vscode",
      model_provider: "openai",
      cwd,
      rollout_path: rolloutPath,
      title,
    },
    sessionIndexEntry,
  };
}

function parseSessionIndexUpdatedAt(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

function buildChangedThreadSyncResult(repoPath, memoryDir, repoState, prefix, localResult, {
  objectsUploaded,
  remotePushAttempted,
  remotePushSucceeded,
  remoteError,
  syncState = null,
}) {
  const state = syncState || loadSyncState(memoryDir);
  return {
    repo: repoPath,
    repo_slug: repoState.repo_slug,
    remote_auth_type: repoState.remote_auth_type || DEFAULT_REMOTE_AUTH_TYPE,
    remote_auth_path: repoState.remote_auth_path || DEFAULT_REMOTE_AUTH_PATH,
    remote_prefix: prefix,
    prefix,
    threads_exported: localResult.threads_exported,
    thread_count: localResult.thread_count,
    thread_ids: localResult.thread_ids,
    current_thread: localResult.current_thread,
    objects_uploaded: objectsUploaded,
    remote_push_attempted: remotePushAttempted,
    remote_push_succeeded: remotePushSucceeded,
    remote_error: remoteError,
    sync_state_path: syncStatePath(memoryDir),
    sync_state: Object.keys(state).length ? state : null,
    sync_health: buildSyncHealth(memoryDir, syncState || null),
  };
}

function describeSyncState(memoryDir) {
  const syncState = loadSyncState(memoryDir);
  return {
    sync_state_path: syncStatePath(memoryDir),
    sync_state: Object.keys(syncState).length ? syncState : null,
    sync_health: buildSyncHealth(memoryDir, syncState),
  };
}

function iterMemoryFiles(memoryDir) {
  const threadIds = indexedThreadIds(memoryDir);
  const currentThread = currentThreadId(memoryDir);
  const results = [];
  walk(memoryDir, results);
  return results.filter((filePath) => {
    const relPath = path.relative(memoryDir, filePath).split(path.sep).join("/");
    return shouldSyncRelpath(relPath, threadIds, currentThread);
  }).sort();
}

function walk(dirPath, files) {
  if (!fs.existsSync(dirPath)) return;
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) walk(fullPath, files);
    else if (entry.isFile()) files.push(fullPath);
  }
}

function indexedThreadIds(memoryDir) {
  const filePath = threadIndexPath(memoryDir);
  if (!fs.existsSync(filePath)) return [];
  const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return Array.isArray(payload) ? payload.map((item) => item.thread_id).filter(Boolean).sort() : [];
}

function currentThreadId(memoryDir) {
  const filePath = currentThreadPath(memoryDir);
  if (!fs.existsSync(filePath)) return null;
  const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return typeof payload.thread_id === "string" ? payload.thread_id : null;
}

function materializedRootStatus(memoryDir) {
  const currentPath = currentThreadPath(memoryDir);
  const indexPath = threadIndexPath(memoryDir);
  return {
    current_thread_present: fs.existsSync(currentPath),
    thread_index_present: fs.existsSync(indexPath),
    memory_present: fs.existsSync(path.join(memoryDir, "memory.md")),
  };
}

function buildSyncHealth(memoryDir, syncState = null) {
  const state = syncState || loadSyncState(memoryDir);
  const threadIds = indexedThreadIds(memoryDir);
  const currentThread = currentThreadId(memoryDir);
  const rootStatus = materializedRootStatus(memoryDir);
  let status = "never_synced";
  if (state.last_sync_at) {
    status = "ok";
    if (threadIds.length && !currentThread) status = "current_thread_missing";
    else if (currentThread && !threadIds.includes(currentThread)) status = "current_thread_missing";
    else if (currentThread && (!rootStatus.current_thread_present || !rootStatus.thread_index_present)) status = "materialized_root_incomplete";
  }
  return {
    status,
    last_sync_at: state.last_sync_at || null,
    last_sync_direction: state.last_sync_direction || null,
    last_sync_command: state.last_sync_command || null,
    current_thread: currentThread,
    thread_count: threadIds.length,
    thread_ids: threadIds,
    materialized_root: rootStatus,
  };
}

function recordSyncEvent(memoryDir, { repoPath, prefix, direction, command, threadIds = null, currentThread = null, threadsExported = null, objectsUploaded = null, downloadedObjects = null, importedThread = null }) {
  const existing = loadSyncState(memoryDir);
  const repoState = loadRepoState(memoryDir);
  const now = new Date().toISOString();
  const normalizedThreadIds = threadIds ? [...threadIds].sort() : indexedThreadIds(memoryDir);
  const resolvedCurrentThread = currentThread !== null ? currentThread : currentThreadId(memoryDir);
  const rootStatus = materializedRootStatus(memoryDir);
  const event = {
    at: now,
    command,
    current_thread: resolvedCurrentThread,
    thread_count: normalizedThreadIds.length,
    thread_ids: normalizedThreadIds,
  };
  if (threadsExported !== null) event.threads_exported = threadsExported;
  if (objectsUploaded !== null) event.objects_uploaded = objectsUploaded;
  if (downloadedObjects !== null) event.downloaded_objects = downloadedObjects;
  if (importedThread !== null) event.imported_thread = importedThread;

  const payload = {
    schema_version: "1.0",
    repo: repoPath || repoState.repo_path || "",
    repo_slug: repoState.repo_slug || existing.repo_slug || null,
    remote_auth_type: repoState.remote_auth_type || existing.remote_auth_type || DEFAULT_REMOTE_AUTH_TYPE,
    remote_auth_path: repoState.remote_auth_path || existing.remote_auth_path || DEFAULT_REMOTE_AUTH_PATH,
    remote_prefix: prefix || existing.remote_prefix || null,
    last_sync_at: now,
    last_sync_direction: direction,
    last_sync_command: command,
    current_thread: resolvedCurrentThread,
    thread_count: normalizedThreadIds.length,
    thread_ids: normalizedThreadIds,
    materialized_root: rootStatus,
    last_push: existing.last_push || null,
    last_pull: existing.last_pull || null,
  };
  if (direction === "push") payload.last_push = event;
  if (direction === "pull") payload.last_pull = event;
  saveSyncState(memoryDir, payload);
  return payload;
}

function shouldSyncRelpath(relPath, threadIds, currentThreadIdValue) {
  if (relPath === "repo.json") return true;
  if (relPath === "thread-index.json") return true;
  if (relPath === "memory.md") return true;
  if (relPath === "memory-state.json") return true;
  if (relPath === "current-thread.json") return currentThreadIdValue && threadIds.includes(currentThreadIdValue);
  const parts = relPath.split("/");
  if (parts.length === 2 && parts[0] === "threads") {
    return threadIds.some((threadId) => parts[1] === `${threadId}.json` || parts[1] === `${threadId}.rollout.jsonl.gz`);
  }
  return false;
}

function shouldPreserveLocalRelpath(relPath) {
  return relPath === "sync-state.json" || relPath.startsWith("conflicts/");
}

function relativeSessionPath(filePath) {
  const parts = filePath.split(path.sep);
  const index = parts.indexOf("sessions");
  return index >= 0 ? parts.slice(index).join("/") : path.basename(filePath);
}

function cleanupLegacyThreadArtifacts(memoryDir) {
  const threadsDir = path.join(memoryDir, "threads");
  if (!fs.existsSync(threadsDir)) {
    return;
  }
  for (const entry of fs.readdirSync(threadsDir, { withFileTypes: true })) {
    const fullPath = path.join(threadsDir, entry.name);
    if (entry.isDirectory()) {
      fs.rmSync(fullPath, { recursive: true, force: true });
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    if (entry.name.endsWith(".json") || entry.name.endsWith(".rollout.jsonl.gz")) {
      continue;
    }
    fs.rmSync(fullPath, { force: true });
  }
  const legacyRawDir = path.join(memoryDir, "raw");
  if (fs.existsSync(legacyRawDir)) {
    fs.rmSync(legacyRawDir, { recursive: true, force: true });
  }
}

function cleanupRootHistoryArtifacts(memoryDir) {
  const roots = materializedRootPaths(memoryDir);
  for (const filePath of [roots.latest, roots.handoff, roots.transcript]) {
    if (fs.existsSync(filePath)) {
      fs.rmSync(filePath, { force: true });
    }
  }
  const legacyRawDir = path.join(memoryDir, "raw");
  if (fs.existsSync(legacyRawDir)) {
    fs.rmSync(legacyRawDir, { recursive: true, force: true });
  }
}

module.exports = {
  applyChangedThreadsLocally,
  cleanupThread,
  describeSyncState,
  exportRepoThreads,
  importThreadBundleToCodex,
  pullRepoMemorySnapshot,
  pullMemoryTree,
  pushMemoryTree,
  recordSyncEvent,
  updateThreadBundleFromRolloutChange,
  syncChangedThreads,
  syncNow,
  _test: {
    shouldSyncRelpath,
  },
};
