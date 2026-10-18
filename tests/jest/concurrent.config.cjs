module.exports = {
  testEnvironment: "node",
  testMatch: ["<rootDir>/tests/jest/concurrent-hold.test.cjs"],
  globalSetup: "<rootDir>/dist/cjs/jest/globalSetup.js",
  globalTeardown: "<rootDir>/dist/cjs/jest/globalTeardown.js",
  setupFilesAfterEnv: ["<rootDir>/dist/cjs/jest/setup.js"],
};
