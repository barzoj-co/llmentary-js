import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { resolveBinary } from "./binary.js";
import { ControlClient } from "./control.js";
import { firstNonEmpty } from "./env.js";
import { forgetSpawnedProcess, rememberSpawnedProcess } from "./process.js";
import type { ProxyHandle, ProxyLaunchOptions } from "./types.js";

export { firstNonEmpty } from "./env.js";

const SECRET_FLAGS = new Set(["-control-token", "--control-token", "--bearer-token", "-bearer-token"]);

export function formatUpstreamSpec(name: string, url: string): string {
  const trimmed = url.trim();
  const separator = trimmed.indexOf("=");
  if (separator > 0) {
    const maybeName = trimmed.slice(0, separator);
    const maybeUrl = trimmed.slice(separator + 1);
    if (/^[A-Za-z0-9._-]+$/.test(maybeName) && /:\/\//.test(maybeUrl)) {
      return `${maybeName}=${maybeUrl}`;
    }
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
    const arg = redacted[index] ?? "";
    if (SECRET_FLAGS.has(arg) && redacted[index + 1] !== undefined) {
      redacted[index + 1] = "***";
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq > 0 && SECRET_FLAGS.has(arg.slice(0, eq))) {
      redacted[index] = `${arg.slice(0, eq)}=***`;
    }
  }
  return redacted;
}

/**
 * @deprecated The proxy owns the overlap-join rule. Do not strip `/v1` here.
 * Kept so existing callers keep compiling; new code should pass upstream URLs through unchanged.
 */
export function originForGoUpstream(url: string): string {
  const trimmed = url.trim();
  try {
    const parsed = new URL(trimmed);
    parsed.pathname = parsed.pathname.replace(/\/+$/, "").replace(/\/v1$/i, "");
    if (parsed.pathname === "") parsed.pathname = "/";
    const serialized = parsed.toString();
    if (parsed.pathname === "/" && parsed.search === "" && parsed.hash === "") {
      return serialized.replace(/\/$/, "");
    }
    return serialized;
  } catch {
    return trimmed.replace(/\/+$/, "").replace(/\/v1$/i, "");
  }
}

export function resolveUpstreamSpec(options: {
  upstreams?: string;
  upstreamName?: string;
  upstreamBaseUrl?: string;
  env?: NodeJS.ProcessEnv;
} = {}): string | undefined {
  const env = options.env ?? process.env;
  warnIfOpenAIBaseURLLooksLikeProxy(env);
  const name = firstNonEmpty(options.upstreamName, env.LLMENTARY_UPSTREAM_NAME) ?? "openai";
  const spec = firstNonEmpty(options.upstreams, env.LLMENTARY_UPSTREAMS);
  if (spec) return rewriteUpstreamSpec(spec);
  const url = firstNonEmpty(options.upstreamBaseUrl, env.LLMENTARY_UPSTREAM_BASE_URL);
  if (!url) return undefined;
  return formatUpstreamSpec(name, url);
}

function rewriteUpstreamSpec(spec: string): string {
  return spec.trim();
}

function warnIfOpenAIBaseURLLooksLikeProxy(env: NodeJS.ProcessEnv): void {
  const openai = firstNonEmpty(env.OPENAI_BASE_URL);
  if (!openai || !looksLikeLlmentaryProxy(openai, env)) return;
  console.warn(
    "OPENAI_BASE_URL points at a llmentary proxy; it is not used as the upstream. Set LLMENTARY_UPSTREAM_BASE_URL (or startProxy upstreams) for the real provider.",
  );
}

export function looksLikeLlmentaryProxy(url: string, env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    const parsed = new URL(url);
    if (/(?:^|\/)s\/[^/]+(?:\/|$)/.test(parsed.pathname)) return true;
    const proxy = firstNonEmpty(env.LLMENTARY_PROXY_URL);
    if (proxy && new URL(proxy).origin === parsed.origin) return true;
    return false;
  } catch {
    return false;
  }
}

export async function startProxy(options: ProxyLaunchOptions = {}): Promise<ProxyHandle> {
  const attachedProxyUrl = firstNonEmpty(options.proxyUrl, process.env.LLMENTARY_PROXY_URL);
  if (attachedProxyUrl) {
    const proxyUrl = trimTrailingSlash(attachedProxyUrl);
    const controlUrl = trimTrailingSlash(
      firstNonEmpty(options.controlUrl, process.env.LLMENTARY_CONTROL_URL) ?? proxyUrl,
    );
    const bearerToken = firstNonEmpty(
      options.bearerToken,
      process.env.LLMENTARY_BEARER_TOKEN,
      process.env.LLMENTARY_CONTROL_TOKEN,
    );
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
  const host = firstNonEmpty(options.host, process.env.LLMENTARY_HOST) ?? "127.0.0.1";
  const reserved = await getFreePorts(host, 2);
  const port = options.port ?? reserved[0]!;
  const controlPort = options.controlPort ?? reserved.find((candidate) => candidate !== port) ?? reserved[1]!;
  if (controlPort === port) {
    throw new Error("proxy listen port and control port must be different; the Go binary serves /healthz on -control.");
  }
  const proxyUrl = `http://${host}:${port}`;
  const controlUrl = `http://${host}:${controlPort}`;
  const controlListen = `${host}:${controlPort}`;
  const bearerToken = firstNonEmpty(
    options.bearerToken,
    process.env.LLMENTARY_BEARER_TOKEN,
    process.env.LLMENTARY_CONTROL_TOKEN,
  );
  const mergedEnv = { ...process.env, ...options.env };
  const upstreamName = firstNonEmpty(options.upstreamName, mergedEnv.LLMENTARY_UPSTREAM_NAME) ?? "openai";
  const upstreamSpec = resolveUpstreamSpec({
    ...(options.upstreams !== undefined ? { upstreams: options.upstreams } : {}),
    upstreamName,
    ...(options.upstreamBaseUrl !== undefined ? { upstreamBaseUrl: options.upstreamBaseUrl } : {}),
    env: mergedEnv,
  });
  const specTargets = firstNonEmpty(options.specTargets, mergedEnv.LLMENTARY_SPEC_TARGETS);
  const upstreamHeaderTimeout = firstNonEmpty(
    options.upstreamHeaderTimeout,
    mergedEnv.LLMENTARY_UPSTREAM_HEADER_TIMEOUT,
  );
  const upstreamIdleTimeout = firstNonEmpty(options.upstreamIdleTimeout, mergedEnv.LLMENTARY_UPSTREAM_IDLE_TIMEOUT);
  const allowPathPrefix = firstNonEmpty(options.allowPathPrefix, mergedEnv.LLMENTARY_ALLOW_PATH_PREFIXES);

  const instanceId = randomUUID();
  const env = {
    ...process.env,
    ...options.env,
    LLMENTARY_LISTEN: `${host}:${port}`,
    LLMENTARY_CONTROL_LISTEN: controlListen,
    LLMENTARY_PROXY_URL: proxyUrl,
    LLMENTARY_CONTROL_URL: controlUrl,
    LLMENTARY_UPSTREAM_NAME: upstreamName,
    LLMENTARY_INSTANCE_ID: instanceId,
    ...(upstreamSpec ? { LLMENTARY_UPSTREAMS: upstreamSpec } : {}),
    ...(specTargets ? { LLMENTARY_SPEC_TARGETS: specTargets } : {}),
    ...(upstreamHeaderTimeout ? { LLMENTARY_UPSTREAM_HEADER_TIMEOUT: upstreamHeaderTimeout } : {}),
    ...(upstreamIdleTimeout ? { LLMENTARY_UPSTREAM_IDLE_TIMEOUT: upstreamIdleTimeout } : {}),
    ...(allowPathPrefix ? { LLMENTARY_ALLOW_PATH_PREFIXES: allowPathPrefix } : {}),
    ...(bearerToken
      ? { LLMENTARY_BEARER_TOKEN: bearerToken, LLMENTARY_CONTROL_TOKEN: bearerToken }
      : {}),
  };

  const argSets = await buildArgSets({
    binaryPath,
    host,
    port,
    controlListen,
    ...(upstreamSpec ? { upstreamSpec } : {}),
    ...(specTargets ? { specTargets } : {}),
    ...(upstreamHeaderTimeout ? { upstreamHeaderTimeout } : {}),
    ...(upstreamIdleTimeout ? { upstreamIdleTimeout } : {}),
    ...(allowPathPrefix ? { allowPathPrefix } : {}),
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
    if (child.pid) {
      rememberSpawnedProcess({
        pid: child.pid,
        instanceId,
        exePath: binaryPath,
        startedAtMs: Date.now(),
      });
    }
    try {
      await waitForHealth(controlUrl, bearerToken, options.healthTimeoutMs, child, logs);
      return {
        proxyUrl,
        controlUrl,
        ...(bearerToken ? { bearerToken } : {}),
        ...(child.pid ? { pid: child.pid } : {}),
        instanceId,
        exePath: binaryPath,
        async stop() {
          await stopChild(child);
          if (child.pid) forgetSpawnedProcess(child.pid);
        },
      };
    } catch (error) {
      const detail = logs.length ? `\nproxy output:\n${logs.join("\n")}` : "";
      lastError = new Error(
        redactText(
          `${error instanceof Error ? error.message : String(error)} (args: ${JSON.stringify(redactArgs(args))})${detail}`,
          bearerToken,
        ),
      );
      await stopChild(child);
      if (child.pid) forgetSpawnedProcess(child.pid);
    }
  }
  throw new Error(
    `Failed to start llmentary proxy with known CLI argument forms. ${lastError?.message ?? ""}\n` +
      "If the Go binary uses different flags, set LLMENTARY_PROXY_URL and LLMENTARY_CONTROL_URL to attach to a running proxy or pass args/start options explicitly.",
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
  const client = new ControlClient({
    controlUrl,
    ...(bearerToken ? { bearerToken } : {}),
    requestTimeoutMs: Math.min(1_000, timeoutMs),
  });
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) {
      throw new Error(
        redactText(
          `llmentary proxy exited before becoming healthy (exit ${child.exitCode}). ${logs.join("\n")}`.trim(),
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
  throw new Error(`Timed out waiting for llmentary /healthz at ${controlUrl}: ${String(lastError)}`);
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
  specTargets?: string;
  upstreamHeaderTimeout?: string;
  upstreamIdleTimeout?: string;
  allowPathPrefix?: string;
  bearerToken?: string;
  extraArgs?: string[];
}

async function buildArgSets(options: ArgSetOptions): Promise<string[][]> {
  if (options.extraArgs?.length) return [options.extraArgs];
  if (process.env.LLMENTARY_PROXY_START_ARGS) return [splitArgs(process.env.LLMENTARY_PROXY_START_ARGS)];
  const listen = `${options.host}:${options.port}`;
  const canonical = [
    "-listen",
    listen,
    "-control",
    options.controlListen,
    ...(options.upstreamSpec ? ["-upstream", options.upstreamSpec] : []),
    ...repeatableFlags("-spec-target", options.specTargets),
    ...(options.upstreamHeaderTimeout ? ["-upstream-header-timeout", options.upstreamHeaderTimeout] : []),
    ...(options.upstreamIdleTimeout ? ["-upstream-idle-timeout", options.upstreamIdleTimeout] : []),
    ...repeatableFlags("-allow-path-prefix", options.allowPathPrefix),
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

function repeatableFlags(flag: string, value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .flatMap((part) => [flag, part]);
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
