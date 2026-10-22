#!/usr/bin/env node
import { createServer } from "node:http";

const args = process.argv.slice(2);
if (process.env.FAKE_PROXY_HANG_HELP === "1" && args.includes("-h")) {
  setInterval(() => {}, 60_000);
  await new Promise(() => {});
} else if (process.env.FAKE_PROXY_NO_HELP === "1" && (args.includes("-h") || args.includes("--help") || args[0] === "help")) {
  process.exit(0);
} else if (args.includes("-h") || args.includes("--help") || args[0] === "help") {
  process.stdout.write(
    [
      "Usage:",
      "  -listen host:port",
      "  --listen host:port",
      "  -addr host:port",
      "  -control host:port",
      "  --control host:port",
      "  -upstream spec",
      "  --upstream spec",
      "  -control-token token",
      "  --control-token token",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

function flag(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

const controlListen =
  flag("-control") || flag("--control") || process.env.LLMENTARY_CONTROL_LISTEN || "";
const [host, portText] = controlListen.split(":");
const port = Number(portText);
if (!host || !Number.isFinite(port)) {
  process.stderr.write("fake-proxy: missing -control host:port\n");
  process.exit(2);
}

const token = flag("-control-token") || flag("--control-token") || process.env.LLMENTARY_CONTROL_TOKEN;
const ignoreTerm = process.env.FAKE_PROXY_IGNORE_TERM === "1";

const server = createServer((req, res) => {
  if (req.url === "/healthz") {
    if (token && req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401);
      res.end("unauthorized");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(port, host, () => {
  process.stdout.write(`fake-proxy listening control=${controlListen}\n`);
  process.stderr.write(`fake-proxy stderr ready\n`);
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on("SIGTERM", () => {
  if (ignoreTerm) return;
  shutdown();
});
process.on("SIGINT", shutdown);
