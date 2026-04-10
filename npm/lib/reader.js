const fs = require("node:fs");
const path = require("node:path");
const { summarizeTranscriptBundle } = require("./summarize");
const { listThreadBundleFiles, readTranscriptFile, resolveThreadBundlePath } = require("./thread-bundles");

const DEFAULT_MEMORY_DIRNAME = ".codex-handoff";

function resolveRepoPath(repoPath) {
  return path.resolve(repoPath);
}

function resolveMemoryDir(repoPath, memoryDir = null) {
  return memoryDir ? path.resolve(memoryDir) : path.join(resolveRepoPath(repoPath), DEFAULT_MEMORY_DIRNAME);
}

function latestPath(memoryDir) {
  return path.join(memoryDir, "latest.md");
}

function handoffPath(memoryDir) {
  return path.join(memoryDir, "handoff.json");
}

function memoryPath(memoryDir) {
  return path.join(memoryDir, "memory.md");
}

function currentThreadPath(memoryDir) {
  return path.join(memoryDir, "current-thread.json");
}

function threadsDir(memoryDir) {
  return path.join(memoryDir, "threads");
}

function readLatest(memoryDir) {
  const bundle = readCurrentThreadBundle(memoryDir);
  if (bundle) {
    return summarizeTranscriptBundle(resolveRepoFromMemory(memoryDir), bundle).latestMd.trim();
  }
  const filePath = latestPath(memoryDir);
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8").trim() : "";
}

function readHandoff(memoryDir) {
  const bundle = readCurrentThreadBundle(memoryDir);
  if (bundle) {
    return summarizeTranscriptBundle(resolveRepoFromMemory(memoryDir), bundle).handoffJson;
  }
  const filePath = handoffPath(memoryDir);
  return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, "utf8")) : {};
}

function readMemory(memoryDir) {
  const filePath = memoryPath(memoryDir);
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8").trim() : "";
}

function* iterTranscriptRecords(memoryDir) {
  const directory = threadsDir(memoryDir);
  if (!fs.existsSync(directory)) {
    return;
  }
  for (const filePath of listThreadBundleFiles(memoryDir)) {
    const transcript = readTranscriptFile(filePath);
    const rows = Array.isArray(transcript) ? transcript : [];
    for (let index = 0; index < rows.length; index += 1) {
      const record = rows[index];
      const text = collectText(record).join(" ");
      yield {
        file_path: filePath,
        line_number: index + 1,
        score: 0,
        session_id: firstPresent(record, ["session_id", "session", "conversation_id"]),
        turn_id: firstPresent(record, ["turn_id", "turn", "message_id", "id"]),
        timestamp: firstPresent(record, ["timestamp", "created_at", "at"]),
        role: firstPresent(record, ["role", "speaker", "author"]),
        snippet: shorten(text),
        record,
      };
    }
  }
}

function readCurrentThreadBundle(memoryDir) {
  const currentPath = currentThreadPath(memoryDir);
  if (!fs.existsSync(currentPath)) {
    return null;
  }
  try {
    const payload = JSON.parse(fs.readFileSync(currentPath, "utf8"));
    const threadId = typeof payload.thread_id === "string" ? payload.thread_id : null;
    if (!threadId) {
      return null;
    }
    const bundlePath = resolveThreadBundlePath(memoryDir, threadId);
    if (!fs.existsSync(bundlePath)) {
      return null;
    }
    const transcript = readTranscriptFile(bundlePath);
    const indexEntries = JSON.parse(fs.readFileSync(path.join(memoryDir, "thread-index.json"), "utf8"));
    const indexEntry = Array.isArray(indexEntries) ? indexEntries.find((item) => item.thread_id === threadId) : null;
    return {
      thread_id: threadId,
      thread_title: indexEntry?.title || indexEntry?.thread_name || threadId,
      thread_name: indexEntry?.thread_name || null,
      transcript: Array.isArray(transcript) ? transcript : [],
    };
  } catch {
    return null;
  }
}

function resolveRepoFromMemory(memoryDir) {
  try {
    const repoPath = JSON.parse(fs.readFileSync(path.join(memoryDir, "repo.json"), "utf8")).workspace_root;
    return repoPath || memoryDir;
  } catch {
    return memoryDir;
  }
}

function collectText(value) {
  if (value === null || value === undefined) return [];
  if (typeof value === "string") return [value];
  if (typeof value === "number" || typeof value === "boolean") return [String(value)];
  if (Array.isArray(value)) return value.flatMap((item) => collectText(item));
  if (typeof value === "object") return Object.entries(value).flatMap(([key, item]) => [String(key), ...collectText(item)]);
  return [String(value)];
}

function normalizeWhitespace(text) {
  return String(text).replace(/\s+/g, " ").trim();
}

function shorten(text, limit = 240) {
  const clean = normalizeWhitespace(text);
  return clean.length <= limit ? clean : `${clean.slice(0, limit - 3).trimEnd()}...`;
}

function tokenize(text) {
  const seen = new Set();
  const tokens = [];
  for (const token of String(text).toLowerCase().match(/[a-z0-9_.:/-]+/g) || []) {
    if (token.length < 3 || seen.has(token)) continue;
    seen.add(token);
    tokens.push(token);
  }
  return tokens;
}

function matchScore(haystack, terms) {
  const lower = String(haystack).toLowerCase();
  return terms.reduce((score, term) => score + (lower.includes(term) ? lower.split(term).length - 1 : 0), 0);
}

function firstPresent(record, keys) {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) {
      return String(record[key]);
    }
  }
  return null;
}

function searchRaw(memoryDir, query, limit = 8) {
  const terms = tokenize(query);
  if (!terms.length) return [];
  const matches = [];
  for (const item of iterTranscriptRecords(memoryDir)) {
    const text = collectText(item.record).join(" ");
    const score = matchScore(text, terms);
    if (score <= 0) continue;
    matches.push({ ...item, score });
  }
  matches.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.file_path !== b.file_path) return a.file_path.localeCompare(b.file_path);
    return a.line_number - b.line_number;
  });
  return matches.slice(0, limit);
}

function extractRecords(memoryDir, { sessionId = null, turnId = null } = {}) {
  const results = [];
  for (const item of iterTranscriptRecords(memoryDir)) {
    if (sessionId && item.session_id !== sessionId) continue;
    if (turnId && item.turn_id !== turnId) continue;
    results.push(item);
  }
  return results;
}

function countThreadFiles(memoryDir) {
  return listThreadBundleFiles(memoryDir).length;
}

function countTranscriptRecords(memoryDir) {
  let count = 0;
  for (const _item of iterTranscriptRecords(memoryDir)) count += 1;
  return count;
}

function buildContextQuery(goal, handoff) {
  const pieces = [goal];
  if (typeof handoff.current_goal === "string") pieces.push(handoff.current_goal);
  for (const key of ["search_hints", "related_files", "notes"]) {
    const value = handoff[key];
    if (Array.isArray(value)) pieces.push(...value.map((item) => String(item)));
  }
  if (Array.isArray(handoff.todos)) {
    for (const todo of handoff.todos.slice(0, 3)) {
      if (todo && typeof todo === "object" && todo.summary) pieces.push(String(todo.summary));
    }
  }
  return pieces.filter(Boolean).join(" ");
}

function renderStatus(repoPath, memoryDir) {
  const latestText = readLatest(memoryDir);
  const memoryText = readMemory(memoryDir);
  const handoff = readHandoff(memoryDir);
  const currentThreadExists = fs.existsSync(currentThreadPath(memoryDir));
  const lines = [
    "# codex-handoff status",
    "",
    "## Paths",
    `- repo: ${repoPath}`,
    `- memory_dir: ${memoryDir}`,
    "",
    "## Files",
    `- current-thread.json: ${currentThreadExists ? "present" : "missing"}`,
    `- current thread bundle: ${latestText || Object.keys(handoff).length ? "present" : "missing"}`,
    `- memory.md: ${memoryText ? "present" : "missing"}`,
    `- thread files: ${countThreadFiles(memoryDir)}`,
    `- transcript records: ${countTranscriptRecords(memoryDir)}`,
  ];
  if (latestText) {
    lines.push("", "## Bootstrap Summary", latestText);
  }
  if (memoryText) {
    lines.push("", "## Repo Memory", memoryText);
  }
  if (Object.keys(handoff).length) {
    lines.push(
      "",
      "## Structured State",
      `- current_goal: ${handoff.current_goal || ""}`,
      `- active_branch: ${handoff.active_branch || ""}`,
      `- todo_count: ${Array.isArray(handoff.todos) ? handoff.todos.length : 0}`,
      `- decision_count: ${Array.isArray(handoff.decisions) ? handoff.decisions.length : 0}`,
    );
  }
  return `${lines.join("\n").trim()}\n`;
}

function renderContextPack(repoPath, memoryDir, goal, { evidenceLimit = 5 } = {}) {
  const latest = readLatest(memoryDir);
  const memory = readMemory(memoryDir);
  const handoff = readHandoff(memoryDir);
  const evidence = searchRaw(memoryDir, buildContextQuery(goal, handoff), evidenceLimit);
  const lines = [
    "# Codex Restore Pack",
    "",
    `- repo: ${repoPath}`,
    `- memory_dir: ${memoryDir}`,
    `- requested_goal: ${goal}`,
    "",
    "## Bootstrap",
    latest || "_missing latest.md_",
    "",
    "## Repo Memory",
    memory || "_missing memory.md_",
    "",
    "## Structured State",
    `- current_goal: ${handoff.current_goal || ""}`,
    `- status_summary: ${handoff.status_summary || ""}`,
    `- active_branch: ${handoff.active_branch || ""}`,
    `- next_prompt: ${handoff.next_prompt || ""}`,
    "",
    "## Decisions",
  ];
  lines.push(...renderDecisions(handoff));
  lines.push("", "## TODOs");
  lines.push(...renderTodos(handoff));
  lines.push("", "## Related Files");
  if (Array.isArray(handoff.related_files) && handoff.related_files.length) {
    lines.push(...handoff.related_files.map((item) => `- ${item}`));
  } else {
    lines.push("- none");
  }
  lines.push("", "## Ranked Transcript Evidence");
  if (!evidence.length) {
    lines.push("- none");
  } else {
    for (const item of evidence) {
      let label = `- score=${item.score} session=${item.session_id || "?"} turn=${item.turn_id || "?"}`;
      if (item.timestamp) label += ` at=${item.timestamp}`;
      lines.push(label);
      lines.push(`  file=${item.file_path}:${item.line_number}`);
      lines.push(`  snippet=${item.snippet}`);
    }
  }
  return `${lines.join("\n").trim()}\n`;
}

function renderSearchResults(query, matches) {
  const lines = [
    "# codex-handoff search",
    "",
    `- query: ${query}`,
    `- matches: ${matches.length}`,
    "",
  ];
  if (!matches.length) {
    lines.push("No matches found.");
    return `${lines.join("\n").trim()}\n`;
  }
  for (const item of matches) {
    lines.push(`- score=${item.score} session=${item.session_id || "?"} turn=${item.turn_id || "?"} role=${item.role || "?"}`);
    lines.push(`  file=${item.file_path}:${item.line_number}`);
    if (item.timestamp) lines.push(`  timestamp=${item.timestamp}`);
    lines.push(`  snippet=${item.snippet}`);
  }
  return `${lines.join("\n").trim()}\n`;
}

function renderExtractResults(records) {
  return `${JSON.stringify(records.map((item) => ({
    file: item.file_path,
    line_number: item.line_number,
    session_id: item.session_id,
    turn_id: item.turn_id,
    timestamp: item.timestamp,
    role: item.role,
    record: item.record,
  })), null, 2)}\n`;
}

function renderDecisions(handoff) {
  if (!Array.isArray(handoff.decisions) || !handoff.decisions.length) return ["- none"];
  const rows = handoff.decisions
    .filter((item) => item && typeof item === "object")
    .map((item) => (item.rationale ? `- ${item.summary || ""} (${item.rationale})` : `- ${item.summary || ""}`))
    .filter(Boolean);
  return rows.length ? rows : ["- none"];
}

function renderTodos(handoff) {
  if (!Array.isArray(handoff.todos) || !handoff.todos.length) return ["- none"];
  const rows = handoff.todos
    .filter((item) => item && typeof item === "object")
    .map((item) => {
      const priority = item.priority ? ` (priority: ${item.priority})` : "";
      return `- [${item.status || "pending"}] ${item.summary || ""}${priority}`;
    })
    .filter(Boolean);
  return rows.length ? rows : ["- none"];
}

module.exports = {
  buildContextQuery,
  countThreadFiles,
  countTranscriptRecords,
  extractRecords,
  readHandoff,
  readLatest,
  readMemory,
  renderContextPack,
  renderExtractResults,
  renderSearchResults,
  renderStatus,
  resolveMemoryDir,
  resolveRepoPath,
  searchRaw,
};
