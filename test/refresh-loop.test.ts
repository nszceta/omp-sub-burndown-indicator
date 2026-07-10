import { expect, test } from "bun:test";
import { RefreshLoop } from "../src/runtime/refresh-loop.ts";

test("refresh loop is single-flight and aborts on stop", async () => {
  let calls = 0;
  let active = 0;
  let maximumActive = 0;
  let release: (() => void) | undefined;
  let receivedSignal: AbortSignal | undefined;
  const loop = new RefreshLoop({
    intervalMs: 60_000,
    run: async (signal) => {
      calls++;
      active++;
      maximumActive = Math.max(maximumActive, active);
      receivedSignal = signal;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      active--;
    },
  });

  const first = loop.start();
  const second = loop.trigger();
  expect(first).toBe(second);
  expect(calls).toBe(1);
  expect(maximumActive).toBe(1);
  loop.stop();
  expect(receivedSignal?.aborted).toBe(true);
  release?.();
  await first;
  expect(loop.active).toBe(false);
});
