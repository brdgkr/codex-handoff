const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function resolveConfigDir() {
  if (process.env.CODEX_HANDOFF_CONFIG_DIR) {
    return path.resolve(process.env.CODEX_HANDOFF_CONFIG_DIR);
  }
  return path.join(os.homedir(), ".codex-handoff");
}

function resolveCodexHome() {
  if (process.env.CODEX_HOME) {
    return path.resolve(process.env.CODEX_HOME);
  }
  return path.join(os.homedir(), ".codex");
}

function configPath(configDir = resolveConfigDir()) {
  return path.join(configDir, "config.json");
}

function runtimeDir(configDir = resolveConfigDir()) {
  return path.join(configDir, "runtime");
}

function agentServiceStatePath(configDir = resolveConfigDir()) {
  return path.join(runtimeDir(configDir), "agent-service.json");
}

function lifecycleLockPath(configDir = resolveConfigDir()) {
  return path.join(runtimeDir(configDir), "lifecycle.lock");
}

function installRestartStatePath(configDir = resolveConfigDir()) {
  return path.join(runtimeDir(configDir), "install-restart.json");
}

function watchServiceStatePath(configDir = resolveConfigDir()) {
  return path.join(runtimeDir(configDir), "watch-service.json");
}

function watchCursorStatePath(configDir = resolveConfigDir()) {
  return path.join(runtimeDir(configDir), "watch-cursors.json");
}

function packageRootFromHere(filename) {
  let current = path.resolve(path.dirname(filename));
  while (true) {
    if (fs.existsSync(path.join(current, "package.json"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return path.resolve(path.dirname(filename), "..", "..");
    }
    current = parent;
  }
}

function packageVersionFromHere(filename) {
  const packageRoot = packageRootFromHere(filename);
  return readJsonFile(path.join(packageRoot, "package.json"), {}).version || null;
}

function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function stripWindowsPrefix(value) {
  return value.startsWith("\\\\?\\") ? value.slice(4) : value;
}

function isWindowsStylePath(value) {
  return /^[A-Za-z]:[\\/]/.test(value);
}

function normalizeComparablePath(value) {
  const raw = stripWindowsPrefix(String(value || "").trim());
  if (!raw) {
    return "";
  }
  if (isWindowsStylePath(raw)) {
    return path.win32.normalize(raw).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  }
  return path.posix.normalize(raw.replace(/\\/g, "/")).replace(/\/+$/, "");
}

function canonicalizeRepoPath(value) {
  const raw = stripWindowsPrefix(String(value || "").trim());
  if (!raw) {
    return "";
  }
  if (isWindowsStylePath(raw)) {
    const normalized = path.win32.normalize(raw).replace(/[\\/]+$/, "");
    return normalized.replace(/^([a-z]):/u, (_, drive) => `${drive.toUpperCase()}:`);
  }
  return path.posix.normalize(raw.replace(/\\/g, "/")).replace(/\/+$/, "");
}

function isSameOrDescendantPath(candidatePath, parentPath) {
  if (!candidatePath || !parentPath) {
    return false;
  }
  if (candidatePath === parentPath) {
    return true;
  }
  return candidatePath.startsWith(`${parentPath}/`);
}

module.exports = {
  agentServiceStatePath,
  configPath,
  canonicalizeRepoPath,
  installRestartStatePath,
  isSameOrDescendantPath,
  lifecycleLockPath,
  normalizeComparablePath,
  packageRootFromHere,
  packageVersionFromHere,
  readJsonFile,
  resolveCodexHome,
  resolveConfigDir,
  runtimeDir,
  watchCursorStatePath,
  watchServiceStatePath,
};
