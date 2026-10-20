import { afterAll, afterEach, beforeAll, beforeEach, expect } from "vitest";
import { createLlmentary, type Llmentary } from "./index.js";
import { firstNonEmpty } from "./env.js";
import { toHaveRequestParam, toHaveToolCalled, toHaveToolCalledTimes } from "./matchers.js";
import { startProxy, type ProxyHandle, type ProxyLaunchOptions } from "./index.js";
import type { LlmentaryOptions } from "./types.js";

let proxy: ProxyHandle | undefined;
let current: Llmentary | undefined;

export async function globalSetup(options: ProxyLaunchOptions = {}): Promise<() => Promise<void>> {
  proxy = await startProxy(options);
  applyProxyEnv(proxy);
  return async () => {
    await proxy?.stop();
    proxy = undefined;
    clearProxyEnv();
  };
}

export function setupVitest(options: { proxy?: ProxyLaunchOptions; llmentary?: LlmentaryOptions } = {}): void {
  let ownedProxy: ProxyHandle | undefined;
  beforeAll(async () => {
    if (!firstNonEmpty(process.env.LLMENTARY_PROXY_URL)) {
      ownedProxy = await startProxy(options.proxy);
      proxy = ownedProxy;
      applyProxyEnv(ownedProxy);
    }
  });

  afterAll(async () => {
    if (!ownedProxy) return;
    await ownedProxy.stop();
    if (proxy === ownedProxy) proxy = undefined;
    ownedProxy = undefined;
    clearProxyEnv();
  });

  beforeEach(() => {
    current = createLlmentary(options.llmentary);
  });

  afterEach(async () => {
    await current?.cleanup().catch(() => undefined);
    current = undefined;
  });

  expect.extend({ toHaveToolCalled, toHaveToolCalledTimes, toHaveRequestParam });
}

export function llmentary(config?: LlmentaryOptions): Llmentary {
  if (config) return createLlmentary(config);
  if (!current) current = createLlmentary();
  return current;
}

export { createLlmentary };

function applyProxyEnv(handle: ProxyHandle): void {
  process.env.LLMENTARY_PROXY_URL = handle.proxyUrl;
  process.env.LLMENTARY_CONTROL_URL = handle.controlUrl;
  if (handle.bearerToken) {
    process.env.LLMENTARY_BEARER_TOKEN = handle.bearerToken;
    process.env.LLMENTARY_CONTROL_TOKEN = handle.bearerToken;
  }
}

function clearProxyEnv(): void {
  delete process.env.LLMENTARY_PROXY_URL;
  delete process.env.LLMENTARY_CONTROL_URL;
  delete process.env.LLMENTARY_BEARER_TOKEN;
  delete process.env.LLMENTARY_CONTROL_TOKEN;
}

declare module "vitest" {
  // Must match Vitest 3's Assertion type parameter.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  interface Assertion<T = any> {
    toHaveToolCalled(name: string, options?: Parameters<typeof toHaveToolCalled>[2]): Promise<T> | T;
    toHaveToolCalledTimes(name: string, count: number, options?: Parameters<typeof toHaveToolCalledTimes>[3]): Promise<T> | T;
    toHaveRequestParam(path: string, expected: Parameters<typeof toHaveRequestParam>[2]): Promise<T> | T;
  }
  interface AsymmetricMatchersContaining {
    toHaveToolCalled(name: string, options?: Parameters<typeof toHaveToolCalled>[2]): unknown;
    toHaveToolCalledTimes(name: string, count: number, options?: Parameters<typeof toHaveToolCalledTimes>[3]): unknown;
    toHaveRequestParam(path: string, expected: Parameters<typeof toHaveRequestParam>[2]): unknown;
  }
}
