import { afterAll, afterEach, beforeAll, beforeEach, expect } from "vitest";
import { createLab, type LlmTestLab } from "./index.js";
import { toHaveRequestParam, toHaveToolCalled, toHaveToolCalledTimes } from "./matchers.js";
import { startProxy, type ProxyHandle, type ProxyLaunchOptions } from "./index.js";
import type { LabConfig } from "./types.js";

let proxy: ProxyHandle | undefined;
let currentLab: LlmTestLab | undefined;

export async function globalSetup(options: ProxyLaunchOptions = {}): Promise<() => Promise<void>> {
  proxy = await startProxy(options);
  process.env.LLMTESTLAB_PROXY_URL = proxy.proxyUrl;
  process.env.LLMTESTLAB_CONTROL_URL = proxy.controlUrl;
  if (proxy.bearerToken) process.env.LLMTESTLAB_BEARER_TOKEN = proxy.bearerToken;
  return async () => {
    await proxy?.stop();
    proxy = undefined;
  };
}

export function setupVitest(options: { proxy?: ProxyLaunchOptions; lab?: LabConfig } = {}): void {
  beforeAll(async () => {
    if (!process.env.LLMTESTLAB_PROXY_URL) {
      proxy = await startProxy(options.proxy);
      process.env.LLMTESTLAB_PROXY_URL = proxy.proxyUrl;
      process.env.LLMTESTLAB_CONTROL_URL = proxy.controlUrl;
      if (proxy.bearerToken) process.env.LLMTESTLAB_BEARER_TOKEN = proxy.bearerToken;
    }
  });

  beforeEach(() => {
    currentLab = createLab(options.lab);
  });

  afterEach(async () => {
    await currentLab?.cleanup().catch(() => undefined);
    currentLab = undefined;
  });

  afterAll(async () => {
    await proxy?.stop();
    proxy = undefined;
  });

  expect.extend({ toHaveToolCalled, toHaveToolCalledTimes, toHaveRequestParam });
}

export function lab(config?: LabConfig): LlmTestLab {
  if (config) return createLab(config);
  if (!currentLab) currentLab = createLab();
  return currentLab;
}

export { createLab };

declare module "vitest" {
  // T is part of Vitest's public Assertion declaration and must be repeated for module augmentation.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface Assertion<R extends void | Promise<void> = void, T = unknown> {
    toHaveToolCalled(name: string, options?: Parameters<typeof toHaveToolCalled>[2]): R;
    toHaveToolCalledTimes(name: string, count: number, options?: Parameters<typeof toHaveToolCalledTimes>[3]): R;
    toHaveRequestParam(path: string, expected: Parameters<typeof toHaveRequestParam>[2]): R;
  }
  interface AsymmetricMatchersContaining {
    toHaveToolCalled(name: string, options?: Parameters<typeof toHaveToolCalled>[2]): unknown;
    toHaveToolCalledTimes(name: string, count: number, options?: Parameters<typeof toHaveToolCalledTimes>[3]): unknown;
    toHaveRequestParam(path: string, expected: Parameters<typeof toHaveRequestParam>[2]): unknown;
  }
}
