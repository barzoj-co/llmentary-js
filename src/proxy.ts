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

  const argSets = buildArgSets({
    host,
    port,
    controlUrl,
    ...(upstreamBaseUrl ? { upstreamBaseUrl } : {}),
    ...(bearerToken ? { bearerToken } : {}),
    ...(options.args ? { extraArgs: options.args } : {}),
  });
  let lastError: Error | undefined;
  for (const args of argSets) {
    const child = spawn(binaryPath, args, { env });
    wireLogs(child, options.log);
    try {
      await waitForHealth(controlUrl, bearerToken, options.healthTimeoutMs, child);
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
      lastError = error instanceof Error ? error : new Error(String(error));
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
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const client = new ControlClient({ controlUrl, ...(bearerToken ? { bearerToken } : {}) });
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) {
      throw new Error(`llm-test-lab proxy exited before becoming healthy (exit ${child.exitCode}).`);
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
  host: string;
  port: number;
  controlUrl: string;
  upstreamBaseUrl?: string;
  bearerToken?: string;
  extraArgs?: string[];
}

function buildArgSets(options: ArgSetOptions): string[][] {
  if (options.extraArgs?.length) return [options.extraArgs];
  if (process.env.LLMTESTLAB_PROXY_START_ARGS) return [splitArgs(process.env.LLMTESTLAB_PROXY_START_ARGS)];
  const listen = `${options.host}:${options.port}`;
  const args: string[] = ["--listen", listen];
  const serveArgs: string[] = ["serve", "--listen", listen];
  const proxyAddrArgs: string[] = ["serve", "--proxy-addr", listen];
  const upstream = options.upstreamBaseUrl ? ["--upstream-base-url", options.upstreamBaseUrl] : [];
  const upstreamAlt = options.upstreamBaseUrl ? ["--upstream-url", options.upstreamBaseUrl] : [];
  const token = options.bearerToken ? ["--bearer-token", options.bearerToken] : [];
  return [
    [...serveArgs, ...upstream, ...token],
    [...args, ...upstream, ...token],
    [...proxyAddrArgs, ...upstream, ...token],
    [...serveArgs, ...upstreamAlt, ...token],
    [...args, ...upstreamAlt, ...token],
    [],
  ];
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
  if (!exited) child.kill("SIGKILL");
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
