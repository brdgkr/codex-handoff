const fs = require("node:fs");
const path = require("node:path");

const { resolveConfigDir } = require("../service/common");
const {
  parseR2Credentials,
  readClipboardText,
  readR2CredentialsFromDotenv,
  readR2CredentialsFromEnv,
} = require("./remote-auth");

const REQUIRED_R2_FIELDS = ["account_id", "bucket", "access_key_id", "secret_access_key"];
const DEFAULT_REMOTE_AUTH_TYPE = "global_dotenv";
const DEFAULT_REMOTE_AUTH_PATH = "~/.codex-handoff/.env.local";

function repoDotenvPath(_memoryDir = null, configDir = resolveConfigDir()) {
  return path.join(path.resolve(configDir), ".env.local");
}

function ensureRepoDotenvTemplate(memoryDir, configDir = resolveConfigDir()) {
  const filePath = repoDotenvPath(memoryDir, configDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, renderRepoDotenvTemplate(), "utf8");
  }
  return filePath;
}

function clearRepoR2Profile(memoryDir, configDir = resolveConfigDir()) {
  const filePath = repoDotenvPath(memoryDir, configDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, renderRepoDotenvTemplate(), "utf8");
  return filePath;
}

function saveRepoR2Profile(memoryDir, creds, configDir = resolveConfigDir()) {
  const normalized = normalizeR2Profile(creds);
  const filePath = repoDotenvPath(memoryDir, configDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, renderRepoDotenv(normalized), "utf8");
  return filePath;
}

function loadRepoR2Profile(memoryDir, configDir = resolveConfigDir()) {
  const filePath = repoDotenvPath(memoryDir, configDir);
  if (!fs.existsSync(filePath)) {
    ensureRepoDotenvTemplate(memoryDir, configDir);
    throw new Error(`R2 credentials file not found: ${filePath}`);
  }
  const normalized = normalizeR2Profile(readR2CredentialsFromDotenv(filePath), {
    sourceLabel: filePath,
  });
  return {
    ...normalized,
    region: "auto",
    memory_prefix: "projects/",
  };
}

function repoR2ProfileStatus(memoryDir, configDir = resolveConfigDir()) {
  const filePath = repoDotenvPath(memoryDir, configDir);
  if (!fs.existsSync(filePath)) {
    return {
      dotenv_path: filePath,
      exists: false,
      valid: false,
      missing_fields: [...REQUIRED_R2_FIELDS],
    };
  }
  try {
    const parsed = readR2CredentialsFromDotenv(filePath);
    return {
      dotenv_path: filePath,
      exists: true,
      valid: missingR2Fields(parsed).length === 0,
      missing_fields: missingR2Fields(parsed),
      account_id: parsed.account_id || "",
      bucket: parsed.bucket || "",
      endpoint: parsed.endpoint || "",
      access_key_id: parsed.access_key_id || "",
    };
  } catch (error) {
    return {
      dotenv_path: filePath,
      exists: true,
      valid: false,
      missing_fields: [...REQUIRED_R2_FIELDS],
      error: error.message,
    };
  }
}

function readR2CredentialsForSource(source, args, memoryDir, env = process.env, configDir = resolveConfigDir()) {
  if (source === "clipboard") {
    return parseR2Credentials(readClipboardText());
  }
  if (source === "env") {
    return readR2CredentialsFromEnv(env);
  }
  if (source === "dotenv") {
    const filePath = args.dotenv || ensureRepoDotenvTemplate(memoryDir, configDir);
    return readR2CredentialsFromDotenv(filePath);
  }
  throw new Error(`Unsupported auth source: ${source}`);
}

function missingR2Fields(creds) {
  return REQUIRED_R2_FIELDS.filter((field) => !String(creds?.[field] || "").trim());
}

function normalizeR2Profile(creds, { sourceLabel = "R2 credentials" } = {}) {
  const normalized = {
    account_id: String(creds?.account_id || "").trim(),
    bucket: String(creds?.bucket || "").trim(),
    access_key_id: String(creds?.access_key_id || "").trim(),
    secret_access_key: String(creds?.secret_access_key || "").trim(),
    endpoint: String(creds?.endpoint || "").trim(),
  };
  if (!normalized.endpoint && normalized.account_id) {
    normalized.endpoint = `https://${normalized.account_id}.r2.cloudflarestorage.com`;
  }
  const missing = missingR2Fields(normalized);
  if (missing.length) {
    throw new Error(`Missing R2 credentials in ${sourceLabel}: ${missing.join(", ")}`);
  }
  return normalized;
}

function renderRepoDotenvTemplate() {
  return [
    "# Cloudflare R2 credentials for codex-handoff",
    "account_id=",
    "bucket=",
    "access_key_id=",
    "secret_access_key=",
    "# endpoint=https://<account_id>.r2.cloudflarestorage.com",
    "",
  ].join("\n");
}

function renderRepoDotenv(creds) {
  return [
    "# Cloudflare R2 credentials for codex-handoff",
    `account_id=${creds.account_id}`,
    `bucket=${creds.bucket}`,
    `access_key_id=${creds.access_key_id}`,
    `secret_access_key=${creds.secret_access_key}`,
    `endpoint=${creds.endpoint}`,
    "",
  ].join("\n");
}

module.exports = {
  DEFAULT_REMOTE_AUTH_PATH,
  DEFAULT_REMOTE_AUTH_TYPE,
  clearRepoR2Profile,
  ensureRepoDotenvTemplate,
  loadRepoR2Profile,
  readR2CredentialsForSource,
  repoDotenvPath,
  repoR2ProfileStatus,
  saveRepoR2Profile,
};
