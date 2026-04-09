const test = require("node:test");
const assert = require("node:assert/strict");

const { detectCodexProcesses, isCodexAppProcess } = require("./process-utils");

test("detectCodexProcesses falls back to simple name matching when no command is available", () => {
  const detected = detectCodexProcesses([
    { pid: 101, name: "codex" },
    { pid: 102, name: "node" },
  ]);

  assert.deepEqual(detected, [{ pid: 101, name: "codex" }]);
});

test("isCodexAppProcess keeps the main macOS app process and rejects helper processes", () => {
  assert.equal(
    isCodexAppProcess({
      pid: 1,
      name: "codex",
      command: "/Applications/Codex.app/Contents/MacOS/Codex",
    }),
    true,
  );

  assert.equal(
    isCodexAppProcess({
      pid: 2,
      name: "codex",
      command: "/Applications/Codex.app/Contents/Resources/codex app-server --analytics-default-enabled",
    }),
    false,
  );

  assert.equal(
    isCodexAppProcess({
      pid: 3,
      name: "codex helper",
      command: "/Applications/Codex.app/Contents/Frameworks/Codex Helper.app/Contents/MacOS/Codex Helper --type=renderer",
    }),
    false,
  );
});

test("isCodexAppProcess rejects non-app codex binaries such as extension app-server processes", () => {
  assert.equal(
    isCodexAppProcess({
      pid: 4,
      name: "codex",
      command: "/Users/test/.cursor/extensions/openai.chatgpt/bin/macos-aarch64/codex app-server --analytics-default-enabled",
    }),
    false,
  );
});

test("isCodexAppProcess keeps only the Windows Store main Codex window process", () => {
  assert.equal(
    isCodexAppProcess({
      pid: 10,
      name: "Codex.exe",
      command: "\"C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.406.3494.0_x64__2p2nqsd0c76g0\\app\\Codex.exe\"",
    }),
    true,
  );

  assert.equal(
    isCodexAppProcess({
      pid: 11,
      name: "Codex.exe",
      command: "\"C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.406.3494.0_x64__2p2nqsd0c76g0\\app\\Codex.exe\" --type=renderer",
    }),
    false,
  );

  assert.equal(
    isCodexAppProcess({
      pid: 12,
      name: "codex.exe",
      command: "\"C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.406.3494.0_x64__2p2nqsd0c76g0\\app\\resources\\codex.exe\" app-server --analytics-default-enabled",
    }),
    false,
  );

  assert.equal(
    isCodexAppProcess({
      pid: 13,
      name: "codex.exe",
      command: "C:\\Users\\test\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\codex\\codex.exe",
    }),
    false,
  );
});

test("detectCodexProcesses keeps only visible Windows main app processes when window state is known", () => {
  const detected = detectCodexProcesses(
    [
      {
        pid: 20,
        name: "Codex.exe",
        command: "\"C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.406.3494.0_x64__2p2nqsd0c76g0\\app\\Codex.exe\"",
        hasVisibleWindow: true,
      },
      {
        pid: 21,
        name: "Codex.exe",
        command: "\"C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.406.3494.0_x64__2p2nqsd0c76g0\\app\\Codex.exe\"",
        hasVisibleWindow: false,
      },
      {
        pid: 22,
        name: "codex.exe",
        command: "C:\\Users\\test\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\codex\\codex.exe",
        hasVisibleWindow: true,
      },
    ],
    { platform: "win32" },
  );

  assert.deepEqual(detected, [
    {
      pid: 20,
      name: "Codex.exe",
      command: "\"C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.406.3494.0_x64__2p2nqsd0c76g0\\app\\Codex.exe\"",
      hasVisibleWindow: true,
    },
  ]);
});
