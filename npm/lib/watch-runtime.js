const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const { withHiddenWindows } = require("./child-process");
const { readJsonFile, watchServiceStatePath } = require("../service/common");
const { findScriptProcessPids, forceTerminateProcess, isProcessRunning, terminateProcess, waitForProcessesExit } = require("./process-utils");

function watchServiceState(configDir) {
  return readJsonFile(watchServiceStatePath(configDir), null);
}

function clearWatchServiceState(configDir) {
  try {
    fs.rmSync(watchServiceStatePath(configDir), { force: true });
  } catch {
    // Ignore cleanup failures.
  }
}

function startWatchService({ configDir, codexHome, cwd = process.cwd() }) {
  clearWatchServiceState(configDir);
  const packageRoot = path.resolve(__dirname, "..", "..");
  const command = process.execPath;
  const args = [path.join(packageRoot, "npm", "service", "watch_service.js"), "--config-dir", configDir, "--codex-home", codexHome];
  const child = spawn(command, args, {
    cwd,
    detached: true,
    stdio: "ignore",
    ...withHiddenWindows(),
  });
  child.unref();
  return { command, args, pid: child.pid };
}

async function stopWatchService(configDir, { timeoutMs = 5000 } = {}) {
  const state = watchServiceState(configDir);
  const pids = new Set();
  if (state?.pid) {
    pids.add(state.pid);
  }
  for (const pid of findScriptProcessPids("watch_service.js", { configDir })) {
    pids.add(pid);
  }
  if (!pids.size) return { stopped: false, running: false };
  for (const pid of pids) {
    terminateProcess(pid);
  }
  let waitResult = await waitForProcessesExit([...pids], { timeoutMs });
  if (!waitResult.exited && waitResult.remaining.length) {
    for (const pid of waitResult.remaining) {
      forceTerminateProcess(pid);
    }
    waitResult = await waitForProcessesExit(waitResult.remaining, { timeoutMs: Math.min(timeoutMs, 2000) });
  }
  clearWatchServiceState(configDir);
  return {
    stopped: waitResult.exited,
    running: !waitResult.exited,
    pid: state?.pid || null,
    stopped_pids: [...pids].sort((a, b) => a - b),
    remaining_pids: waitResult.remaining,
  };
}

function isWatchServiceRunning(configDir) {
  const state = watchServiceState(configDir);
  if (state?.pid && isProcessRunning(state.pid)) {
    return true;
  }
  return findScriptProcessPids("watch_service.js", { configDir }).length > 0;
}

module.exports = {
  clearWatchServiceState,
  isWatchServiceRunning,
  startWatchService,
  stopWatchService,
  watchServiceState,
};
