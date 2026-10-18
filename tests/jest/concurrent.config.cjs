const { join } = require("node:path");

const rootDir = join(__dirname, "../..");

module.exports = {
  rootDir,
  testEnvironment: "node",
  testMatch: [join(rootDir, "tests/jest/concurrent-hold.test.cjs")],
  globalSetup: join(rootDir, "dist/cjs/jest/globalSetup.js"),
  globalTeardown: join(rootDir, "dist/cjs/jest/globalTeardown.js"),
  setupFilesAfterEnv: [join(rootDir, "dist/cjs/jest/setup.js")],
};
