const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { loadThreadTranscript, resolveThreadBundlePath, resolveThreadBundleRelPath } = require("./thread-bundles");

const DEFAULT_MAX_THREAD_BYTES = 32768;
const DEFAULT_MAX_DIGEST_THREADS = 100;

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
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-handoff-memory-"));
  const inputDir = path.join(tmpRoot, "input");
  const outputDir = path.join(tmpRoot, "output");
  const outputPath = path.join(outputDir, "memory.next.md");
  fs.mkdirSync(inputDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });

  try {
    const manifest = prepareMemoryInputs(resolvedRepoPath, resolvedMemoryDir, inputDir, normalized);
    const manifestPath = path.join(inputDir, "manifest.json");
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
    const prompt = buildMemoryPrompt({
      goal: normalized.goal,
      inputDir,
      manifestPath,
      maxWords: normalized.maxWords,
    });
    const codexBin = resolveCodexBin(normalized.codexBin);
    const codexArgs = buildCodexArgs({
      model: normalized.model,
      outputPath,
      reasoningEffort: normalized.reasoningEffort,
      tmpRoot,
    });
    const result = spawnSync(codexBin, codexArgs, {
      cwd: tmpRoot,
      encoding: "utf8",
      input: prompt,
      killSignal: "SIGTERM",
      maxBuffer: normalized.maxBuffer,
      timeout: normalized.timeoutMs,
    });
    assertCodexResult(result, outputPath, normalized.timeoutMs);
    const summary = fs.readFileSync(outputPath, "utf8").trimEnd() + "\n";
    const state = {
      schema_version: "1.0",
      updated_at: new Date().toISOString(),
      generator: "codex exec",
      codex_bin: codexBin,
    goal: normalized.goal,
    max_digest_threads: normalized.maxDigestThreads,
    max_words: normalized.maxWords,
      max_threads: normalized.maxThreads,
      max_thread_bytes: normalized.maxThreadBytes,
      dry_run: normalized.dryRun,
      input_manifest: manifest,
    };
    if (!normalized.dryRun) {
      atomicWriteFile(memoryPath(resolvedMemoryDir), summary);
      atomicWriteJson(memoryStatePath(resolvedMemoryDir), state);
    }
    return {
      memory_path: memoryPath(resolvedMemoryDir),
      memory_state_path: memoryStatePath(resolvedMemoryDir),
      dry_run: normalized.dryRun,
      wrote_memory: !normalized.dryRun,
      summary,
      state,
      temp_dir: normalized.keepTemp ? tmpRoot : null,
    };
  } finally {
    if (!normalized.keepTemp) {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  }
}

function normalizeOptions(options) {
  return {
    codexBin: options.codexBin || process.env.CODEX_HANDOFF_CODEX_BIN || null,
    dryRun: options.dryRun === true,
    goal: options.goal || "Create a concise repo-level codex-handoff memory summary.",
    keepTemp: options.keepTemp === true,
    maxBuffer: positiveIntegerOr(options.maxBuffer, 1024 * 1024 * 16),
    maxDigestThreads: nonNegativeIntegerOr(options.maxDigestThreads, DEFAULT_MAX_DIGEST_THREADS),
    maxThreadBytes: positiveIntegerOr(options.maxThreadBytes, DEFAULT_MAX_THREAD_BYTES),
    maxThreads: nonNegativeIntegerOr(options.maxThreads, 0),
    maxWords: positiveIntegerOr(options.maxWords, 900),
    model: options.model || null,
    reasoningEffort: options.reasoningEffort || "low",
    timeoutMs: positiveIntegerOr(options.timeoutMs, 180000),
  };
}

function prepareMemoryInputs(repoPath, memoryDir, inputDir, options) {
  const copied = [];
  const skipped = [];
  for (const name of ["latest.md", "handoff.json", "thread-index.json", "current-thread.json", "repo.json"]) {
    copyMemoryFile(memoryDir, name, path.join(inputDir, name), copied, skipped, { inputDir });
  }
  copyMemoryFile(memoryDir, "memory.md", path.join(inputDir, "previous-memory.md"), copied, skipped, { inputDir });

  const threadIndex = readJson(path.join(memoryDir, "thread-index.json"), []);
  const generated = [];
  const threadDigest = buildThreadDigest(memoryDir, threadIndex, options.maxDigestThreads);
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
      const sourcePath = resolveThreadBundlePath(memoryDir, threadId, entry?.bundle_path || null);
      const targetPath = path.join(threadsDir, path.basename(sourcePath));
      const copiedThread = copyMemoryFile(memoryDir, path.relative(memoryDir, sourcePath), targetPath, copied, skipped, {
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
    "",
    "Output exactly these Markdown sections:",
    "1. Current Focus",
    "2. Durable Decisions",
    "3. Active Implementation Notes",
    "4. Open TODOs",
    "5. Thread Links",
    "",
    "Thread Links must include thread_id and turn_id when available. If turn_id is unavailable, say unavailable.",
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
  memoryStatePath,
  prepareMemoryInputs,
  resolveCodexBin,
  summarizeMemoryWithCodex,
};
