const fs = require("node:fs");
const path = require("node:path");

function readFileBufferIfExists(filePath) {
  try {
    return fs.readFileSync(filePath);
  } catch {
    return null;
  }
}

function writeBufferIfChanged(filePath, nextBuffer) {
  const buffer = Buffer.isBuffer(nextBuffer) ? nextBuffer : Buffer.from(nextBuffer || "");
  const current = readFileBufferIfExists(filePath);
  if (current && Buffer.compare(current, buffer) === 0) {
    return false;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, buffer);
  return true;
}

function writeUtf8FileIfChanged(filePath, content) {
  return writeBufferIfChanged(filePath, Buffer.from(String(content || ""), "utf8"));
}

function writeJsonFileIfChanged(filePath, payload) {
  return writeUtf8FileIfChanged(filePath, JSON.stringify(payload, null, 2) + "\n");
}

module.exports = {
  readFileBufferIfExists,
  writeBufferIfChanged,
  writeJsonFileIfChanged,
  writeUtf8FileIfChanged,
};
