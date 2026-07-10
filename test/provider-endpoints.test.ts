import { describe, expect, test } from "bun:test";
import type { UsageLimit, UsageProvider, UsageReport } from "@oh-my-pi/pi-ai";
import { discoverProviders } from "../src/sources/omp-models.ts";
import { ProviderEndpointUsageSource } from "../src/sources/provider-endpoints.ts";

const demoLimit = (provider = "demo"): UsageLimit => ({
  id: `${provider}:short`,
  label: "Short",
  scope: { provider, accountId: "acct-1", windowId: "short" },
  window: { id: "short", label: "Short", durationMs: 1_000, resetsAt: 2_000 },
  amount: { unit: "percent", usedFraction: 0.25 },
});

function adapter(options: {
  supports?: (params: Parameters<NonNullable<UsageProvider["supports"]>>[0]) => boolean;
  report?: UsageReport | null;
  onFetch?: () => void;
}): UsageProvider {
  return {
    id: "demo",
    ...(options.supports ? { supports: options.supports } : {}),
    fetchUsage: async () => {
      options.onFetch?.();
      return options.report === undefined
        ? { provider: "demo", fetchedAt: 1_000, limits: [demoLimit()] }
        : options.report;
    },
  };
}

test("discovers providers from models without creating reports", () => {
  expect(
    discoverProviders([{ provider: "zai" }, { provider: "anthropic" }, { provider: "zai" }]),
  ).toEqual(["anthropic", "zai"]);
});

const credential = {
  provider: "demo",
  credential: { type: "api_key" as const, apiKey: "secret-value" },
};

describe("ProviderEndpointUsageSource", () => {
  test("does not perform network work without explicit credentials", async () => {
    let called = false;
    const source = new ProviderEndpointUsageSource({
      adapters: [
        adapter({
          onFetch: () => {
            called = true;
          },
        }),
      ],
    });
    expect(await source.refresh(new AbortController().signal)).toEqual([]);
    expect(called).toBe(false);
  });

  test("honors adapters with and without supports", async () => {
    let supportedCalls = 0;
    const supported = new ProviderEndpointUsageSource({
      credentials: [credential],
      adapters: [
        adapter({
          supports: (params) => params.credential.type === "api_key",
          onFetch: () => {
            supportedCalls += 1;
          },
        }),
      ],
      now: () => 1_000,
    });
    expect((await supported.refresh(new AbortController().signal))[0]?.id).toBe(
      "demo:account:acct-1",
    );
    expect(supportedCalls).toBe(1);

    let rejectedCalls = 0;
    const rejected = new ProviderEndpointUsageSource({
      credentials: [credential],
      adapters: [
        adapter({
          supports: () => false,
          onFetch: () => {
            rejectedCalls += 1;
          },
        }),
      ],
    });
    expect(await rejected.refresh(new AbortController().signal)).toEqual([]);
    expect(rejectedCalls).toBe(0);

    const noSupports = new ProviderEndpointUsageSource({
      credentials: [credential],
      adapters: [adapter({})],
      now: () => 1_000,
    });
    expect((await noSupports.refresh(new AbortController().signal))[0]?.id).toBe(
      "demo:account:acct-1",
    );
  });

  test("normalizes a stable direct identity and redacts secrets from diagnostics", async () => {
    const source = new ProviderEndpointUsageSource({
      credentials: [credential],
      adapters: [adapter({})],
      now: () => 1_000,
    });
    const snapshots = await source.refresh(new AbortController().signal);
    expect(snapshots[0]?.id).toBe("demo:account:acct-1");
    expect(snapshots[0]?.identitySource).toBe("provider-endpoint");
    expect(JSON.stringify(source.diagnostic())).not.toContain("secret-value");
  });
  test("bounds adapter calls with an abortable timeout", async () => {
    const slow: UsageProvider = {
      id: "demo",
      fetchUsage: async () => {
        await Bun.sleep(100);
        // Integration-check the real AbortSignal timer because the adapter race uses platform timers.
        return null;
      },
    };
    const source = new ProviderEndpointUsageSource({
      credentials: [credential],
      adapters: [slow],
      timeoutMs: 5,
      now: () => 1_000,
    });
    expect(await source.refresh(new AbortController().signal)).toEqual([]);
    expect(source.diagnostic().lastErrorCategory).toBe("timeout");
  });
});
