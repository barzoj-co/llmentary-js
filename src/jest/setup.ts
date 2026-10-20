import { cleanupSession } from "../jest.js";
import { toHaveRequestParam, toHaveToolCalled, toHaveToolCalledTimes } from "../matchers.js";
import { applyState, readState } from "./state.js";

beforeAll(async () => {
  const state = await readState().catch(() => undefined);
  if (state) applyState(state);
});

afterEach(async () => {
  await cleanupSession();
});

expect.extend({ toHaveToolCalled, toHaveToolCalledTimes, toHaveRequestParam });

declare module "expect" {
  interface Matchers<R> {
    toHaveToolCalled(name: string, options?: Parameters<typeof toHaveToolCalled>[2]): Promise<R>;
    toHaveToolCalledTimes(name: string, count: number, options?: Parameters<typeof toHaveToolCalledTimes>[3]): Promise<R>;
    toHaveRequestParam(path: string, expected: Parameters<typeof toHaveRequestParam>[2]): Promise<R>;
  }
}
