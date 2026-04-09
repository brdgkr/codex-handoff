const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { withHiddenWindows } = require("./child-process");

function parseR2Credentials(text) {
  const stripped = String(text || "").trim();
  if (!stripped) {
    throw new Error("Credential source is empty.");
  }
  try {
    const payload = JSON.parse(stripped);
    if (payload && typeof payload === "object") {
      return normalizeFields(payload);
    }
  } catch {
    // Fall back to key=value parsing.
  }
  const items = {};
  for (const line of stripped.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z0-9_.-]+)\s*[:=]\s*(.+)$/);
    if (!match) continue;
    items[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
  }
  return normalizeFields(items);
}

function readR2CredentialsFromDotenv(filePath) {
  return parseR2Credentials(fs.readFileSync(path.resolve(filePath), "utf8"));
}

function readR2CredentialsFromEnv(env = process.env) {
  const aliases = {
    account_id: ["CODEX_HANDOFF_R2_ACCOUNT_ID", "CLOUDFLARE_ACCOUNT_ID", "R2_ACCOUNT_ID"],
    bucket: ["CODEX_HANDOFF_R2_BUCKET", "R2_BUCKET", "AWS_BUCKET", "BUCKET"],
    access_key_id: ["CODEX_HANDOFF_R2_ACCESS_KEY_ID", "R2_ACCESS_KEY_ID", "AWS_ACCESS_KEY_ID"],
    secret_access_key: ["CODEX_HANDOFF_R2_SECRET_ACCESS_KEY", "R2_SECRET_ACCESS_KEY", "AWS_SECRET_ACCESS_KEY"],
    endpoint: ["CODEX_HANDOFF_R2_ENDPOINT", "R2_ENDPOINT", "AWS_ENDPOINT_URL_S3", "AWS_ENDPOINT_URL"],
  };
  const payload = {};
  const missing = [];
  for (const [field, names] of Object.entries(aliases)) {
    const value = names.map((name) => env[name]).find(Boolean);
    if (value) payload[field] = String(value).trim();
    else if (field !== "endpoint") missing.push(field);
  }
  if (missing.length) {
    throw new Error(`Missing R2 credentials in environment: ${missing.join(", ")}`);
  }
  if (!payload.endpoint) payload.endpoint = `https://${payload.account_id}.r2.cloudflarestorage.com`;
  return payload;
}

function readClipboardText() {
  if (process.platform === "darwin") {
    const result = spawnSync("pbpaste", { encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr.trim() || "Failed to read clipboard.");
    return result.stdout || "";
  }
  if (process.platform === "win32") {
    const result = spawnSync(
      "powershell",
      ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $text = Get-Clipboard -Raw; if ($null -eq $text) { '' } else { $text }"],
      withHiddenWindows({ encoding: "utf8" }),
    );
    if (result.status !== 0) throw new Error(result.stderr.trim() || "Failed to read clipboard.");
    return result.stdout || "";
  }
  throw new Error("Clipboard-based R2 auth is supported on Windows and macOS only.");
}

function normalizeFields(items) {
  const normalized = {};
  const aliases = {
    account_id: new Set(["account_id", "account-id", "cloudflare_account_id", "r2_account_id", "codex_handoff_r2_account_id", "cloudflare_account_id", "r2_account_id"]),
    bucket: new Set(["bucket", "bucket_name", "bucket-name", "r2_bucket", "codex_handoff_r2_bucket", "r2_bucket", "aws_bucket"]),
    access_key_id: new Set(["access_key_id", "access-key-id", "aws_access_key_id", "r2_access_key_id", "codex_handoff_r2_access_key_id", "aws_access_key_id", "r2_access_key_id"]),
    secret_access_key: new Set(["secret_access_key", "secret-access-key", "aws_secret_access_key", "r2_secret_access_key", "codex_handoff_r2_secret_access_key", "aws_secret_access_key", "r2_secret_access_key"]),
    endpoint: new Set(["endpoint", "r2_endpoint", "aws_endpoint_url", "aws_endpoint_url_s3", "codex_handoff_r2_endpoint"]),
  };
  for (const [rawKey, rawValue] of Object.entries(items)) {
    const key = rawKey.toLowerCase();
    const value = String(rawValue).trim();
    for (const [field, names] of Object.entries(aliases)) {
      if (names.has(key)) {
        normalized[field] = value;
      }
    }
  }
  if (!normalized.endpoint && normalized.account_id) {
    normalized.endpoint = `https://${normalized.account_id}.r2.cloudflarestorage.com`;
  }
  return normalized;
}

module.exports = {
  parseR2Credentials,
  readClipboardText,
  readR2CredentialsFromDotenv,
  readR2CredentialsFromEnv,
};
