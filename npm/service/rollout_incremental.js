const fs = require("node:fs");

async function readIncrementalJsonl(filePath, previousState) {
  const stat = fs.statSync(filePath);
  const previousRemainder = typeof previousState?.remainder === "string" ? previousState.remainder : "";
  const currentState = {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    remainder: previousRemainder,
  };

  if (!previousState) {
    const fullText = fs.readFileSync(filePath, "utf8");
    const parsed = splitCommittedLines(fullText);
    return {
      mode: "bootstrap",
      newLines: parsed.lines,
      nextState: {
        ...currentState,
        remainder: parsed.remainder,
      },
    };
  }

  if (stat.size < previousState.size) {
    const fullText = fs.readFileSync(filePath, "utf8");
    const parsed = splitCommittedLines(fullText);
    return {
      mode: "rewind",
      newLines: parsed.lines,
      nextState: {
        ...currentState,
        remainder: parsed.remainder,
      },
    };
  }

  if (stat.size === previousState.size) {
    return {
      mode: "unchanged",
      newLines: [],
      nextState: {
        ...currentState,
        remainder: previousRemainder,
      },
    };
  }

  const stream = fs.createReadStream(filePath, {
    encoding: "utf8",
    start: previousState.size,
    end: stat.size - 1,
  });
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  const parsed = splitCommittedLines(chunks.join(""), previousRemainder);
  return {
    mode: "append",
    newLines: parsed.lines,
    nextState: {
      ...currentState,
      remainder: parsed.remainder,
    },
  };
}

function splitCommittedLines(text, previousRemainder = "") {
  const combined = `${previousRemainder}${text}`;
  const parts = combined.split(/\r?\n/);
  const endsWithNewline = /\r?\n$/.test(combined);
  let remainder = "";
  if (!endsWithNewline) {
    remainder = parts.pop() || "";
  } else if (parts.length > 0 && parts[parts.length - 1] === "") {
    parts.pop();
  }
  return {
    lines: parts
      .map((line) => line.trimEnd())
      .filter((line) => line.trim().length > 0),
    remainder,
  };
}

module.exports = {
  readIncrementalJsonl,
};
