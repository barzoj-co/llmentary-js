const { existsSync, mkdirSync, writeFileSync } = require("node:fs");
const { stat } = require("node:fs/promises");
const { dirname } = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { ControlClient } = require("../../dist/cjs/index.js");
const { readState, statePath } = require("../../dist/cjs/jest/state.js");

test("holds the owned proxy until the parent writes the stop file", async () => {
  const handshakePath = process.env.LLMTESTLAB_CONCURRENT_HANDSHAKE;
  const stopPath = process.env.LLMTESTLAB_CONCURRENT_STOP;
  if (!handshakePath || !stopPath) {
    throw new Error("LLMTESTLAB_CONCURRENT_HANDSHAKE and LLMTESTLAB_CONCURRENT_STOP are required.");
  }
  const state = await readState();
  const path = statePath();
  const fileStat = await stat(path);
  const dirStat = await stat(dirname(path));
  mkdirSync(dirname(handshakePath), { recursive: true });
  writeFileSync(
    handshakePath,
    `${JSON.stringify({
      runId: state.runId,
      statePath: path,
      proxyUrl: state.proxyUrl,
      controlUrl: state.controlUrl,
      pid: state.pid,
      instanceId: state.instanceId,
      stateMode: fileStat.mode & 0o777,
      dirMode: dirStat.mode & 0o777,
    })}\n`,
  );
  const health = await new ControlClient({ controlUrl: state.controlUrl }).health();
  expect(health).toBe("ok");
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && !existsSync(stopPath)) {
    await delay(50);
  }
  expect(existsSync(stopPath)).toBe(true);
  expect(await new ControlClient({ controlUrl: state.controlUrl }).health()).toBe("ok");
}, 70_000);
