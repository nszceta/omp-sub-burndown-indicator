import { describe, expect, test } from "bun:test";
import type { UsageLimit } from "@oh-my-pi/pi-ai";
import type { SubscriptionSnapshot } from "../src/domain/types.ts";
import { mergeSnapshots, SourceCoordinator } from "../src/sources/coordinator.ts";
import type { UsageSource } from "../src/sources/source.ts";

function limit(id: string, usedFraction: number): UsageLimit {
  return {
    id,
    label: id,
    scope: { provider: "anthropic", accountId: "acct" },
    window: { id, label: id, durationMs: 3_600_000, resetsAt: 5_000_000 },
    amount: { unit: "percent", usedFraction },
  };
}

function snapshot(
  source: SubscriptionSnapshot["identitySource"],
  fetchedAt: number,
  usedFraction: number,
): SubscriptionSnapshot {
  return {
    id: "anthropic:account:acct",
    provider: "anthropic",
    accountLabel: "acct",
    identitySource: source,
    limits: [
      {
        limit: limit("hour", usedFraction),
        measurementSource: source,
        fetchedAt,
        stale: false,
      },
    ],
  };
}

describe("mergeSnapshots", () => {
  test("newest complete measurement wins while stronger identity remains", () => {
    const [merged] = mergeSnapshots([
      [snapshot("omp-broker", 1_000, 0.4)],
      [snapshot("omp-response", 2_000, 0.5)],
    ]);
    expect(merged?.identitySource).toBe("omp-broker");
    expect(merged?.limits[0]?.measurementSource).toBe("omp-response");
    expect(merged?.limits[0]?.limit.amount.usedFraction).toBe(0.5);
  });

  test("different stable account IDs never merge", () => {
    const other = snapshot("provider-endpoint", 2_000, 0.7);
    other.id = "anthropic:account:other";
    expect(mergeSnapshots([[snapshot("omp-broker", 1_000, 0.4)], [other]])).toHaveLength(2);
  });
});

describe("SourceCoordinator", () => {
  test("isolates one failed source and joins concurrent refreshes", async () => {
    let calls = 0;
    let release: (() => void) | undefined;
    const healthy: UsageSource = {
      id: "healthy",
      refresh: async () => {
        calls++;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return [snapshot("omp-broker", 1_000, 0.4)];
      },
    };
    const failed: UsageSource = {
      id: "failed",
      refresh: async () => {
        throw new Error("unavailable");
      },
    };
    const coordinator = new SourceCoordinator([healthy, failed]);
    const controller = new AbortController();
    const first = coordinator.refresh(controller.signal);
    const second = coordinator.refresh(controller.signal);
    expect(first).toBe(second);
    release?.();
    expect(await first).toHaveLength(1);
    expect(calls).toBe(1);
  });
});
