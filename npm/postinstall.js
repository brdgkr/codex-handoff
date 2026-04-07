#!/usr/bin/env node

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const packageRoot = path.resolve(__dirname, "..");
const sourceSkillDir = path.join(packageRoot, "skills", "codex-handoff");

function resolveSkillsDir() {
  if (process.env.CODEX_HANDOFF_SKILLS_DIR) {
    return path.resolve(process.env.CODEX_HANDOFF_SKILLS_DIR);
  }
  return path.join(os.homedir(), ".codex", "skills");
}

function resolveCodexBinDir() {
  if (process.env.CODEX_HANDOFF_CODEX_BIN_DIR) {
    return path.resolve(process.env.CODEX_HANDOFF_CODEX_BIN_DIR);
  }
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(localAppData, "OpenAI", "Codex", "bin");
}

function resolveGlobalNpmBinDir() {
  if (process.platform !== "win32") {
    return null;
  }
  const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  return path.join(appData, "npm");
}

function copySkill() {
  if (!fs.existsSync(sourceSkillDir)) {
    console.warn(`[codex-handoff] Bundled skill not found at ${sourceSkillDir}`);
    return;
  }
  const targetRoot = resolveSkillsDir();
  const targetSkillDir = path.join(targetRoot, "codex-handoff");
  fs.mkdirSync(targetRoot, { recursive: true });
  fs.rmSync(targetSkillDir, { recursive: true, force: true });
  fs.cpSync(sourceSkillDir, targetSkillDir, { recursive: true });
  console.log(`[codex-handoff] Installed skill to ${targetSkillDir}`);
}

function installCodexBinWrappers() {
  const targetDirs = [resolveCodexBinDir(), resolveGlobalNpmBinDir()].filter(Boolean);
  const nodePath = process.execPath;
  const cliScript = path.join(packageRoot, "npm", "bin", "codex-handoff.js");
  for (const binDir of targetDirs) {
    installWrapperSet(binDir, nodePath, cliScript);
    console.log(`[codex-handoff] Installed Codex bin wrappers to ${binDir}`);
  }
}

function installWrapperSet(binDir, nodePath, cliScript) {
  fs.mkdirSync(binDir, { recursive: true });
  const vbsPath = path.join(binDir, "codex-handoff.vbs");
  fs.writeFileSync(vbsPath, buildHiddenVbsLauncher(nodePath, cliScript), "utf8");
  const exePath = path.join(binDir, "codex-handoff.exe");
  if (fs.existsSync(exePath)) {
    fs.rmSync(exePath, { force: true });
  }

  const cmdPath = path.join(binDir, "codex-handoff.cmd");
  const cmdBody = `@ECHO OFF\r\nwscript.exe //B //NoLogo "%~dp0codex-handoff.vbs" %*\r\n`;
  fs.writeFileSync(cmdPath, cmdBody, "utf8");

  const ps1Path = path.join(binDir, "codex-handoff.ps1");
  const ps1Body = `#!/usr/bin/env pwsh\n& wscript.exe //B //NoLogo "$PSScriptRoot\\codex-handoff.vbs" $args\n`;
  fs.writeFileSync(ps1Path, ps1Body, "utf8");
}

function buildHiddenVbsLauncher(nodePath, cliScript) {
  const command = `"${nodePath}" "${cliScript}"`;
  return [
    "Option Explicit",
    "Dim shell, command, i",
    'Set shell = CreateObject("WScript.Shell")',
    `command = ${quoteVbsString(command)}`,
    "For i = 0 To WScript.Arguments.Count - 1",
    '  command = command & " " & QuoteArg(WScript.Arguments.Item(i))',
    "Next",
    "shell.Run command, 0, False",
    "",
    "Function QuoteArg(value)",
    '  QuoteArg = Chr(34) & Replace(value, Chr(34), Chr(34) & Chr(34)) & Chr(34)',
    "End Function",
    "",
  ].join("\r\n");
}

function quoteVbsString(value) {
  return `"${value.replace(/"/g, '""')}"`;
}

copySkill();
installCodexBinWrappers();
