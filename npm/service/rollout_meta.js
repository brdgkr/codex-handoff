const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

function isRolloutPath(filePath) {
  const base = path.basename(filePath);
  return base.startsWith("rollout-") && base.endsWith(".jsonl");
}

async function readRolloutMeta(filePath) {
  if (!isRolloutPath(filePath)) {
    return null;
  }
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.trim()) {
        continue;
      }
      let payload;
      try {
        payload = JSON.parse(line);
      } catch {
        continue;
      }
      if (payload.type !== "session_meta" || !payload.payload) {
        continue;
      }
      return {
        threadId: payload.payload.id || null,
        cwd: payload.payload.cwd || null,
        git: payload.payload.git || null,
      };
    }
    return null;
  } catch {
    return null;
  } finally {
    rl.close();
    stream.destroy();
  }
}

async function readRolloutLastRecordSummary(filePath) {
  if (!isRolloutPath(filePath)) {
    return null;
  }
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let lastLine = null;
  try {
    for await (const line of rl) {
      if (!line.trim()) {
        continue;
      }
      lastLine = line;
    }
    if (!lastLine) {
      return null;
    }
    const record = JSON.parse(lastLine);
    return {
      timestamp: record.timestamp || null,
      recordType: record.type || null,
      payloadType: record.payload?.type || null,
      recordJson: JSON.stringify(record, ensureAsciiSafeReplacer),
    };
  } catch {
    return null;
  } finally {
    rl.close();
    stream.destroy();
  }
}

function ensureAsciiSafeReplacer(_key, value) {
  return value;
}

module.exports = {
  isRolloutPath,
  readRolloutLastRecordSummary,
  readRolloutMeta,
};
