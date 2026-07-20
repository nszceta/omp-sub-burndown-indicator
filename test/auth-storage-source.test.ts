import { expect, test } from "bun:test";
import type { UsageReport } from "@oh-my-pi/pi-ai";
import { calculateBurndownSegment } from "../src/domain/burndown.ts";
import type { HostModelRegistry } from "../src/sources/omp-auth-storage.ts";
import { OmpAuthStorageUsageSource } from "../src/sources/omp-auth-storage.ts";

const now = 10_000;

function report(provider: string, accountId: string): UsageReport {
  return {
    provider,
    fetchedAt: now,
    metadata: { accountId, email: `${provider}@example.test` },
    limits: [
      {
        id: `${provider}:short`,
        label: "Short",
        scope: { provider, windowId: "short" },
        window: { id: "short", label: "Short", durationMs: 10_000, resetsAt: 15_000 },
        amount: { unit: "percent", usedFraction: 0.4 },
      },
    ],
  };
}

test("reads and normalizes the same account usage reports exposed by OMP", async () => {
  let resolvedProvider: string | undefined;
  let receivedSignal: AbortSignal | undefined;
  const registry = {
    getProviderBaseUrl: (provider: string) => {
      resolvedProvider = provider;
      return "https://provider.example";
    },
    authStorage: {
      fetchUsageReports: async (options?: {
        baseUrlResolver?: (provider: string) => string | undefined;
        signal?: AbortSignal;
      }) => {
        receivedSignal = options?.signal;
        options?.baseUrlResolver?.("openai-codex");
        return [report("anthropic", "acct-a"), report("openai-codex", "acct-o")];
      },
    },
  } as unknown as HostModelRegistry;
  const source = new OmpAuthStorageUsageSource({ registry, now: () => now });
  const signal = new AbortController().signal;

  const snapshots = await source.refresh(signal);

  expect(receivedSignal).toBe(signal);
  expect(resolvedProvider).toBe("openai-codex");
  expect(snapshots.map((snapshot) => snapshot.id)).toEqual([
    "anthropic:account:acct-a",
    "openai-codex:account:acct-o",
  ]);
  expect(snapshots.map((snapshot) => snapshot.accountLabel)).toEqual([
    "anthropic@example.test",
    "openai-codex@example.test",
  ]);
  expect(snapshots.map((snapshot) => snapshot.identitySource)).toEqual([
    "omp-auth-storage",
    "omp-auth-storage",
  ]);
  expect(snapshots[0]?.limits[0]?.measurementSource).toBe("omp-auth-storage");
  expect(source.diagnostic()).toMatchObject({
    sourceId: "omp-auth-storage",
    enabled: true,
    lastSuccessAt: now,
  });
});

test("omits expired host usage observations", async () => {
  const expired = report("anthropic", "acct-a");
  expired.fetchedAt = 1_000;
  const registry = {
    getProviderBaseUrl: () => undefined,
    authStorage: { fetchUsageReports: async () => [expired] },
  } as unknown as HostModelRegistry;
  const source = new OmpAuthStorageUsageSource({
    registry,
    now: () => now,
    staleAfterMs: 1_000,
  });

  expect(await source.refresh(new AbortController().signal)).toEqual([]);
});

/** Mirrors the identity-less API-key reports OMP returns for OpenCode Go. */
function anonymousOpenCodeGoReport(
  windowId: string,
  durationMs: number,
  resetsAt: number,
  usedFraction: number,
): UsageReport {
  return {
    provider: "opencode-go",
    fetchedAt: now,
    metadata: { planType: "OpenCode Go", source: "omp-observed-request-costs" },
    limits: [
      {
        id: windowId,
        label: windowId,
        scope: { provider: "opencode-go", windowId },
        window: { id: windowId, label: windowId, durationMs, resetsAt },
        amount: { usedFraction, unit: "usd" },
      },
    ],
  };
}

test("surfaces multi-account anonymous providers as one unknown placeholder", async () => {
  const registry = {
    getProviderBaseUrl: () => undefined,
    authStorage: {
      fetchUsageReports: async () => [
        anonymousOpenCodeGoReport("monthly", 2_592_000_000, now + 941_400_000, 0.331),
        anonymousOpenCodeGoReport("weekly", 604_800_000, now + 80_580_000, 0.013),
      ],
    },
  } as unknown as HostModelRegistry;
  const source = new OmpAuthStorageUsageSource({ registry, now: () => now });

  const snapshots = await source.refresh(new AbortController().signal);

  expect(snapshots).toHaveLength(1);
  expect(snapshots[0]).toMatchObject({
    id: "provider:opencode-go",
    provider: "opencode-go",
    accountId: "provider:opencode-go",
    identitySource: "omp-auth-storage",
    limits: [],
  });
  const segment = calculateBurndownSegment(snapshots[0] as never, { now });
  expect(segment.state).toBe("unknown");
  expect(segment.stale).toBe(false);
  expect(source.diagnostic().detail).toContain("opencode-go");
});

test("keeps real measurements for a single anonymous provider report", async () => {
  const registry = {
    getProviderBaseUrl: () => undefined,
    authStorage: {
      fetchUsageReports: async () => [
        anonymousOpenCodeGoReport("monthly", 2_592_000_000, now + 941_400_000, 0.331),
      ],
    },
  } as unknown as HostModelRegistry;
  const source = new OmpAuthStorageUsageSource({ registry, now: () => now });

  const snapshots = await source.refresh(new AbortController().signal);

  expect(snapshots.map((snapshot) => snapshot.id)).toEqual(["provider:opencode-go"]);
  expect(snapshots[0]?.limits).toHaveLength(1);
  expect(source.diagnostic().detail).toBeUndefined();
});

test("does not placeholder a provider that already has an identified snapshot", async () => {
  const registry = {
    getProviderBaseUrl: () => undefined,
    authStorage: {
      fetchUsageReports: async () => [
        report("opencode-go", "acct-known"),
        anonymousOpenCodeGoReport("monthly", 2_592_000_000, now + 941_400_000, 0.3),
        anonymousOpenCodeGoReport("weekly", 604_800_000, now + 80_580_000, 0.1),
      ],
    },
  } as unknown as HostModelRegistry;
  const source = new OmpAuthStorageUsageSource({ registry, now: () => now });

  const snapshots = await source.refresh(new AbortController().signal);

  expect(snapshots.map((snapshot) => snapshot.id)).toEqual(["opencode-go:account:acct-known"]);
  expect(source.diagnostic().detail).toContain("2 usage report(s)");
});
