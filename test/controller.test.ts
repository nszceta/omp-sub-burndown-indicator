import { expect, test } from "bun:test";
import type { UsageProvider, UsageReport } from "@oh-my-pi/pi-ai";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import type { BurndownConfig } from "../src/config.ts";
import type { SubscriptionSnapshot } from "../src/domain/types.ts";
import { IndicatorController, WIDGET_KEY } from "../src/runtime/controller.ts";
import { ResponseHeaderUsageSource } from "../src/sources/response-headers.ts";
import type { UsageSource } from "../src/sources/source.ts";

const now = 10_000;
const config: BurndownConfig = {
  refreshMs: 60_000,
  staleAfterMs: 60_000,
  timeoutMs: 1_000,
  paceTolerance: 0.01,
  symbols: "ascii",
  density: "dense",
  showReset: false,
  clockSkewMs: 0,
};

function snapshot(usedFraction = 0.25, fetchedAt = now): SubscriptionSnapshot {
  return {
    id: "anthropic:account:acct",
    provider: "anthropic",
    accountLabel: "Claude",
    identitySource: "omp-broker",
    limits: [
      {
        limit: {
          id: "short",
          label: "Short",
          scope: { provider: "anthropic", accountId: "acct" },
          window: { id: "short", label: "Short", durationMs: 10_000, resetsAt: 15_000 },
          amount: { unit: "percent", usedFraction },
        },
        measurementSource: "omp-broker",
        fetchedAt,
        stale: false,
      },
    ],
  };
}

interface FakeUiState {
  key?: string;
  content?: unknown;
  placement?: string;
  cleared: boolean;
  renders: number;
}

function fakeContext(
  state: FakeUiState,
  hasUI = true,
  usageReports: readonly UsageReport[] = [],
): ExtensionContext {
  const model = { provider: "anthropic", id: "claude" };
  return {
    hasUI,
    model,
    models: {
      list: () => [model],
      current: () => model,
      resolve: () => undefined,
      family: () => "claude",
    },
    modelRegistry: {
      authStorage: { fetchUsageReports: async () => [...usageReports] },
      getProviderBaseUrl: () => undefined,
    },
    ui: {
      setWidget: (key: string, content: unknown, options?: { placement?: string }) => {
        state.key = key;
        state.content = content;
        if (options?.placement) state.placement = options.placement;
        if (content === undefined) state.cleared = true;
      },
    },
  } as unknown as ExtensionContext;
}

function staticSource(value: SubscriptionSnapshot[]): UsageSource {
  return { id: "omp-broker", refresh: async () => value };
}

test("controller installs one above-editor width-aware row and clears on shutdown", async () => {
  const state: FakeUiState = { cleared: false, renders: 0 };
  const ctx = fakeContext(state);
  const controller = new IndicatorController({
    config,
    now: () => now,
    sources: [staticSource([snapshot()])],
  });
  await controller.start(ctx);

  expect(state.key).toBe(WIDGET_KEY);
  expect(state.placement).toBe("aboveEditor");
  expect(typeof state.content).toBe("function");
  const component = (
    state.content as (
      tui: { requestRender(): void },
      theme: { fg(_color: string, text: string): string },
    ) => { render(width: number): readonly string[] }
  )({ requestRender: () => state.renders++ }, { fg: (_color, text) => text });
  const rows = component.render(12);
  expect(rows).toHaveLength(1);
  expect(visibleWidth(rows[0] ?? "")).toBeLessThanOrEqual(12);
  controller.shutdown(ctx);
  expect(state.cleared).toBe(true);
});

test("controller propagates plugin density into the row component", async () => {
  const state: FakeUiState = { cleared: false, renders: 0 };
  const ctx = fakeContext(state);
  const controller = new IndicatorController({
    now: () => now,
    sources: [staticSource([snapshot()])],
  });
  await controller.start(ctx, { density: "text" });

  const component = (
    state.content as (
      tui: { requestRender(): void },
      theme: { fg(_color: string, text: string): string },
    ) => { render(width: number): readonly string[] }
  )({ requestRender: () => state.renders++ }, { fg: (_color, text) => text });
  expect(component.render(100).join("")).toContain("points ahead");
  await controller.restart(ctx, { density: "dense" });
  const denseComponent = (
    state.content as (
      tui: { requestRender(): void },
      theme: { fg(_color: string, text: string): string },
    ) => { render(width: number): readonly string[] }
  )({ requestRender: () => state.renders++ }, { fg: (_color, text) => text });
  expect(denseComponent.render(100).join("")).toContain("▲25pp");
  controller.shutdown(ctx);
});

test("headless startup performs no source work or widget calls", async () => {
  let calls = 0;
  const state: FakeUiState = { cleared: false, renders: 0 };
  const source: UsageSource = {
    id: "test",
    refresh: async () => {
      calls++;
      return [];
    },
  };
  const controller = new IndicatorController({ config, sources: [source] });
  await controller.start(fakeContext(state, false));
  expect(calls).toBe(0);
  expect(state.content).toBeUndefined();
});

test("restart aborts old work and late generations cannot render", async () => {
  let calls = 0;
  let firstSignal: AbortSignal | undefined;
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const source: UsageSource = {
    id: "omp-broker",
    refresh: async (signal) => {
      calls++;
      if (calls > 1) return [snapshot(0.75, now + 1)];
      firstSignal = signal;
      markStarted?.();
      return new Promise<SubscriptionSnapshot[]>((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        void resolve;
      });
    },
  };
  const state: FakeUiState = { cleared: false, renders: 0 };
  const ctx = fakeContext(state);
  const controller = new IndicatorController({ config, now: () => now, sources: [source] });
  const oldStart = controller.start(ctx);
  await started;
  const restarted = controller.restart(ctx);
  await Promise.all([oldStart, restarted]);
  expect(firstSignal?.aborted).toBe(true);
  expect(calls).toBe(2);
  const component = (
    state.content as (
      tui: { requestRender(): void },
      theme: { fg(_color: string, text: string): string },
    ) => { render(width: number): readonly string[] }
  )({ requestRender: () => state.renders++ }, { fg: (_color, text) => text });
  expect(component.render(80)[0]).toContain("-25");
  controller.shutdown(ctx);
});

test("newer unambiguous response headers replace broker measurement immediately", async () => {
  const baseLimit = snapshot(0.75).limits[0]?.limit;
  if (!baseLimit) throw new Error("test fixture limit missing");
  const parser: UsageProvider = {
    id: "anthropic",
    fetchUsage: async () => null,
    parseRateLimitHeaders: (_headers, measuredAt = now + 1) => ({
      provider: "anthropic",
      fetchedAt: measuredAt,
      limits: [
        {
          ...baseLimit,
          amount: { unit: "percent", usedFraction: 0.75 },
        },
      ],
    }),
  };
  const response = new ResponseHeaderUsageSource({ providers: [parser] });
  const state: FakeUiState = { cleared: false, renders: 0 };
  const ctx = fakeContext(state);
  const controller = new IndicatorController({
    config,
    now: () => now,
    sources: [staticSource([snapshot(0.25, now)]), response],
  });
  await controller.start(ctx);
  const component = (
    state.content as (
      tui: { requestRender(): void },
      theme: { fg(_color: string, text: string): string },
    ) => { render(width: number): readonly string[] }
  )({ requestRender: () => state.renders++ }, { fg: (_color, text) => text });
  expect(component.render(80)[0]).toContain("+25");
  expect(controller.ingestResponse({ status: 200, headers: { "x-test": "1" } }, ctx)).toBe(true);
  expect(component.render(80)[0]).toContain("-25");
  expect(state.renders).toBe(1);
  controller.shutdown(ctx);
});

test("response headers alone report a provider and render its burndown", async () => {
  const parser: UsageProvider = {
    id: "anthropic",
    fetchUsage: async () => null,
    parseRateLimitHeaders: (_headers, measuredAt = now) => ({
      provider: "anthropic",
      fetchedAt: measuredAt,
      limits: [
        {
          id: "short",
          label: "Short",
          scope: { provider: "anthropic", windowId: "short" },
          window: { id: "short", label: "Short", durationMs: 10_000, resetsAt: 15_000 },
          amount: { unit: "percent", usedFraction: 0.75 },
        },
      ],
    }),
  };
  const response = new ResponseHeaderUsageSource({ providers: [parser] });
  const state: FakeUiState = { cleared: false, renders: 0 };
  const ctx = fakeContext(state);
  const controller = new IndicatorController({
    config,
    now: () => now,
    sources: [response],
  });
  await controller.start(ctx);
  const component = (
    state.content as (
      tui: { requestRender(): void },
      theme: { fg(_color: string, text: string): string },
    ) => { render(width: number): readonly string[] }
  )({ requestRender: () => state.renders++ }, { fg: (_color, text) => text });

  expect(controller.diagnostic().reportedProviders).toEqual([]);
  expect(controller.ingestResponse({ status: 200, headers: { "x-test": "1" } }, ctx)).toBe(true);
  expect(controller.diagnostic().reportedProviders).toEqual(["anthropic"]);
  expect(controller.diagnostic().unavailableProviders).toEqual({});
  expect(controller.status()).toContain("reported: anthropic");
  expect(component.render(80)[0]).toContain("-25");
  expect(state.renders).toBe(1);
  controller.shutdown(ctx);
});

test("default sources report the same authenticated usage exposed by OMP", async () => {
  const usage: UsageReport = {
    provider: "anthropic",
    fetchedAt: now,
    metadata: { accountId: "acct", accountLabel: "Claude" },
    limits: [
      {
        id: "short",
        label: "Short",
        scope: { provider: "anthropic", windowId: "short" },
        window: { id: "short", label: "Short", durationMs: 10_000, resetsAt: 15_000 },
        amount: { unit: "percent", usedFraction: 0.75 },
      },
    ],
  };
  const state: FakeUiState = { cleared: false, renders: 0 };
  const ctx = fakeContext(state, true, [usage]);
  const controller = new IndicatorController({ config, env: {}, now: () => now });

  await controller.start(ctx);

  expect(controller.diagnostic().reportedProviders).toEqual(["anthropic"]);
  expect(controller.diagnostic().unavailableProviders).toEqual({});
  expect(controller.status()).toContain("omp-auth-storage: enabled, last-success=10000");
  expect(controller.status()).toContain("reported: anthropic");
  const component = (
    state.content as (
      tui: { requestRender(): void },
      theme: { fg(_color: string, text: string): string },
    ) => { render(width: number): readonly string[] }
  )({ requestRender: () => state.renders++ }, { fg: (_color, text) => text });
  expect(component.render(80)[0]).toContain("-25");
  controller.shutdown(ctx);
});
