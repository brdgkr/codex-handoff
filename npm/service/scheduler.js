class RepoSyncScheduler {
  constructor({ debounceMs, runSync, logger }) {
    this.debounceMs = debounceMs;
    this.runSync = runSync;
    this.logger = logger;
    this.entries = new Map();
  }

  enqueue(repo, payload = null) {
    const key = repo.normalizedPath;
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        repo,
        timer: null,
        running: false,
        dirty: false,
        pending: null,
      };
      this.entries.set(key, entry);
    } else {
      entry.repo = repo;
    }

    entry.pending = mergePayload(entry.pending, payload);

    if (entry.running) {
      entry.dirty = true;
      return;
    }

    if (entry.timer) {
      clearTimeout(entry.timer);
    }
    entry.timer = setTimeout(() => {
      entry.timer = null;
      void this.#runEntry(entry);
    }, this.debounceMs);
  }

  snapshot() {
    return Array.from(this.entries.values()).map((entry) => ({
      repoPath: entry.repo.repoPath,
      repoSlug: entry.repo.repoSlug,
      running: entry.running,
      dirty: entry.dirty,
      waiting: Boolean(entry.timer),
      pendingChanges: Array.isArray(entry.pending?.changes) ? entry.pending.changes.length : 0,
    }));
  }

  async dispose() {
    for (const entry of this.entries.values()) {
      if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = null;
      }
    }
    this.entries.clear();
  }

  async #runEntry(entry) {
    if (entry.running) {
      entry.dirty = true;
      return;
    }
    entry.running = true;
    entry.dirty = false;
    const pending = entry.pending;
    entry.pending = null;
    try {
      this.logger?.(`sync start ${entry.repo.repoPath}`);
      await this.runSync(entry.repo, pending);
      this.logger?.(`sync finish ${entry.repo.repoPath}`);
    } catch (error) {
      this.logger?.(`sync error ${entry.repo.repoPath}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      entry.running = false;
      if (entry.dirty) {
        entry.dirty = false;
        if (entry.timer) {
          clearTimeout(entry.timer);
        }
        entry.timer = setTimeout(() => {
          entry.timer = null;
          void this.#runEntry(entry);
        }, this.debounceMs);
      }
    }
  }
}

module.exports = {
  RepoSyncScheduler,
};

function mergePayload(existing, incoming) {
  if (!existing) return clonePayload(incoming);
  if (!incoming) return existing;
  const next = {
    changes: [...(existing.changes || [])],
    localResult: mergeLocalResult(existing.localResult, incoming.localResult),
    sourceDir: incoming.sourceDir || existing.sourceDir || null,
  };
  for (const change of incoming.changes || []) {
    next.changes.push(change);
  }
  return next;
}

function clonePayload(payload) {
  if (!payload) return null;
  return {
    changes: [...(payload.changes || [])],
    localResult: cloneLocalResult(payload.localResult),
    sourceDir: payload.sourceDir || null,
  };
}

function mergeLocalResult(existing, incoming) {
  if (!existing) return cloneLocalResult(incoming);
  if (!incoming) return existing;
  const touchedThreadIds = [...new Set([...(existing.touched_thread_ids || []), ...(incoming.touched_thread_ids || [])])];
  const newThreads = dedupeNewThreads([...(existing.new_threads || []), ...(incoming.new_threads || [])]);
  return {
    threads_exported: touchedThreadIds.length || Number(existing.threads_exported || 0) + Number(incoming.threads_exported || 0),
    touched_thread_ids: touchedThreadIds,
    thread_count: Number(incoming.thread_count || existing.thread_count || 0),
    thread_ids: [...new Set([...(existing.thread_ids || []), ...(incoming.thread_ids || [])])],
    current_thread: incoming.current_thread || existing.current_thread || null,
    new_threads: newThreads,
    new_thread_count: newThreads.length,
    changed_paths: [...new Set([...(existing.changed_paths || []), ...(incoming.changed_paths || [])])],
  };
}

function cloneLocalResult(localResult) {
  if (!localResult) return null;
  return {
    threads_exported: Number(localResult.threads_exported || 0),
    touched_thread_ids: [...(localResult.touched_thread_ids || [])],
    thread_count: Number(localResult.thread_count || 0),
    thread_ids: [...(localResult.thread_ids || [])],
    current_thread: localResult.current_thread || null,
    new_threads: [...(localResult.new_threads || [])],
    new_thread_count: Number(localResult.new_thread_count || 0),
    changed_paths: [...(localResult.changed_paths || [])],
  };
}

function dedupeNewThreads(threads) {
  const byId = new Map();
  for (const thread of threads) {
    if (!thread?.thread_id) continue;
    byId.set(thread.thread_id, thread);
  }
  return [...byId.values()];
}
