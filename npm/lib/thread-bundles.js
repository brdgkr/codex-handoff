const fs = require("node:fs");
const path = require("node:path");

const { writeUtf8FileIfChanged } = require("./file-ops");

const THREADS_DIRNAME = "threads";
const CANONICAL_THREAD_BUNDLE_EXTENSION = ".jsonl";
const LEGACY_THREAD_BUNDLE_EXTENSION = ".json";

function canonicalThreadBundleRelPath(threadId) {
  return path.posix.join(THREADS_DIRNAME, `${threadId}${CANONICAL_THREAD_BUNDLE_EXTENSION}`);
}

function legacyThreadBundleRelPath(threadId) {
  return path.posix.join(THREADS_DIRNAME, `${threadId}${LEGACY_THREAD_BUNDLE_EXTENSION}`);
}

function canonicalThreadBundlePath(memoryDir, threadId) {
  return path.join(memoryDir, THREADS_DIRNAME, `${threadId}${CANONICAL_THREAD_BUNDLE_EXTENSION}`);
}

function legacyThreadBundlePath(memoryDir, threadId) {
  return path.join(memoryDir, THREADS_DIRNAME, `${threadId}${LEGACY_THREAD_BUNDLE_EXTENSION}`);
}

function resolveThreadBundlePath(memoryDir, threadId, preferredRelPath = null) {
  const candidates = [];
  if (preferredRelPath) {
    candidates.push(path.join(memoryDir, preferredRelPath.split("/").join(path.sep)));
  }
  candidates.push(
    canonicalThreadBundlePath(memoryDir, threadId),
    legacyThreadBundlePath(memoryDir, threadId),
  );
  const unique = [...new Set(candidates.map((value) => path.resolve(value)))];
  for (const candidate of unique) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return canonicalThreadBundlePath(memoryDir, threadId);
}

function resolveThreadBundleRelPath(memoryDir, threadId, preferredRelPath = null) {
  return path.relative(memoryDir, resolveThreadBundlePath(memoryDir, threadId, preferredRelPath)).split(path.sep).join("/");
}

function listThreadBundleFiles(memoryDir) {
  const threadsDir = path.join(memoryDir, THREADS_DIRNAME);
  if (!fs.existsSync(threadsDir)) {
    return [];
  }
  const files = new Map();
  for (const entry of fs.readdirSync(threadsDir, { withFileTypes: true })) {
    if (!entry.isFile()) {
      continue;
    }
    const ext = path.extname(entry.name);
    if (ext !== CANONICAL_THREAD_BUNDLE_EXTENSION && ext !== LEGACY_THREAD_BUNDLE_EXTENSION) {
      continue;
    }
    const threadId = entry.name.slice(0, -ext.length);
    const filePath = path.join(threadsDir, entry.name);
    const existing = files.get(threadId);
    if (!existing || ext === CANONICAL_THREAD_BUNDLE_EXTENSION) {
      files.set(threadId, filePath);
    }
  }
  return [...files.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([, filePath]) => filePath);
}

function loadThreadTranscript(memoryDir, threadId, preferredRelPath = null) {
  const filePath = resolveThreadBundlePath(memoryDir, threadId, preferredRelPath);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return readTranscriptFile(filePath);
}

function readTranscriptFile(filePath) {
  if (path.extname(filePath) === CANONICAL_THREAD_BUNDLE_EXTENSION) {
    const rows = [];
    for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      rows.push(JSON.parse(line));
    }
    return rows;
  }
  const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return Array.isArray(payload) ? payload : [];
}

function writeThreadTranscript(memoryDir, threadId, transcript) {
  const filePath = canonicalThreadBundlePath(memoryDir, threadId);
  const relPath = canonicalThreadBundleRelPath(threadId);
  const changed = writeUtf8FileIfChanged(filePath, serializeTranscript(transcript));
  const removedPaths = removeLegacyThreadBundle(memoryDir, threadId, filePath);
  return {
    filePath,
    relPath,
    changed,
    removedPaths,
  };
}

function appendThreadTranscript(memoryDir, threadId, messages, { existingTranscript = null } = {}) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return {
      filePath: resolveThreadBundlePath(memoryDir, threadId),
      relPath: resolveThreadBundleRelPath(memoryDir, threadId),
      changed: false,
      removedPaths: [],
      mode: "unchanged",
    };
  }
  const canonicalPath = canonicalThreadBundlePath(memoryDir, threadId);
  if (fs.existsSync(canonicalPath)) {
    fs.appendFileSync(canonicalPath, serializeTranscript(messages), "utf8");
    return {
      filePath: canonicalPath,
      relPath: canonicalThreadBundleRelPath(threadId),
      changed: true,
      removedPaths: [],
      mode: "append",
    };
  }
  const baseTranscript = Array.isArray(existingTranscript)
    ? existingTranscript
    : (loadThreadTranscript(memoryDir, threadId) || []);
  const result = writeThreadTranscript(memoryDir, threadId, [...baseTranscript, ...messages]);
  return {
    ...result,
    mode: baseTranscript.length ? "migrate" : "create",
  };
}

function transcriptMessageKey(item) {
  return JSON.stringify([
    item.turn_id || "",
    item.role || "",
    item.phase || "",
    String(item.message || "").replace(/\s+/g, " "),
  ]);
}

function serializeTranscript(transcript) {
  if (!Array.isArray(transcript) || transcript.length === 0) {
    return "";
  }
  return transcript.map((item) => `${JSON.stringify(item)}\n`).join("");
}

function removeLegacyThreadBundle(memoryDir, threadId, currentPath) {
  const removedPaths = [];
  const legacyPath = legacyThreadBundlePath(memoryDir, threadId);
  if (path.resolve(legacyPath) !== path.resolve(currentPath) && fs.existsSync(legacyPath)) {
    fs.rmSync(legacyPath, { force: true });
    removedPaths.push(legacyThreadBundleRelPath(threadId));
  }
  return removedPaths;
}

module.exports = {
  CANONICAL_THREAD_BUNDLE_EXTENSION,
  LEGACY_THREAD_BUNDLE_EXTENSION,
  appendThreadTranscript,
  canonicalThreadBundlePath,
  canonicalThreadBundleRelPath,
  listThreadBundleFiles,
  loadThreadTranscript,
  readTranscriptFile,
  resolveThreadBundlePath,
  resolveThreadBundleRelPath,
  transcriptMessageKey,
  writeThreadTranscript,
};
