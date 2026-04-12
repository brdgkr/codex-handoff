const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { loadThreadTranscript, resolveThreadBundlePath, resolveThreadBundleRelPath } = require("./thread-bundles");
const { syncedThreadsDir, loadRepoState } = require("./workspace");

const DEFAULT_MAX_THREAD_BYTES = 32768;
const DEFAULT_MAX_DIGEST_THREADS = 100;
const DEFAULT_INITIAL_UPDATE_THREADS = 3;
const APPEND_MEMORY_SCHEMA_VERSION = "2.0";

function memoryPath(memoryDir) {
  return path.join(memoryDir, "memory.md");
}

function memoryStatePath(memoryDir) {
  return path.join(memoryDir, "memory-state.json");
}

function summarizeMemoryWithCodex(repoPath, memoryDir, options = {}) {
  const normalized = normalizeOptions(options);
  const resolvedRepoPath = path.resolve(repoPath);
  const resolvedMemoryDir = path.resolve(memoryDir);
  const resolvedInputMemoryDir = path.resolve(normalized.inputMemoryDir || syncedThreadsDir(resolvedMemoryDir));
  const existingMemoryPath = memoryPath(resolvedMemoryDir);
  const statePath = memoryStatePath(resolvedMemoryDir);
  const existingMemory = fs.existsSync(existingMemoryPath) ? fs.readFileSync(existingMemoryPath, "utf8") : "";
  const existingState = readJson(statePath, {});
  const appendState = normalizeAppendState(existingState);
  const threadIndex = loadThreadIndexEntries(resolvedInputMemoryDir);
  let changedEntries = selectChangedThreadEntries(threadIndex, appendState, normalized, {
    allowInitialEntries: !existingMemory.trim(),
  });
  const needsBaseSummary = !existingMemory.trim();
  const needsLegacyTrackingInit = existingMemory.trim() && !appendState.append_mode_enabled;
  const needsLegacyLayoutMigration = existingMemory.trim() && !looksLikeAppendMemoryDocument(existingMemory);
  if (needsLegacyTrackingInit && !normalized.force) {
    changedEntries = [];
  }

  if (!needsBaseSummary && !needsLegacyTrackingInit && !needsLegacyLayoutMigration && changedEntries.length === 0 && !normalized.force) {
    return {
      memory_path: existingMemoryPath,
      memory_state_path: statePath,
      dry_run: normalized.dryRun,
      wrote_memory: false,
      appended_update: false,
      initialized_tracking: false,
      summary: existingMemory,
      state: appendState,
      temp_dir: null,
    };
  }

  const codexBin = resolveCodexBin(normalized.codexBin);
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-handoff-memory-"));
  const usedTempDirs = [];

  try {
    let repoSummary = null;
    let repoSummaryManifest = null;
    if (needsBaseSummary) {
      const repoSummaryTask = runCodexMarkdownTask({
        codexBin,
        keepTemp: normalized.keepTemp,
        maxBuffer: normalized.maxBuffer,
        maxWords: normalized.repoSummaryMaxWords,
        model: normalized.model,
        prepareInputs: (inputDir) => prepareMemoryInputs(resolvedRepoPath, resolvedMemoryDir, resolvedInputMemoryDir, inputDir, normalized),
        promptBuilder: ({ inputDir, manifestPath }) => buildRepoSummaryPrompt({
          goal: normalized.goal,
          inputDir,
          manifestPath,
          maxWords: normalized.repoSummaryMaxWords,
        }),
        reasoningEffort: normalized.reasoningEffort,
        timeoutMs: normalized.timeoutMs,
        tmpRoot: path.join(workRoot, "repo-summary"),
      });
      repoSummary = repoSummaryTask.output.trim();
      repoSummaryManifest = repoSummaryTask.manifest;
      if (repoSummaryTask.temp_dir) {
        usedTempDirs.push(repoSummaryTask.temp_dir);
      }
    }

    let appendedUpdate = null;
    let updateManifest = null;
    if (changedEntries.length > 0) {
      const updateTask = runCodexMarkdownTask({
        codexBin,
        keepTemp: normalized.keepTemp,
        maxBuffer: normalized.maxBuffer,
        maxWords: normalized.updateMaxWords,
        model: normalized.model,
        prepareInputs: (inputDir) => prepareConversationUpdateInputs(resolvedRepoPath, resolvedMemoryDir, resolvedInputMemoryDir, inputDir, changedEntries, normalized),
        promptBuilder: ({ inputDir, manifestPath }) => buildConversationUpdatePrompt({
          goal: normalized.goal,
          inputDir,
          manifestPath,
          maxWords: normalized.updateMaxWords,
        }),
        reasoningEffort: normalized.reasoningEffort,
        timeoutMs: normalized.timeoutMs,
        tmpRoot: path.join(workRoot, "conversation-update"),
      });
      appendedUpdate = renderConversationUpdateBlock(updateTask.output, changedEntries);
      updateManifest = updateTask.manifest;
      if (updateTask.temp_dir) {
        usedTempDirs.push(updateTask.temp_dir);
      }
    }

    const nextState = buildNextMemoryState({
      appendState,
      changedEntries,
      trackedEntries: needsLegacyTrackingInit ? threadIndex : changedEntries,
      dryRun: normalized.dryRun,
      inputMemoryDir: resolvedInputMemoryDir,
      normalized,
      repoSummaryGenerated: needsBaseSummary,
      repoSummaryManifest,
      updateManifest,
      codexBin,
    });

    const nextMemory = needsBaseSummary
      ? renderInitialMemoryDocument(repoSummary || "", appendedUpdate)
      : (needsLegacyTrackingInit || needsLegacyLayoutMigration)
        ? renderInitialMemoryDocument(
            extractLegacyRepoSummary(existingMemory),
            mergeConversationUpdates(extractExistingConversationUpdates(existingMemory), appendedUpdate),
          )
        : appendConversationUpdateToMemory(existingMemory, appendedUpdate, {
            ensureUpdatesHeader: changedEntries.length > 0,
          });

    if (!normalized.dryRun) {
      if (needsBaseSummary || needsLegacyTrackingInit || needsLegacyLayoutMigration || appendedUpdate) {
        if (needsBaseSummary || needsLegacyTrackingInit || needsLegacyLayoutMigration) {
          atomicWriteFile(existingMemoryPath, nextMemory);
        } else {
          fs.appendFileSync(existingMemoryPath, extractAppendedPortion(existingMemory, nextMemory), "utf8");
        }
      }
      atomicWriteJson(statePath, nextState);
    }

    return {
      memory_path: existingMemoryPath,
      memory_state_path: statePath,
      dry_run: normalized.dryRun,
      wrote_memory: normalized.dryRun ? false : Boolean(needsBaseSummary || needsLegacyTrackingInit || needsLegacyLayoutMigration || appendedUpdate),
      appended_update: Boolean(appendedUpdate),
      initialized_tracking: needsLegacyTrackingInit,
      summary: nextMemory,
      state: nextState,
      temp_dir: normalized.keepTemp ? usedTempDirs[0] || workRoot : null,
    };
  } finally {
    if (!normalized.keepTemp) {
      fs.rmSync(workRoot, { recursive: true, force: true });
    }
  }
}

function refreshLocalMemory(repoPath, memoryDir, options = {}) {
  const resolvedMemoryDir = path.resolve(memoryDir);
  const inputMemoryDir = path.resolve(options.inputMemoryDir || syncedThreadsDir(resolvedMemoryDir));
  if (!options.force && !memoryNeedsRefresh(resolvedMemoryDir, inputMemoryDir)) {
    return {
      refreshed: false,
      skipped: true,
      reason: "not_needed",
      memory_path: memoryPath(resolvedMemoryDir),
      memory_state_path: memoryStatePath(resolvedMemoryDir),
      input_memory_dir: inputMemoryDir,
    };
  }
  const result = summarizeMemoryWithCodex(repoPath, resolvedMemoryDir, {
    ...options,
    inputMemoryDir,
  });
  if (result.wrote_memory !== true && result.initialized_tracking !== true && result.appended_update !== true) {
    return {
      refreshed: false,
      skipped: true,
      reason: "not_needed",
      memory_path: result.memory_path,
      memory_state_path: result.memory_state_path,
      input_memory_dir: inputMemoryDir,
    };
  }
  return {
    ...result,
    refreshed: true,
    skipped: false,
    reason: result.initialized_tracking ? "tracking_initialized" : "refreshed",
    input_memory_dir: inputMemoryDir,
  };
}

function normalizeOptions(options) {
  return {
    codexBin: options.codexBin || process.env.CODEX_HANDOFF_CODEX_BIN || null,
    dryRun: options.dryRun === true,
    force: options.force === true,
    goal: options.goal || "Create a concise local repo memory summary from synced thread payloads.",
    initialUpdateThreads: positiveIntegerOr(options.initialUpdateThreads, DEFAULT_INITIAL_UPDATE_THREADS),
    inputMemoryDir: options.inputMemoryDir || null,
    keepTemp: options.keepTemp === true,
    maxBuffer: positiveIntegerOr(options.maxBuffer, 1024 * 1024 * 16),
    maxDigestThreads: nonNegativeIntegerOr(options.maxDigestThreads, DEFAULT_MAX_DIGEST_THREADS),
    maxThreadBytes: positiveIntegerOr(options.maxThreadBytes, DEFAULT_MAX_THREAD_BYTES),
    maxThreads: nonNegativeIntegerOr(options.maxThreads, 0),
    maxWords: positiveIntegerOr(options.maxWords, 900),
    model: options.model || null,
    repoSummaryMaxWords: positiveIntegerOr(options.repoSummaryMaxWords, 140),
    reasoningEffort: options.reasoningEffort || "low",
    timeoutMs: positiveIntegerOr(options.timeoutMs, 180000),
    updateMaxWords: positiveIntegerOr(options.updateMaxWords, 120),
  };
}

function normalizeAppendState(state) {
  if (state?.schema_version === APPEND_MEMORY_SCHEMA_VERSION && state?.mode === "append_log") {
    return {
      ...state,
      append_mode_enabled: true,
      processed_threads: typeof state.processed_threads === "object" && state.processed_threads ? state.processed_threads : {},
    };
  }
  return {
    schema_version: APPEND_MEMORY_SCHEMA_VERSION,
    mode: "append_log",
    append_mode_enabled: false,
    processed_threads: {},
    repo_summary_generated_at: null,
    repo_summary_source: null,
    updated_at: null,
  };
}

function loadThreadIndexEntries(inputMemoryDir) {
  const payload = readJson(path.join(inputMemoryDir, "thread-index.json"), []);
  return Array.isArray(payload) ? [...payload].sort(compareThreadIndex) : [];
}

function threadEntryToken(entry) {
  return [entry?.updated_at || "", entry?.bundle_path || "", entry?.thread_id || ""].join("|");
}

function selectChangedThreadEntries(threadIndex, appendState, normalized, { allowInitialEntries = false } = {}) {
  const entries = Array.isArray(threadIndex) ? [...threadIndex].sort(compareThreadIndex) : [];
  if (entries.length === 0) {
    return [];
  }
  const changed = entries.filter((entry) => appendState.processed_threads[entry.thread_id] !== threadEntryToken(entry));
  if (changed.length > 0) {
    return changed.slice(0, normalized.maxDigestThreads);
  }
  if (normalized.force) {
    return entries.slice(0, Math.max(1, normalized.initialUpdateThreads));
  }
  if (!appendState.append_mode_enabled && allowInitialEntries) {
    return entries.slice(0, Math.max(1, normalized.initialUpdateThreads));
  }
  return [];
}

function buildThreadDigestFromEntries(memoryDir, entries) {
  const selected = Array.isArray(entries) ? [...entries].sort(compareThreadIndex) : [];
  return {
    schema_version: "1.0",
    generated_at: new Date().toISOString(),
    source: "thread-index.json plus compact deterministic thread bundle digests",
    thread_count: selected.length,
    included_thread_count: selected.length,
    omitted_thread_count: 0,
    threads: selected.map((entry) => summarizeThreadEntry(memoryDir, entry)),
  };
}

function prepareConversationUpdateInputs(repoPath, memoryDir, inputMemoryDir, inputDir, changedEntries, options) {
  const copied = [];
  const skipped = [];
  const generated = [];
  const repoState = loadRepoState(memoryDir, { repoPath });
  const repoConfigPath = path.join(inputDir, "repo-config.json");
  fs.writeFileSync(repoConfigPath, JSON.stringify(repoState, null, 2) + "\n", "utf8");
  copied.push({ path: "repo-config", input_path: "repo-config.json", bytes: fs.statSync(repoConfigPath).size });
  for (const name of ["current-thread.json", "handoff.json"]) {
    copyMemoryFile(inputMemoryDir, name, path.join(inputDir, name), copied, skipped, { inputDir });
  }
  const digestPath = path.join(inputDir, "changed-thread-digest.json");
  const digest = buildThreadDigestFromEntries(inputMemoryDir, changedEntries.slice(0, options.maxDigestThreads));
  fs.writeFileSync(digestPath, JSON.stringify(digest, null, 2) + "\n", "utf8");
  generated.push({
    path: "changed-thread-digest.json",
    bytes: fs.statSync(digestPath).size,
    thread_count: digest.threads.length,
  });
  return {
    schema_version: "2.0",
    created_at: new Date().toISOString(),
    repo_path: repoPath,
    memory_dir: memoryDir,
    input_memory_dir: inputMemoryDir,
    input_dir: inputDir,
    copied_files: copied,
    generated_files: generated,
    skipped_files: skipped,
    changed_threads: changedEntries.map((entry) => ({
      thread_id: entry.thread_id,
      updated_at: entry.updated_at || null,
      title: entry.title || entry.thread_name || entry.thread_id,
    })),
  };
}

function prepareMemoryInputs(repoPath, memoryDir, inputMemoryDir, inputDir, options) {
  const copied = [];
  const skipped = [];
  const repoState = loadRepoState(memoryDir, { repoPath });
  const repoConfigPath = path.join(inputDir, "repo-config.json");
  fs.writeFileSync(repoConfigPath, JSON.stringify(repoState, null, 2) + "\n", "utf8");
  copied.push({ path: "repo-config", input_path: "repo-config.json", bytes: fs.statSync(repoConfigPath).size });
  copyMemoryFile(memoryDir, "memory.md", path.join(inputDir, "previous-memory.md"), copied, skipped, { inputDir });
  for (const name of ["latest.md", "handoff.json", "thread-index.json", "current-thread.json"]) {
    copyMemoryFile(inputMemoryDir, name, path.join(inputDir, name), copied, skipped, { inputDir });
  }

  const threadIndex = readJson(path.join(inputMemoryDir, "thread-index.json"), []);
  const generated = [];
  const threadDigest = buildThreadDigest(inputMemoryDir, threadIndex, options.maxDigestThreads);
  const digestPath = path.join(inputDir, "thread-digest.json");
  fs.writeFileSync(digestPath, JSON.stringify(threadDigest, null, 2) + "\n", "utf8");
  generated.push({
    path: "thread-digest.json",
    bytes: fs.statSync(digestPath).size,
    thread_count: threadDigest.threads.length,
    omitted_thread_count: threadDigest.omitted_thread_count,
  });
  const selectedThreads = [];
  if (options.maxThreads > 0 && Array.isArray(threadIndex)) {
    const threadsDir = path.join(inputDir, "threads");
    fs.mkdirSync(threadsDir, { recursive: true });
    for (const entry of [...threadIndex].sort(compareThreadIndex).slice(0, options.maxThreads)) {
      const threadId = entry?.thread_id;
      if (!threadId) continue;
      const sourcePath = resolveThreadBundlePath(inputMemoryDir, threadId, entry?.bundle_path || null);
      const targetPath = path.join(threadsDir, path.basename(sourcePath));
      const copiedThread = copyMemoryFile(inputMemoryDir, path.relative(inputMemoryDir, sourcePath), targetPath, copied, skipped, {
        inputDir,
        maxBytes: options.maxThreadBytes,
      });
      selectedThreads.push({
        thread_id: threadId,
        title: entry.title || entry.thread_name || "",
        bundle_copied: copiedThread,
        bundle_path: copiedThread ? path.relative(inputDir, targetPath).split(path.sep).join("/") : null,
      });
    }
  }

  return {
    schema_version: "1.0",
    created_at: new Date().toISOString(),
    repo_path: repoPath,
    memory_dir: memoryDir,
    input_memory_dir: inputMemoryDir,
    input_dir: inputDir,
    copied_files: copied,
    generated_files: generated,
    skipped_files: skipped,
    selected_threads: selectedThreads,
  };
}

function buildThreadDigest(memoryDir, threadIndex, maxDigestThreads) {
  const entries = Array.isArray(threadIndex) ? [...threadIndex].sort(compareThreadIndex) : [];
  const selected = entries.slice(0, maxDigestThreads);
  return {
    schema_version: "1.0",
    generated_at: new Date().toISOString(),
    source: "thread-index.json plus compact deterministic thread bundle digests",
    thread_count: entries.length,
    included_thread_count: selected.length,
    omitted_thread_count: Math.max(0, entries.length - selected.length),
    threads: selected.map((entry) => summarizeThreadEntry(memoryDir, entry)),
  };
}

function memoryNeedsRefresh(memoryDir, inputMemoryDir) {
  if (!hasMemorySourceData(inputMemoryDir)) {
    return false;
  }
  const memoryFile = memoryPath(memoryDir);
  const state = normalizeAppendState(readJson(memoryStatePath(memoryDir), {}));
  if (!fs.existsSync(memoryFile)) {
    return true;
  }
  const existingMemory = fs.readFileSync(memoryFile, "utf8");
  const priorInputMemoryDir = state?.input_memory_dir
    ? path.resolve(String(state.input_memory_dir))
    : null;
  if (!state.append_mode_enabled) {
    return true;
  }
  if (!looksLikeAppendMemoryDocument(existingMemory)) {
    return true;
  }
  if (priorInputMemoryDir !== inputMemoryDir) {
    return true;
  }
  const changedEntries = selectChangedThreadEntries(loadThreadIndexEntries(inputMemoryDir), state, { maxDigestThreads: DEFAULT_MAX_DIGEST_THREADS, initialUpdateThreads: DEFAULT_INITIAL_UPDATE_THREADS, force: false });
  return changedEntries.length > 0;
}

function buildRepoSummaryPrompt({ goal, inputDir, manifestPath, maxWords }) {
  return [
    "You are a child Codex process invoked by codex-handoff to write a basic repo summary.",
    "",
    "Task:",
    `- Return only Markdown content for a short 'Repo Summary' section under ${maxWords} words.`,
    `- User goal: ${goal}`,
    "- Focus on stable repository purpose and current high-level scope.",
    "- Do not include recent work chronology, thread links, or next-step bullets.",
    "",
    "Input policy:",
    `- Read only files under this isolated input directory: ${inputDir}`,
    `- Start with this manifest: ${manifestPath}`,
    "- Do not inspect the original repository checkout.",
    "- Prefer repo-config.json, handoff.json, latest.md, and thread-digest.json for high-level context.",
    "",
    "Output requirements:",
    "- Return only the summary body, with no heading text.",
    "- A short paragraph or up to three bullets is acceptable.",
  ].join("\n");
}

function buildConversationUpdatePrompt({ goal, inputDir, manifestPath, maxWords }) {
  return [
    "You are a child Codex process invoked by codex-handoff to append a conversation update.",
    "",
    "Task:",
    `- Return only Markdown bullet lines for a concise update under ${maxWords} words.`,
    `- User goal: ${goal}`,
    "- Summarize only the newly changed conversation activity from changed-thread-digest.json.",
    "- Do not restate stable repo overview unless the new conversation explicitly changed it.",
    "- Do not include a heading; the caller will add the timestamp heading.",
    "- End with one 'Threads:' line that lists thread_id values and turn_id when available.",
    "",
    "Input policy:",
    `- Read only files under this isolated input directory: ${inputDir}`,
    `- Start with this manifest: ${manifestPath}`,
    "- Do not inspect the original repository checkout.",
    "- Use changed-thread-digest.json as the primary source for the update.",
  ].join("\n");
}

function runCodexMarkdownTask({
  codexBin,
  keepTemp,
  maxBuffer,
  model,
  prepareInputs,
  promptBuilder,
  reasoningEffort,
  timeoutMs,
  tmpRoot,
}) {
  const inputDir = path.join(tmpRoot, "input");
  const outputDir = path.join(tmpRoot, "output");
  const outputPath = path.join(outputDir, "memory.next.md");
  fs.mkdirSync(inputDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });
  const manifest = prepareInputs(inputDir);
  const manifestPath = path.join(inputDir, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  const prompt = promptBuilder({ inputDir, manifestPath, manifest });
  const codexArgs = buildCodexArgs({
    model,
    outputPath,
    reasoningEffort,
    tmpRoot,
  });
  const result = spawnSync(codexBin, codexArgs, {
    cwd: tmpRoot,
    encoding: "utf8",
    input: prompt,
    killSignal: "SIGTERM",
    maxBuffer,
    timeout: timeoutMs,
  });
  assertCodexResult(result, outputPath, timeoutMs);
  return {
    output: fs.readFileSync(outputPath, "utf8").trim(),
    manifest,
    temp_dir: keepTemp ? tmpRoot : null,
  };
}

function renderInitialMemoryDocument(repoSummary, appendedUpdate) {
  const parts = [
    "# Repo Memory",
    "",
    "## Repo Summary",
    repoSummary || "_Repo summary unavailable._",
    "",
    "## Conversation Updates",
  ];
  if (appendedUpdate) {
    parts.push("", appendedUpdate.trim());
  } else {
    parts.push("", "_No conversation updates recorded yet._");
  }
  return `${parts.join("\n").trimEnd()}\n`;
}

function looksLikeAppendMemoryDocument(existingMemory) {
  const text = String(existingMemory || "");
  return text.includes("# Repo Memory") && text.includes("## Repo Summary") && text.includes("## Conversation Updates");
}

function extractLegacyRepoSummary(existingMemory) {
  const text = String(existingMemory || "").trim();
  if (!text) {
    return "_Repo summary unavailable._";
  }
  const repoOverviewMatch = text.match(/## Repo Overview\s+([\s\S]*?)(?:\n## |\s*$)/u);
  if (repoOverviewMatch?.[1]) {
    return repoOverviewMatch[1].trim();
  }
  const recentWorkMatch = text.match(/## Recent Work\s+([\s\S]*?)(?:\n## |\s*$)/u);
  if (recentWorkMatch?.[1]) {
    return shorten(recentWorkMatch[1].trim(), 500);
  }
  return shorten(text.replace(/^#+\s.*$/gmu, "").trim(), 500);
}

function extractExistingConversationUpdates(existingMemory) {
  const text = String(existingMemory || "");
  const match = text.match(/## Conversation Updates\s+([\s\S]*?)\s*$/u);
  return match?.[1]?.trim() || "";
}

function mergeConversationUpdates(existingUpdates, appendedUpdate) {
  const sections = [String(existingUpdates || "").trim(), String(appendedUpdate || "").trim()].filter(Boolean);
  return sections.join("\n\n");
}

function appendConversationUpdateToMemory(existingMemory, appendedUpdate, { ensureUpdatesHeader = false } = {}) {
  const base = String(existingMemory || "").trimEnd();
  if (!ensureUpdatesHeader || !appendedUpdate) {
    return `${base}\n`;
  }
  const hasUpdatesHeader = base.includes("\n## Conversation Updates");
  const header = hasUpdatesHeader ? "" : "\n\n## Conversation Updates";
  return `${base}${header}\n\n${appendedUpdate.trim()}\n`;
}

function extractAppendedPortion(previousContent, nextContent) {
  return String(nextContent || "").slice(String(previousContent || "").length);
}

function renderConversationUpdateBlock(markdown, changedEntries) {
  const heading = `### ${new Date().toISOString()}`;
  const body = String(markdown || "").trim() || "- No new conversation summary was produced.";
  return `${heading}\n${body}\n`;
}

function buildNextMemoryState({
  appendState,
  changedEntries,
  trackedEntries,
  dryRun,
  inputMemoryDir,
  normalized,
  repoSummaryGenerated,
  repoSummaryManifest,
  updateManifest,
  codexBin,
}) {
  const processedThreads = {
    ...appendState.processed_threads,
  };
  for (const entry of trackedEntries || []) {
    if (entry?.thread_id) {
      processedThreads[entry.thread_id] = threadEntryToken(entry);
    }
  }
  return {
    schema_version: APPEND_MEMORY_SCHEMA_VERSION,
    mode: "append_log",
    updated_at: new Date().toISOString(),
    generator: "codex exec",
    codex_bin: codexBin,
    goal: normalized.goal,
    max_digest_threads: normalized.maxDigestThreads,
    repo_summary_max_words: normalized.repoSummaryMaxWords,
    update_max_words: normalized.updateMaxWords,
    input_memory_dir: inputMemoryDir,
    dry_run: dryRun,
    repo_summary_generated_at: repoSummaryGenerated ? new Date().toISOString() : appendState.repo_summary_generated_at || null,
    repo_summary_source: repoSummaryGenerated ? "generated_once" : (appendState.repo_summary_source || "existing_memory"),
    last_appended_at: changedEntries.length > 0 ? new Date().toISOString() : appendState.last_appended_at || null,
    last_appended_thread_ids: changedEntries.map((entry) => entry.thread_id).filter(Boolean),
    processed_threads: processedThreads,
    repo_summary_manifest: repoSummaryManifest || appendState.repo_summary_manifest || null,
    last_update_manifest: updateManifest || null,
  };
}

function hasMemorySourceData(inputMemoryDir) {
  const candidates = [
    path.join(inputMemoryDir, "latest.md"),
    path.join(inputMemoryDir, "handoff.json"),
    path.join(inputMemoryDir, "thread-index.json"),
    path.join(inputMemoryDir, "current-thread.json"),
    path.join(inputMemoryDir, "threads"),
  ];
  return candidates.some((candidate) => fs.existsSync(candidate));
}

function newestSourceMtime(rootDir) {
  const stack = [rootDir];
  let latest = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || !fs.existsSync(current)) {
      continue;
    }
    const stat = fs.statSync(current);
    latest = Math.max(latest, stat.mtimeMs);
    if (!stat.isDirectory()) {
      continue;
    }
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      stack.push(path.join(current, entry.name));
    }
  }
  return latest;
}

function summarizeThreadEntry(memoryDir, entry) {
  const threadId = entry?.thread_id || "";
  const bundlePath = threadId ? resolveThreadBundlePath(memoryDir, threadId, entry?.bundle_path || null) : null;
  const transcript = threadId ? loadThreadTranscript(memoryDir, threadId, entry?.bundle_path || null) : null;
  const rows = Array.isArray(transcript) ? transcript : [];
  const lastUser = [...rows].reverse().find((item) => item?.role === "user") || null;
  const lastAssistant = [...rows].reverse().find((item) => item?.role === "assistant") || null;
  const lastRecord = rows[rows.length - 1] || null;
  return {
    thread_id: threadId,
    title: entry?.title || entry?.thread_name || threadId,
    thread_name: entry?.thread_name || null,
    updated_at: entry?.updated_at || null,
    source_session_relpath: entry?.source_session_relpath || null,
    bundle_path: entry?.bundle_path || (threadId ? resolveThreadBundleRelPath(memoryDir, threadId) : null),
    bundle_present: Boolean(transcript),
    message_count: rows.length,
    last_activity_at: lastRecord?.timestamp || entry?.updated_at || null,
    last_turn_id: lastRecord?.turn_id || null,
    last_user_turn_id: lastUser?.turn_id || null,
    last_user: shorten(lastUser?.message || "", 220),
    last_assistant_turn_id: lastAssistant?.turn_id || null,
    last_assistant: shorten(lastAssistant?.message || "", 260),
  };
}

function copyMemoryFile(memoryDir, relPath, targetPath, copied, skipped, { inputDir = null, maxBytes = null } = {}) {
  const sourcePath = path.join(memoryDir, relPath);
  const normalizedRelPath = relPath.split(path.sep).join("/");
  return copyFileByPath(sourcePath, normalizedRelPath, targetPath, copied, skipped, { inputDir, maxBytes });
}

function copyFileByPath(sourcePath, normalizedRelPath, targetPath, copied, skipped, { inputDir = null, maxBytes = null } = {}) {
  if (!fs.existsSync(sourcePath)) {
    skipped.push({ path: normalizedRelPath, reason: "missing" });
    return false;
  }
  const stat = fs.statSync(sourcePath);
  if (!stat.isFile()) {
    skipped.push({ path: normalizedRelPath, reason: "not_file" });
    return false;
  }
  if (maxBytes !== null && stat.size > maxBytes) {
    skipped.push({ path: normalizedRelPath, reason: "too_large", bytes: stat.size, max_bytes: maxBytes });
    return false;
  }
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(sourcePath, targetPath);
  const inputPath = inputDir ? path.relative(inputDir, targetPath).split(path.sep).join("/") : path.basename(targetPath);
  copied.push({ path: normalizedRelPath, input_path: inputPath, bytes: stat.size });
  return true;
}

function buildCodexArgs({ model, outputPath, reasoningEffort, tmpRoot }) {
  const args = [
    "exec",
    "--skip-git-repo-check",
    "--ephemeral",
    "--sandbox",
    "read-only",
    "-c",
    `model_reasoning_effort="${reasoningEffort}"`,
    "--color",
    "never",
    "-C",
    tmpRoot,
    "-o",
    outputPath,
    "-",
  ];
  if (model) {
    args.splice(1, 0, "--model", model);
  }
  return args;
}

function buildMemoryPrompt({ goal, inputDir, manifestPath, maxWords }) {
  return [
    "You are a child Codex process invoked by codex-handoff to write repo-level memory.",
    "",
    "Task:",
    `- Return a concise Markdown memory summary under ${maxWords} words.`,
    `- User goal: ${goal}`,
    "",
    "Input policy:",
    `- Read only files under this isolated input directory: ${inputDir}`,
    `- Start with this manifest: ${manifestPath}`,
    "- Do not inspect the original repository checkout.",
    "- Do not inspect raw session logs.",
    "- Prefer thread-digest.json over copied full thread bundles when writing the memory.",
    "- Do not enumerate historical thread bundles beyond files copied into the input directory.",
    "- Use previous-memory.md to preserve durable project context when it is still consistent with the latest thread inputs.",
    "- Prioritize the newest synced thread activity when describing recent work.",
    "- If previous-memory.md conflicts with the latest synced thread inputs, correct it rather than preserving it.",
    "",
    "Output exactly these Markdown sections:",
    "1. Recent Work",
    "2. Repo Overview",
    "3. Durable Decisions",
    "4. Active Notes",
    "5. Next Steps",
    "6. Thread Links",
    "",
    "Section expectations:",
    "- Recent Work: summarize the latest meaningful implementation or debugging activity.",
    "- Repo Overview: keep a compact durable overview of what this repo does and what the current effort is about.",
    "- Durable Decisions: include rules or design choices that should survive across sessions.",
    "- Active Notes: include important current constraints, risks, or caveats.",
    "- Next Steps: list the most likely immediate follow-up actions.",
    "- Thread Links must include thread_id and turn_id when available. If turn_id is unavailable, say unavailable.",
  ].join("\n");
}

function assertCodexResult(result, outputPath, timeoutMs) {
  if (result.error || result.status !== 0) {
    const reason = result.error?.code === "ETIMEDOUT"
      ? `timed out after ${timeoutMs}ms`
      : `failed with status ${result.status}`;
    throw new Error(
      `codex exec ${reason}; suppressed child logs ` +
        `(stdout_bytes=${byteLength(result.stdout)}, stderr_bytes=${byteLength(result.stderr)})`,
    );
  }
  if (!fs.existsSync(outputPath)) {
    throw new Error(
      `codex exec completed without writing ${outputPath}; suppressed child logs ` +
        `(stdout_bytes=${byteLength(result.stdout)}, stderr_bytes=${byteLength(result.stderr)})`,
    );
  }
}

function resolveCodexBin(explicit = null, env = process.env, platform = process.platform) {
  if (explicit) return explicit;
  const fromPath = findOnPath("codex", env, platform);
  if (fromPath) return fromPath;
  const candidates = [];
  if (platform === "darwin") {
    candidates.push("/Applications/Codex.app/Contents/Resources/codex");
  } else if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    candidates.push(
      path.join(localAppData, "OpenAI", "Codex", "bin", "codex.exe"),
      path.join(localAppData, "OpenAI", "Codex", "bin", "codex.cmd"),
    );
  }
  return candidates.find((item) => fs.existsSync(item)) || "codex";
}

function findOnPath(command, env = process.env, platform = process.platform) {
  const pathValue = env.PATH || env.Path || "";
  const extensions = platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  for (const dir of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(dir, `${command}${extension}`);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

function atomicWriteFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, content, "utf8");
  fs.renameSync(tmpPath, filePath);
}

function atomicWriteJson(filePath, payload) {
  atomicWriteFile(filePath, JSON.stringify(payload, null, 2) + "\n");
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function shorten(text, limit) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 3).trimEnd()}...`;
}

function compareThreadIndex(a, b) {
  return String(b?.updated_at || "").localeCompare(String(a?.updated_at || ""));
}

function positiveIntegerOr(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeIntegerOr(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function byteLength(value) {
  return Buffer.byteLength(String(value || ""), "utf8");
}

module.exports = {
  buildMemoryPrompt,
  buildThreadDigest,
  memoryPath,
  memoryNeedsRefresh,
  memoryStatePath,
  prepareMemoryInputs,
  refreshLocalMemory,
  resolveCodexBin,
  summarizeMemoryWithCodex,
};
