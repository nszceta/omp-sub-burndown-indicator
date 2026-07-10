import { describe, expect, test } from "bun:test";
import type { UsageLimit, UsageProvider, UsageReport } from "@oh-my-pi/pi-ai";
import type { SubscriptionSnapshot } from "../src/domain/types.ts";
import { ResponseHeaderUsageSource } from "../src/sources/response-headers.ts";

const limit = (usedFraction: number, resetsAt = 2_000): UsageLimit => ({
  id: "demo:window",
  label: "Demo",
  scope: { provider: "demo", windowId: "short" },
  window: { id: "short", label: "Short", durationMs: 1_000, resetsAt },
  amount: { unit: "percent", usedFraction },
});

function parser(reportLimit: UsageLimit = limit(0.2)): UsageProvider {
  return {
    id: "demo",
    fetchUsage: async () => null,
    parseRateLimitHeaders(headers, now = Date.now()): UsageReport | null {
      if (headers["x-demo-used"] === undefined || headers["x-demo-reset"] === undefined)
        return null;
      return { provider: "demo", fetchedAt: now, limits: [reportLimit] };
    },
  };
}

const authoritative = (id: string): SubscriptionSnapshot => ({
  id,
  provider: "demo",
  identitySource: "omp-broker",
  limits: [],
});

describe("ResponseHeaderUsageSource", () => {
  test("normalizes headers and updates the one authoritative subscription", () => {
    const seen: Record<string, string> = {};
    const source = new ResponseHeaderUsageSource({
      providers: [
        {
          ...parser(),
          parseRateLimitHeaders(headers, now = Date.now()) {
            Object.assign(seen, headers);
            return { provider: "demo", fetchedAt: now, limits: [limit(0.2)] };
          },
        },
      ],
    });
    source.setAuthoritativeSnapshots([authoritative("demo:account:a")]);
    expect(source.ingest("demo", { "X-Demo-Used": "20", "X-Demo-Reset": "2000" }, 1_000)).toBe(
      true,
    );
    expect(seen).toEqual({ "x-demo-used": "20", "x-demo-reset": "2000" });
    expect(source.current()[0]?.limits[0]?.measurementSource).toBe("omp-response");
  });

  test("rejects ambiguous providers and never creates an identity", () => {
    const source = new ResponseHeaderUsageSource({ providers: [parser()] });
    source.setAuthoritativeSnapshots([authoritative("demo:a"), authoritative("demo:b")]);
    expect(source.ingest("demo", { "x-demo-used": "20", "x-demo-reset": "2000" }, 1_000)).toBe(
      false,
    );
    source.setAuthoritativeSnapshots([]);
    expect(source.ingest("demo", { "x-demo-used": "20", "x-demo-reset": "2000" }, 1_000)).toBe(
      false,
    );
    expect(source.current()).toHaveLength(0);
  });

  test("ignores unsupported and partial header sets", () => {
    const source = new ResponseHeaderUsageSource({ providers: [parser()] });
    source.setAuthoritativeSnapshots([authoritative("demo:a")]);
    expect(source.ingest("other", { "x-demo-used": "20", "x-demo-reset": "2000" })).toBe(false);
    expect(source.ingest("demo", { "x-demo-used": "20" })).toBe(false);
    expect(source.current()[0]?.limits).toHaveLength(0);
  });
});
