import { describe, expect, test } from "bun:test";
import type { UsageResponse } from "@oh-my-pi/pi-ai";
import { OmpBrokerUsageSource } from "../src/sources/omp-broker.ts";
import { UsageSourceError } from "../src/sources/source.ts";

const token = "broker-secret-token";
const limit = {
  id: "five-hour",
  label: "5 Hour",
  scope: { provider: "claude", accountId: "account-a" },
  window: { id: "5h", label: "5 Hour", durationMs: 18_000_000, resetsAt: 20_000 },
  amount: { usedFraction: 0.25, unit: "percent" as const },
};

function response(
  reports: UsageResponse["reports"] = [
    { provider: "claude", fetchedAt: 1_000, limits: [limit], metadata: { accountId: "account-a" } },
  ],
): UsageResponse {
  return { generatedAt: 9_999, reports };
}

async function serve(handler: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ port: 0, fetch: handler });
  return { server, url: server.url.toString().replace(/\/$/, "") };
}

function source(
  url: string,
  options: { now?: () => number; timeoutMs?: number; staleAfterMs?: number } = {},
) {
  return new OmpBrokerUsageSource({
    broker: { url, token },
    ...options,
  });
}

describe("OmpBrokerUsageSource", () => {
  test("fetches and normalizes multiple stable accounts with report timestamps", async () => {
    const { server, url } = await serve(() =>
      Response.json(
        response([
          {
            provider: "claude",
            fetchedAt: 1_000,
            limits: [limit],
            metadata: { accountId: "account-a", accountLabel: "a@example.test" },
          },
          {
            provider: "claude",
            fetchedAt: 1_000,
            limits: [{ ...limit, scope: { provider: "claude", accountId: "account-b" } }],
            metadata: { accountId: "account-b", accountLabel: "b@example.test" },
          },
        ]),
      ),
    );
    try {
      const snapshots = await source(url, { now: () => 1_000 }).refresh(
        new AbortController().signal,
      );
      expect(snapshots).toHaveLength(2);
      expect(snapshots.map((item) => item.id)).toEqual([
        "claude:account:account-a",
        "claude:account:account-b",
      ]);
      expect(snapshots[0]?.limits[0]?.fetchedAt).toBe(1_000);
      expect(snapshots[0]?.limits[0]?.stale).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test("reports malformed schema as schema error without exposing body or token", async () => {
    const secretBody = `invalid response ${token}`;
    const { server, url } = await serve(() => new Response(secretBody, { status: 200 }));
    try {
      const broker = source(url);
      const error = await broker.refresh(new AbortController().signal).catch((value) => value);
      expect(error).toBeInstanceOf(UsageSourceError);
      expect((error as UsageSourceError).category).toBe("schema");
      expect(String(error)).not.toContain(token);
      expect(JSON.stringify(broker.diagnostic())).not.toContain(token);
    } finally {
      server.stop(true);
    }
  });

  for (const [status, category] of [
    [401, "auth"],
    [429, "rate-limit"],
    [503, "server"],
  ] as const) {
    test(`categorizes HTTP ${status}`, async () => {
      const { server, url } = await serve(() => new Response(`secret ${token}`, { status }));
      try {
        const error = await source(url)
          .refresh(new AbortController().signal)
          .catch((value) => value);
        expect(error).toBeInstanceOf(UsageSourceError);
        expect((error as UsageSourceError).category).toBe(category);
        expect(String(error)).not.toContain(token);
      } finally {
        server.stop(true);
      }
    });
  }

  test("composes timeout and caller abort", async () => {
    const { server, url } = await serve(async () => {
      await Bun.sleep(100);
      return Response.json(response());
    });
    try {
      const timed = await source(url, { timeoutMs: 10 })
        .refresh(new AbortController().signal)
        .catch((value) => value);
      expect((timed as UsageSourceError).category).toBe("timeout");

      const controller = new AbortController();
      const abortedPromise = source(url, { timeoutMs: 1_000 }).refresh(controller.signal);
      controller.abort();
      const aborted = await abortedPromise.catch((value) => value);
      expect((aborted as UsageSourceError).category).toBe("aborted");
    } finally {
      server.stop(true);
    }
  });

  test("joins concurrent refresh calls into one HTTP request", async () => {
    let requests = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { server, url } = await serve(async () => {
      requests += 1;
      await gate;
      return Response.json(response());
    });
    try {
      const broker = source(url);
      const first = broker.refresh(new AbortController().signal);
      const second = broker.refresh(new AbortController().signal);
      release();
      const [a, b] = await Promise.all([first, second]);
      expect(requests).toBe(1);
      expect(a).toEqual(b);
    } finally {
      server.stop(true);
    }
  });

  test("preserves last-good data as stale, then expires it by max age", async () => {
    let now = 1_000;
    let fail = false;
    const client = {
      fetchUsage: async () => {
        if (fail) throw new Error("network unavailable");
        return response();
      },
    };
    const broker = new OmpBrokerUsageSource({ client, now: () => now, staleAfterMs: 100 });
    const fresh = await broker.refresh(new AbortController().signal);
    expect(fresh[0]?.limits[0]?.stale).toBe(false);
    fail = true;
    now = 1_050;
    const stale = await broker.refresh(new AbortController().signal);
    expect(stale[0]?.limits[0]?.stale).toBe(true);
    now = 1_101;
    expect(await broker.refresh(new AbortController().signal)).toEqual([]);
    expect(broker.diagnostic().lastErrorCategory).toBe("network");
  });
});
