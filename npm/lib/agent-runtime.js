const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const { withHiddenWindows } = require("./child-process");
const { agentServiceStatePath, readJsonFile } = require("../service/common");
const { findScriptProcessPids, forceTerminateProcess, isProcessRunning, terminateProcess, waitForProcessesExit } = require("./process-utils");

function serviceState(configDir) {
  return readJsonFile(agentServiceStatePath(configDir), null);
}

function clearServiceState(configDir) {
  try {
    fs.rmSync(agentServiceStatePath(configDir), { force: true });
  } catch {
    // Ignore cleanup failures.
  }
}

function startAgentService({ configDir, codexHome, cwd = process.cwd() }) {
  clearServiceState(configDir);
  const packageRoot = path.resolve(__dirname, "..", "..");
  const command = process.execPath;
  const args = [path.join(packageRoot, "npm", "service", "agent_service.js"), "--config-dir", configDir, "--codex-home", codexHome];
  const child = spawn(command, args, {
    cwd,
    detached: true,
    stdio: "ignore",
    ...withHiddenWindows(),
  });
  child.unref();
  return { command, args, pid: child.pid };
}

async function stopAgentService(configDir, { timeoutMs = 5000 } = {}) {
  const state = serviceState(configDir);
  const pids = new Set();
  if (state?.pid) {
    pids.add(state.pid);
  }
  for (const pid of findScriptProcessPids("agent_service.js", { configDir })) {
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
  clearServiceState(configDir);
  return {
    stopped: waitResult.exited,
    running: !waitResult.exited,
    pid: state?.pid || null,
    stopped_pids: [...pids].sort((a, b) => a - b),
    remaining_pids: waitResult.remaining,
  };
}

module.exports = {
  clearServiceState,
  isRunning: isProcessRunning,
  serviceState,
  startAgentService,
  stopAgentService,
};
