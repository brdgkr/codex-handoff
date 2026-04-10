const path = require("node:path");

const { findThreadById, findThreadByRolloutPath } = require("../lib/local-codex");

function resolveObservedThread({ codexHome, rolloutPath, meta = null, previousCursor = null, parserState = null }) {
  if (normalizeNonEmptyString(meta?.threadId) && normalizeNonEmptyString(meta?.cwd)) {
    return {
      threadId: normalizeNonEmptyString(meta.threadId),
      cwd: normalizeNonEmptyString(meta.cwd),
      title: firstNonEmpty(meta?.title),
      source: "rollout_meta",
    };
  }

  const rolloutLookup = rolloutPath ? findThreadByRolloutPath(codexHome, rolloutPath) : null;
  const threadIdHints = [
    meta?.threadId,
    parserState?.sessionId,
    previousCursor?.sessionId,
    inferThreadIdFromRolloutPath(rolloutPath),
  ].filter((value, index, array) => {
    const normalized = normalizeNonEmptyString(value);
    return normalized && array.findIndex((candidate) => normalizeNonEmptyString(candidate) === normalized) === index;
  });

  let threadLookup = null;
  if (!rolloutLookup || !rolloutLookup.cwd || !rolloutLookup.threadId) {
    for (const threadId of threadIdHints) {
      threadLookup = findThreadById(codexHome, threadId);
      if (threadLookup) {
        break;
      }
    }
  }

  return {
    threadId: firstNonEmpty(
      meta?.threadId,
      rolloutLookup?.threadId,
      threadLookup?.threadId,
      parserState?.sessionId,
      previousCursor?.sessionId,
      inferThreadIdFromRolloutPath(rolloutPath),
    ),
    cwd: firstNonEmpty(meta?.cwd, rolloutLookup?.cwd, threadLookup?.cwd),
    title: firstNonEmpty(meta?.title, rolloutLookup?.title, threadLookup?.title),
    source: meta?.cwd || meta?.threadId
      ? "rollout_meta"
      : rolloutLookup
        ? "sqlite_rollout_path"
        : threadLookup
          ? "sqlite_thread_id"
          : inferThreadIdFromRolloutPath(rolloutPath)
            ? "rollout_filename"
            : "unknown",
  };
}

function inferThreadIdFromRolloutPath(filePath) {
  const baseName = path.basename(String(filePath || ""));
  const match = baseName.match(/^rollout-(?:.*-)?\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl$/);
  return match ? normalizeNonEmptyString(match[1]) : null;
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const normalized = normalizeNonEmptyString(value);
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

function normalizeNonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

module.exports = {
  inferThreadIdFromRolloutPath,
  resolveObservedThread,
};
