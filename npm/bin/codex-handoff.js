#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const path = require("node:path");
const process = require("node:process");

const packageRoot = path.resolve(__dirname, "..", "..");
const args = process.argv.slice(2);

function pythonCandidates() {
  const override = process.env.CODEX_HANDOFF_PYTHON;
  const candidates = [];
  if (override) {
    candidates.push({ command: override, args: [] });
  }
  if (process.platform === "win32") {
    candidates.push({ command: "py", args: ["-3"] });
    candidates.push({ command: "python", args: [] });
    candidates.push({ command: "python3", args: [] });
  } else {
    candidates.push({ command: "python3", args: [] });
    candidates.push({ command: "python", args: [] });
  }
  return candidates;
}

function buildEnv() {
  const env = { ...process.env };
  const current = env.PYTHONPATH;
  env.PYTHONPATH = current ? `${packageRoot}${path.delimiter}${current}` : packageRoot;
  return env;
}

function runWith(candidate) {
  const result = spawnSync(
    candidate.command,
    [...candidate.args, "-m", "codex_handoff", ...args],
    {
      cwd: process.cwd(),
      env: buildEnv(),
      stdio: "inherit"
    }
  );
  if (result.error) {
    return { ok: false, code: 1 };
  }
  return { ok: true, code: result.status ?? 0 };
}

for (const candidate of pythonCandidates()) {
  const outcome = runWith(candidate);
  if (outcome.ok) {
    process.exit(outcome.code);
  }
}

console.error("codex-handoff could not find a usable Python runtime. Set CODEX_HANDOFF_PYTHON or install Python 3.");
process.exit(1);
