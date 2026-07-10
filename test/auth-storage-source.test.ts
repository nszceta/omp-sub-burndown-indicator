import { expect, test } from "bun:test";
import type { UsageReport } from "@oh-my-pi/pi-ai";
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
