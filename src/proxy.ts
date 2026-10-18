import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { resolveBinary } from "./binary.js";
import { ControlClient } from "./control.js";
import type { ProxyHandle, ProxyLaunchOptions } from "./types.js";

const SECRET_FLAGS = new Set(["-control-token", "--control-token", "--bearer-token", "-bearer-token"]);

export function formatUpstreamSpec(name: string, url: string): string {
  const trimmed = url.trim();
  if (trimmed.includes("=")) {
    const separator = trimmed.indexOf("=");
    return `${sanitizeUpstreamName(trimmed.slice(0, separator))}=${trimmed.slice(separator + 1)}`;
  }
  return `${sanitizeUpstreamName(name)}=${trimmed}`;
}

function sanitizeUpstreamName(name: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error(`Invalid upstream name ${JSON.stringify(name)}; use letters, digits, dot, underscore, or hyphen.`);
  }
  return name;
}

function redactText(text: string, secret?: string): string {
  if (!secret) return text;
  return text.split(secret).join("***");
}

export function redactArgs(args: string[]): string[] {
  const redacted = [...args];
  for (let index = 0; index < redacted.length; index += 1) {
    if (SECRET_FLAGS.has(redacted[index] ?? "") && redacted[index + 1] !== undefined) {
      redacted[index + 1] = "***";
    }
  }
  return redacted;
}

export async function startProxy(options: ProxyLaunchOptions = {}): Promise<ProxyHandle> {
  if (options.proxyUrl ?? process.env.LLMTESTLAB_PROXY_URL) {
    const proxyUrl = trimTrailingSlash(options.proxyUrl ?? process.env.LLMTESTLAB_PROXY_URL ?? "");
    const controlUrl = trimTrailingSlash(options.controlUrl ?? process.env.LLMTESTLAB_CONTROL_URL ?? proxyUrl);
    const bearerToken = options.bearerToken ?? process.env.LLMTESTLAB_BEARER_TOKEN ?? process.env.LLMTESTLAB_CONTROL_TOKEN;
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
  const reserved = await getFreePorts(host, 2);
  const port = options.port ?? reserved[0]!;
  const controlPort = options.controlPort ?? reserved.find((candidate) => candidate !== port) ?? reserved[1]!;
  if (controlPort === port) {
    throw new Error("proxy listen port and control port must be different; the Go binary serves /healthz on -control.");
  }
  const proxyUrl = `http://${host}:${port}`;
  const controlUrl = `http://${host}:${controlPort}`;
  const controlListen = `${host}:${controlPort}`;
  const bearerToken = options.bearerToken ?? process.env.LLMTESTLAB_BEARER_TOKEN ?? process.env.LLMTESTLAB_CONTROL_TOKEN;
  const upstreamName = options.upstreamName ?? process.env.LLMTESTLAB_UPSTREAM_NAME ?? "openai";
  const upstreamBaseUrl = options.upstreamBaseUrl ?? process.env.LLMTESTLAB_UPSTREAM_BASE_URL;
  const upstreamSpec =
    options.upstreams ??
    process.env.LLMTESTLAB_UPSTREAMS ??
    (upstreamBaseUrl ? formatUpstreamSpec(upstreamName, upstreamBaseUrl) : undefined);
  if (!upstreamSpec && !options.args?.length && !process.env.LLMTESTLAB_PROXY_START_ARGS) {
    throw new Error(
      "startProxy requires an upstream. Pass upstreamBaseUrl (or upstreams / LLMTESTLAB_UPSTREAMS) as name=https://host/base.",
    );
  }

  const env = {
    ...process.env,
    ...options.env,
    LLMTESTLAB_LISTEN: `${host}:${port}`,
    LLMTESTLAB_CONTROL_LISTEN: controlListen,
    LLMTESTLAB_PROXY_URL: proxyUrl,
    LLMTESTLAB_CONTROL_URL: controlUrl,
    LLMTESTLAB_UPSTREAM_NAME: upstreamName,
    ...(upstreamSpec ? { LLMTESTLAB_UPSTREAMS: upstreamSpec } : {}),
    ...(bearerToken
      ? { LLMTESTLAB_BEARER_TOKEN: bearerToken, LLMTESTLAB_CONTROL_TOKEN: bearerToken }
      : {}),
  };

  const argSets = await buildArgSets({
    binaryPath,
    host,
    port,
    controlListen,
    ...(upstreamSpec ? { upstreamSpec } : {}),
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
      const detail = logs.length ? `\nproxy output:\n${redactText(logs.join("\n"), bearerToken)}` : "";
      lastError = new Error(
        `${redactText(error instanceof Error ? error.message : String(error), bearerToken)} (args: ${JSON.stringify(redactArgs(args))})${detail}`,
      );
      await stopChild(child);
    }
  }
  throw new Error(
    `Failed to start llm-test-lab proxy with known CLI argument forms. ${lastError?.message ?? ""}\n` +
      "If the Go binary uses different flags, set LLMTESTLAB_PROXY_URL and LLMTESTLAB_CONTROL_URL to attach to a running proxy or pass args/start options explicitly.",
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
        redactText(
          `llm-test-lab proxy exited before becoming healthy (exit ${child.exitCode}). ${logs.join("\n")}`.trim(),
          bearerToken,
        ),
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

async function getFreePorts(host: string, count: number): Promise<number[]> {
  const servers: ReturnType<typeof createServer>[] = [];
  const ports: number[] = [];
  try {
    for (let index = 0; index < count; index += 1) {
      const port = await new Promise<number>((resolve, reject) => {
        const server = createServer();
        server.unref();
        server.once("error", reject);
        server.listen(0, host, () => {
          const address = server.address();
          if (!address || typeof address === "string") {
            reject(new Error("Could not allocate a TCP port."));
            return;
          }
          servers.push(server);
          resolve(address.port);
        });
      });
      ports.push(port);
    }
  } finally {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  }
  return ports;
}

interface ArgSetOptions {
  binaryPath: string;
  host: string;
  port: number;
  controlListen: string;
  upstreamSpec?: string;
  bearerToken?: string;
  extraArgs?: string[];
}

async function buildArgSets(options: ArgSetOptions): Promise<string[][]> {
  if (options.extraArgs?.length) return [options.extraArgs];
  if (process.env.LLMTESTLAB_PROXY_START_ARGS) return [splitArgs(process.env.LLMTESTLAB_PROXY_START_ARGS)];
  const listen = `${options.host}:${options.port}`;
  const canonical = [
    "-listen",
    listen,
    "-control",
    options.controlListen,
    ...(options.upstreamSpec ? ["-upstream", options.upstreamSpec] : []),
    ...(options.bearerToken ? ["-control-token", options.bearerToken] : []),
  ];
  const detected = await detectArgsFromHelp(options.binaryPath, {
    listen,
    controlListen: options.controlListen,
    ...(options.upstreamSpec ? { upstreamSpec: options.upstreamSpec } : {}),
    ...(options.bearerToken ? { bearerToken: options.bearerToken } : {}),
  });
  return uniqueArgSets([canonical, ...detected, []]);
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
  options: { listen: string; controlListen: string; upstreamSpec?: string; bearerToken?: string },
): Promise<string[][]> {
  const help = await readHelp(binaryPath);
  if (!help) return [];
  const listenFlag = flagFromHelp(help, ["-listen", "--listen", "-addr", "--addr"]);
  const upstreamFlag = flagFromHelp(help, ["-upstream", "--upstream"]);
  const tokenFlag = flagFromHelp(help, ["-control-token", "--control-token"]);
  const controlFlag = flagFromHelp(help, ["-control", "--control"]);
  if (!listenFlag && !upstreamFlag) return [];
  const args: string[] = [];
  if (listenFlag) args.push(listenFlag, options.listen);
  if (controlFlag) args.push(controlFlag, options.controlListen);
  if (upstreamFlag && options.upstreamSpec) args.push(upstreamFlag, options.upstreamSpec);
  if (tokenFlag && options.bearerToken) args.push(tokenFlag, options.bearerToken);
  return [args];
}

function flagFromHelp(help: string, candidates: string[]): string | undefined {
  return candidates.find((flag) => help.includes(flag));
}

async function readHelp(binaryPath: string): Promise<string> {
  for (const args of [["-h"], ["--help"], ["help"]]) {
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
