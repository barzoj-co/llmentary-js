module.exports = {
  testEnvironment: "node",
  testMatch: ["<rootDir>/tests/jest/**/*.test.cjs"],
  testPathIgnorePatterns: ["/node_modules/", "concurrent-hold"],
  setupFilesAfterEnv: ["<rootDir>/dist/cjs/jest/setup.js"],
};
