const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const packageJson = require("../../package.json");

const { packageRootFromHere, packageVersionFromHere } = require("./common");

test("packageRootFromHere resolves the package root from cli.js", () => {
  const cliPath = path.join(__dirname, "..", "cli.js");
  const root = packageRootFromHere(cliPath);

  assert.equal(root, path.join(__dirname, "..", ".."));
  assert.equal(packageVersionFromHere(cliPath), packageJson.version);
});
