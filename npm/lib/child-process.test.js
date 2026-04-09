const test = require("node:test");
const assert = require("node:assert/strict");

const { withHiddenWindows } = require("./child-process");

test("withHiddenWindows enables windowsHide on Windows", { skip: process.platform !== "win32" }, () => {
  assert.deepEqual(withHiddenWindows({ encoding: "utf8" }), {
    encoding: "utf8",
    windowsHide: true,
  });
});

test("withHiddenWindows leaves options unchanged on non-Windows", { skip: process.platform === "win32" }, () => {
  const options = { encoding: "utf8" };
  assert.equal(withHiddenWindows(options), options);
});
