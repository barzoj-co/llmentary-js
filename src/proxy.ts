import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { resolveBinary } from "./binary.js";
import { ControlClient } from "./control.js";
import type { ProxyHandle, ProxyLaunchOptions } from "./types.js";

export async function startProxy(options: ProxyLaunchOptions = {}): Promise<ProxyHandle> {
  if (options.proxyUrl ?? process.env.LLMTESTLAB_PROXY_URL) {
    const proxyUrl = trimTrailingSlash(options.proxyUrl ?? process.env.LLMTESTLAB_PROXY_URL ?? "");
    const controlUrl = trimTrailingSlash(options.controlUrl ?? process.env.LLMTESTLAB_CONTROL_URL ?? proxyUrl);
    const bearerToken = options.bearerToken ?? process.env.LLMTESTLAB_BEARER_TOKEN;
    await waitForHealth(controlUrl, bearerToken, options.healthTimeoutMs);
    return {
      proxyUrl,
      controlUrl,
      ...(bearerToken ? { bearerToken } : {}),
      async stop() {
        // Attached proxies are owned by the caller.
      },
    };
  }

  const binaryPath = options.binaryPath ?? (await resolveBinary());
  const host = options.host ?? process.env.LLMTESTLAB_HOST ?? "127.0.0.1";
  const port = options.port ?? (await getFreePort(host));
  const proxyUrl = `http://${host}:${port}`;
  const controlUrl = options.controlPort ? `http://${host}:${options.controlPort}` : proxyUrl;
  const controlListen = options.controlPort ? `${host}:${options.controlPort}` : undefined;
  const bearerToken = options.bearerToken ?? process.env.LLMTESTLAB_BEARER_TOKEN;
  const upstreamBaseUrl = options.upstreamBaseUrl ?? process.env.LLMTESTLAB_UPSTREAM_BASE_URL;
  const env = {
    ...process.env,
    ...options.env,
    LLMTESTLAB_PROXY_URL: proxyUrl,
    LLMTESTLAB_CONTROL_URL: controlUrl,
    ...(bearerToken ? { LLMTESTLAB_BEARER_TOKEN: bearerToken } : {}),
    ...(upstreamBaseUrl ? { LLMTESTLAB_UPSTREAM_BASE_URL: upstreamBaseUrl } : {}),
  };

  const argSets = await buildArgSets({
    binaryPath,
    host,
    port,
    controlUrl,
    ...(controlListen ? { controlListen } : {}),
    ...(upstreamBaseUrl ? { upstreamBaseUrl } : {}),
    ...(bearerToken ? { bearerToken } : {}),
    ...(options.args ? { extraArgs: options.args } : {}),
  });
  let lastError: Error | undefined;
  for (const args of argSets) {
    const logs: string[] = [];
    const child = spawn(binaryPath, args, { env });
    wireLogs(child, (line) => {
      logs.push(line);
      options.log?.(line);
    });
    try {
      await waitForHealth(controlUrl, bearerToken, options.healthTimeoutMs, child, logs);
      return {
        proxyUrl,
        controlUrl,
        ...(bearerToken ? { bearerToken } : {}),
        ...(child.pid ? { pid: child.pid } : {}),
        async stop() {
          await stopChild(child);
        },
      };
    } catch (error) {
      const detail = logs.length ? `\nproxy output:\n${logs.join("\n")}` : "";
      lastError = new Error(`${error instanceof Error ? error.message : String(error)} (args: ${JSON.stringify(args)})${detail}`);
      await stopChild(child);
    }
  }
  throw new Error(
    `Failed to start llm-test-lab proxy with known CLI argument forms. ${lastError?.message ?? ""}\n` +
      "If the Go binary uses different flags, set LLMTESTLAB_PROXY_URL to attach to a running proxy or pass args/start options explicitly.",
  );
}

export async function waitForHealth(
  controlUrl: string,
  bearerToken?: string,
  timeoutMs = 10_000,
  child?: ChildProcessWithoutNullStreams,
  logs: string[] = [],
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const client = new ControlClient({ controlUrl, ...(bearerToken ? { bearerToken } : {}) });
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) {
      throw new Error(
        `llm-test-lab proxy exited before becoming healthy (exit ${child.exitCode}). ${logs.join("\n")}`.trim(),
      );
    }
    try {
      await client.health();
      return;
    } catch (error) {
      lastError = error;
      await delay(100);
    }
  }
  throw new Error(`Timed out waiting for llm-test-lab /healthz at ${controlUrl}: ${String(lastError)}`);
}

async function getFreePort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Could not allocate a TCP port."));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

interface ArgSetOptions {
  binaryPath: string;
  host: string;
  port: number;
  controlUrl: string;
  controlListen?: string;
  upstreamBaseUrl?: string;
  bearerToken?: string;
  extraArgs?: string[];
}

async function buildArgSets(options: ArgSetOptions): Promise<string[][]> {
  if (options.extraArgs?.length) return [options.extraArgs];
  if (process.env.LLMTESTLAB_PROXY_START_ARGS) return [splitArgs(process.env.LLMTESTLAB_PROXY_START_ARGS)];
  const listen = `${options.host}:${options.port}`;
  const listenPort = `:${options.port}`;
  const detected = await detectArgsFromHelp(options.binaryPath, {
    listen,
    listenPort,
    ...(options.upstreamBaseUrl ? { upstreamBaseUrl: options.upstreamBaseUrl } : {}),
    ...(options.bearerToken ? { bearerToken: options.bearerToken } : {}),
    ...(options.controlListen ? { controlListen: options.controlListen } : {}),
  });
  const args: string[] = ["--listen", listen];
  const serveArgs: string[] = ["serve", "--listen", listen];
  const proxyAddrArgs: string[] = ["serve", "--proxy-addr", listen];
  const addrArgs: string[] = ["--addr", listen];
  const control = options.controlListen ? ["--control-listen", options.controlListen] : [];
  const controlAddr = options.controlListen ? ["--control-addr", options.controlListen] : [];
  const upstream = options.upstreamBaseUrl ? ["--upstream-base-url", options.upstreamBaseUrl] : [];
  const upstreamAlt = options.upstreamBaseUrl ? ["--upstream-url", options.upstreamBaseUrl] : [];
  const upstreamShort = options.upstreamBaseUrl ? ["--upstream", options.upstreamBaseUrl] : [];
  const token = options.bearerToken ? ["--bearer-token", options.bearerToken] : [];
  return uniqueArgSets([
    ...detected,
    [...serveArgs, ...control, ...upstream, ...token],
    [...args, ...control, ...upstream, ...token],
    [...addrArgs, ...control, ...upstream, ...token],
    [...proxyAddrArgs, ...controlAddr, ...upstream, ...token],
    [...serveArgs, ...control, ...upstreamAlt, ...token],
    [...args, ...control, ...upstreamAlt, ...token],
    [...serveArgs, ...control, ...upstreamShort, ...token],
    [...args, ...control, ...upstreamShort, ...token],
    ["serve", "--listen", listenPort, ...upstreamShort],
    ["--listen", listenPort, ...upstreamShort],
    [],
  ]);
}

function uniqueArgSets(sets: string[][]): string[][] {
  const seen = new Set<string>();
  const out: string[][] = [];
  for (const set of sets) {
    const key = JSON.stringify(set);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(set);
  }
  return out;
}

async function detectArgsFromHelp(
  binaryPath: string,
  options: { listen: string; listenPort: string; upstreamBaseUrl?: string; bearerToken?: string; controlListen?: string },
): Promise<string[][]> {
  const help = await readHelp(binaryPath);
  if (!help) return [];
  const listenFlag = flagFromHelp(help, ["--listen", "--addr", "--bind", "--http", "--proxy-addr", "--listen-addr"]);
  const upstreamFlag = flagFromHelp(help, ["--upstream-base-url", "--upstream-url", "--upstream", "--openai-url", "--base-url"]);
  const tokenFlag = flagFromHelp(help, ["--bearer-token", "--token", "--auth-token"]);
  const controlFlag = flagFromHelp(help, ["--control-listen", "--control-addr", "--control"]);
  if (!listenFlag && !upstreamFlag) return [];
  const args: string[] = [];
  if (listenFlag) args.push(listenFlag, options.listen);
  if (upstreamFlag && options.upstreamBaseUrl) args.push(upstreamFlag, options.upstreamBaseUrl);
  if (tokenFlag && options.bearerToken) args.push(tokenFlag, options.bearerToken);
  if (controlFlag && options.controlListen) args.push(controlFlag, options.controlListen);
  const servePrefix = /\bserve\b/.test(help) ? ["serve"] : [];
  return [args, [...servePrefix, ...args]];
}

function flagFromHelp(help: string, candidates: string[]): string | undefined {
  return candidates.find((flag) => help.includes(flag));
}

async function readHelp(binaryPath: string): Promise<string> {
  for (const args of [["--help"], ["-h"], ["help"]]) {
    const text = await capture(binaryPath, args);
    if (text.trim()) return text;
  }
  return "";
}

async function capture(binaryPath: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(binaryPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: string | Uint8Array) => chunks.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk: string | Uint8Array) => chunks.push(Buffer.from(chunk)));
    const finish = () => resolve(Buffer.concat(chunks).toString("utf8"));
    child.once("error", () => resolve(""));
    child.once("exit", finish);
    void delay(2_000).then(() => {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        finish();
      }
    });
  });
}

function splitArgs(value: string): string[] {
  return value.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((arg) => arg.replace(/^['"]|['"]$/g, "")) ?? [];
}

function wireLogs(child: ChildProcessWithoutNullStreams, log?: (line: string) => void): void {
  if (!log) return;
  child.stdout.on("data", (chunk) => {
    for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) log(line);
  });
  child.stderr.on("data", (chunk) => {
    for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) log(line);
  });
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise<boolean>((resolve) => child.once("exit", () => resolve(true))),
    delay(2_000).then(() => false),
  ]);
  if (!exited) {
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  }
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
