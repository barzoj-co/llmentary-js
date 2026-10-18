module.exports = {
  testEnvironment: "node",
  testMatch: ["<rootDir>/tests/jest/**/*.test.cjs"],
  setupFilesAfterEnv: ["<rootDir>/dist/cjs/jest/setup.js"],
};
