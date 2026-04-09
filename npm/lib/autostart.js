const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { withHiddenWindows } = require("./child-process");
const { configPath, readJsonFile, resolveConfigDir, runtimeDir } = require("../service/common");

const WINDOWS_TASK_NAME = "codex-handoff-agent";
const WINDOWS_RUN_VALUE = "codex-handoff-agent";
const MACOS_LABEL = "com.brdg.codex-handoff.agent";

function autostartPlatform() {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "macos";
  return "unsupported";
}

function launchAgentDirectory() {
  return path.join(os.homedir(), "Library", "LaunchAgents");
}

function startupFolderPath() {
  const appData = process.env.APPDATA;
  if (appData) {
    return path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
  }
  return path.join(os.homedir(), "AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
}

function windowsCommandScriptPath(configDir = resolveConfigDir()) {
  return path.join(runtimeDir(configDir), "autostart", "codex-handoff-agent.vbs");
}

function startupScriptPath() {
  return path.join(startupFolderPath(), "codex-handoff-agent.vbs");
}

function windowsRunKeyPath() {
  return "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
}

function macosCommandScriptPath(configDir = resolveConfigDir()) {
  return path.join(runtimeDir(configDir), "autostart", "codex-handoff-agent.sh");
}

function launchAgentPlistPath() {
  return path.join(launchAgentDirectory(), `${MACOS_LABEL}.plist`);
}

function autostartLogPath(configDir = resolveConfigDir()) {
  return path.join(configDir, "logs", "agent-service.log");
}

function enableAutostart({ codexHome, configDir = resolveConfigDir() }) {
  const platform = autostartPlatform();
  if (platform === "windows") return enableWindowsAutostart({ codexHome, configDir });
  if (platform === "macos") return enableMacosAutostart({ codexHome, configDir });
  throw new Error("Autostart registration is supported on Windows and macOS only.");
}

function disableAutostart(_repoSlug, configDir = resolveConfigDir()) {
  const platform = autostartPlatform();
  if (platform === "windows") return disableWindowsAutostart(configDir);
  if (platform === "macos") return disableMacosAutostart(configDir);
  throw new Error("Autostart registration is supported on Windows and macOS only.");
}

function autostartStatus(_repoSlug, configDir = resolveConfigDir()) {
  const platform = autostartPlatform();
  if (platform === "windows") return windowsAutostartStatus(configDir);
  if (platform === "macos") return macosAutostartStatus(configDir);
  return { task_name: WINDOWS_TASK_NAME, enabled: false, platform: "unsupported", platform_supported: false };
}

function enableWindowsAutostart({ codexHome, configDir }) {
  cleanupLegacyWindowsAutostart(configDir);
  const scriptPath = writeWindowsAutostartScript({ codexHome, configDir });
  const result = spawnSync("schtasks", [
    "/Create",
    "/SC",
    "ONLOGON",
    "/RL",
    "LIMITED",
    "/TN",
    WINDOWS_TASK_NAME,
    "/TR",
    `wscript.exe //B //NoLogo "${scriptPath}"`,
    "/F",
  ], withHiddenWindows({ encoding: "utf8" }));
  if (result.status === 0) {
    const startupPath = startupScriptPath();
    deleteWindowsRunEntry();
    if (fs.existsSync(startupPath)) {
      fs.rmSync(startupPath, { force: true });
    }
    return {
      task_name: WINDOWS_TASK_NAME,
      script_path: scriptPath,
      enabled: true,
      method: "task-scheduler",
      platform: "windows",
      platform_supported: true,
    };
  }
  const runResult = writeWindowsRunEntry(scriptPath);
  if (runResult.status === 0) {
    const startupPath = startupScriptPath();
    if (fs.existsSync(startupPath)) {
      fs.rmSync(startupPath, { force: true });
    }
    return {
      task_name: WINDOWS_TASK_NAME,
      script_path: scriptPath,
      enabled: true,
      method: "registry-run",
      platform: "windows",
      platform_supported: true,
      scheduler_error: result.stderr?.trim() || result.stdout?.trim() || "Failed to create Task Scheduler entry.",
    };
  }
  const startupPath = startupScriptPath();
  fs.mkdirSync(path.dirname(startupPath), { recursive: true });
  fs.writeFileSync(startupPath, fs.readFileSync(scriptPath, "utf8"), "utf8");
  return {
    task_name: WINDOWS_TASK_NAME,
    script_path: scriptPath,
    startup_path: startupPath,
    enabled: true,
    method: "startup-folder",
    platform: "windows",
    platform_supported: true,
    scheduler_error: result.stderr?.trim() || result.stdout?.trim() || "Failed to create Task Scheduler entry.",
    registry_error: runResult.stderr?.trim() || runResult.stdout?.trim() || "Failed to create registry Run entry.",
  };
}

function disableWindowsAutostart(configDir) {
  cleanupLegacyWindowsAutostart(configDir);
  const result = spawnSync("schtasks", ["/Delete", "/TN", WINDOWS_TASK_NAME, "/F"], withHiddenWindows({ encoding: "utf8" }));
  const scriptPath = windowsCommandScriptPath(configDir);
  const startupPath = startupScriptPath();
  if (fs.existsSync(scriptPath)) fs.rmSync(scriptPath, { force: true });
  if (fs.existsSync(startupPath)) fs.rmSync(startupPath, { force: true });
  deleteWindowsRunEntry();
  return {
    task_name: WINDOWS_TASK_NAME,
    enabled: false,
    deleted: result.status === 0,
    startup_deleted: !fs.existsSync(startupPath),
    platform: "windows",
    platform_supported: true,
  };
}

function windowsAutostartStatus(configDir) {
  const result = spawnSync("schtasks", ["/Query", "/TN", WINDOWS_TASK_NAME], withHiddenWindows({ encoding: "utf8" }));
  const startupPath = startupScriptPath();
  const runEnabled = windowsRunEntryExists();
  return {
    task_name: WINDOWS_TASK_NAME,
    enabled: result.status === 0 || runEnabled || fs.existsSync(startupPath),
    method: result.status === 0 ? "task-scheduler" : (runEnabled ? "registry-run" : (fs.existsSync(startupPath) ? "startup-folder" : null)),
    script_path: windowsCommandScriptPath(configDir),
    startup_path: startupPath,
    platform: "windows",
    platform_supported: true,
  };
}

function enableMacosAutostart({ codexHome, configDir }) {
  const scriptPath = writeMacosAutostartScript({ codexHome, configDir });
  const plistPath = launchAgentPlistPath();
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  const plist = `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n` +
    `<plist version="1.0"><dict>` +
    `<key>Label</key><string>${xmlEscape(MACOS_LABEL)}</string>` +
    `<key>ProgramArguments</key><array><string>${xmlEscape(scriptPath)}</string></array>` +
    `<key>RunAtLoad</key><true/>` +
    `<key>ProcessType</key><string>Background</string>` +
    `</dict></plist>\n`;
  fs.writeFileSync(plistPath, plist, "utf8");
  return {
    task_name: MACOS_LABEL,
    launch_agent_path: plistPath,
    script_path: scriptPath,
    enabled: true,
    method: "launchd",
    platform: "macos",
    platform_supported: true,
  };
}

function disableMacosAutostart(configDir) {
  const plistPath = launchAgentPlistPath();
  const scriptPath = macosCommandScriptPath(configDir);
  const loaded = macosLaunchAgentLoaded(MACOS_LABEL);
  if (fs.existsSync(plistPath)) {
    runLaunchctl(["bootout", `gui/${process.getuid?.() || 0}`, plistPath]);
    fs.rmSync(plistPath, { force: true });
  }
  if (fs.existsSync(scriptPath)) fs.rmSync(scriptPath, { force: true });
  return {
    task_name: MACOS_LABEL,
    enabled: false,
    deleted: true,
    was_loaded: loaded,
    launch_agent_deleted: !fs.existsSync(plistPath),
    platform: "macos",
    platform_supported: true,
  };
}

function macosAutostartStatus(configDir) {
  const plistPath = launchAgentPlistPath();
  const enabled = fs.existsSync(plistPath);
  return {
    task_name: MACOS_LABEL,
    enabled,
    method: enabled ? "launchd" : null,
    script_path: macosCommandScriptPath(configDir),
    launch_agent_path: plistPath,
    loaded: enabled ? macosLaunchAgentLoaded(MACOS_LABEL) : false,
    platform: "macos",
    platform_supported: true,
  };
}

function writeWindowsAutostartScript({ codexHome, configDir }) {
  const scriptPath = windowsCommandScriptPath(configDir);
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  const command = buildAgentServiceCommand({ configDir, codexHome });
  const body = [
    "Dim shell",
    'Set shell = CreateObject("WScript.Shell")',
    `shell.Run "${vbscriptEscape(windowsQuoteArgs(command))}", 0, False`,
    "",
  ].join("\r\n");
  fs.writeFileSync(scriptPath, body, "utf8");
  return scriptPath;
}

function writeMacosAutostartScript({ codexHome, configDir }) {
  const scriptPath = macosCommandScriptPath(configDir);
  const logPath = autostartLogPath(configDir);
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const command = buildAgentServiceCommand({ configDir, codexHome });
  const lines = [
    "#!/bin/sh",
    `export CODEX_HANDOFF_CONFIG_DIR=${shellQuote(configDir)}`,
    `export CODEX_HOME=${shellQuote(codexHome)}`,
    `exec ${command.map((part) => shellQuote(part)).join(" ")} >> ${shellQuote(logPath)} 2>&1`,
    "",
  ];
  fs.writeFileSync(scriptPath, lines.join("\n"), "utf8");
  fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
}

function buildAgentServiceCommand({ configDir, codexHome }) {
  const packageRoot = path.resolve(__dirname, "..", "..");
  return [
    process.execPath,
    path.join(packageRoot, "npm", "service", "agent_service.js"),
    "--config-dir",
    configDir,
    "--codex-home",
    codexHome,
  ];
}

function runLaunchctl(args) {
  return spawnSync("launchctl", args, { encoding: "utf8" });
}

function macosLaunchAgentLoaded(label) {
  const uid = process.getuid?.() || 0;
  const result = runLaunchctl(["print", `gui/${uid}/${label}`]);
  return result.status === 0;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function windowsQuoteArgs(parts) {
  return parts.map((part) => {
    const text = String(part);
    if (!/[\s"]/u.test(text)) return text;
    return `"${text.replace(/"/g, '\\"')}"`;
  }).join(" ");
}

function vbscriptEscape(value) {
  return String(value).replace(/"/g, '""');
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

module.exports = {
  autostartStatus,
  disableAutostart,
  enableAutostart,
};

function cleanupLegacyWindowsAutostart(configDir) {
  const startupDir = path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
  const autostartDir = path.join(runtimeDir(configDir), "autostart");
  const config = readJsonFile(configPath(configDir), { repos: {} });
  const repoSlugs = [...new Set(Object.values(config.repos || {}).map((repo) => repo.repo_slug).filter(Boolean))];

  for (const repoSlug of repoSlugs) {
    const startupVbs = path.join(startupDir, `${repoSlug}.vbs`);
    const startupCmd = path.join(startupDir, `${repoSlug}.cmd`);
    const runtimeVbs = path.join(autostartDir, `${repoSlug}.vbs`);
    const runtimeCmd = path.join(autostartDir, `${repoSlug}.cmd`);
    for (const filePath of [startupVbs, startupCmd, runtimeVbs, runtimeCmd]) {
      if (fs.existsSync(filePath)) {
        fs.rmSync(filePath, { force: true });
      }
    }
    spawnSync("reg", ["delete", windowsRunKeyPath(), "/v", repoSlug, "/f"], withHiddenWindows({ encoding: "utf8" }));
    spawnSync("schtasks", ["/Delete", "/TN", `codex-handoff-${repoSlug}`, "/F"], withHiddenWindows({ encoding: "utf8" }));
  }
}

function writeWindowsRunEntry(scriptPath) {
  return spawnSync("reg", [
    "add",
    windowsRunKeyPath(),
    "/v",
    WINDOWS_RUN_VALUE,
    "/t",
    "REG_SZ",
    "/d",
    `wscript.exe //B //NoLogo "${scriptPath}"`,
    "/f",
  ], withHiddenWindows({ encoding: "utf8" }));
}

function deleteWindowsRunEntry() {
  return spawnSync("reg", [
    "delete",
    windowsRunKeyPath(),
    "/v",
    WINDOWS_RUN_VALUE,
    "/f",
  ], withHiddenWindows({ encoding: "utf8" }));
}

function windowsRunEntryExists() {
  const result = spawnSync("reg", ["query", windowsRunKeyPath(), "/v", WINDOWS_RUN_VALUE], withHiddenWindows({ encoding: "utf8" }));
  return result.status === 0;
}
