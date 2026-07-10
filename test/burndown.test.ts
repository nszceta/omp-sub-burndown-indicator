import { describe, expect, test } from "bun:test";
import type { UsageLimit } from "@oh-my-pi/pi-ai";
import {
  calculateBurndownSegment,
  computeBurndownSegments,
  eligibleBurndownWindows,
  selectShortestBurndownWindow,
} from "../src/domain/burndown.ts";
import type { LimitObservation, SubscriptionSnapshot } from "../src/domain/types.ts";

const NOW = 1_000_000;
const observation = (
  id: string,
  durationMs: number | undefined,
  resetsAt: number | undefined,
  usedFraction: number | undefined,
  fetchedAt = NOW,
  stale = false,
): LimitObservation => {
  const limit: UsageLimit = {
    id,
    label: id,
    scope: { provider: "anthropic", windowId: id },
    ...(durationMs !== undefined || resetsAt !== undefined
      ? {
          window: {
            id,
            label: id,
            ...(durationMs !== undefined ? { durationMs } : {}),
            ...(resetsAt !== undefined ? { resetsAt } : {}),
          },
        }
      : {}),
    amount: { unit: "percent", ...(usedFraction !== undefined ? { usedFraction } : {}) },
  };
  return { limit, measurementSource: "omp-broker", fetchedAt, stale };
};

const snapshot = (limits: LimitObservation[]): SubscriptionSnapshot => ({
  id: "anthropic:account:a",
  provider: "anthropic",
  accountLabel: "A",
  identitySource: "omp-broker",
  limits,
});

describe("burndown window and pace", () => {
  test("eligibility requires finite usage, reset, and positive duration", () => {
    const valid = observation("valid", 100, NOW + 100, 0.2);
    const eligible = eligibleBurndownWindows(
      snapshot([
        valid,
        observation("no-duration", undefined, NOW + 100, 0.2),
        observation("no-reset", 100, undefined, 0.2),
        observation("zero", 0, NOW + 100, 0.2),
        observation("unknown-usage", 100, NOW + 100, undefined),
        observation("expired-reset", 100, NOW - 31, 0.2),
      ]),
      NOW,
      30,
    );
    expect(eligible.map((entry) => entry.observation.limit.id)).toEqual(["valid"]);
  });

  test("selects shortest positive duration independent of reset and quota", () => {
    const selected = selectShortestBurndownWindow(
      snapshot([
        observation("week", 700, NOW + 1, 0.99),
        observation("hour", 100, NOW + 500, 0.01),
      ]),
      NOW,
      0,
    );
    expect(selected?.observation.limit.id).toBe("hour");
  });

  test("uses reset timestamp then stable limit ID tie breakers", () => {
    const earlier = selectShortestBurndownWindow(
      snapshot([observation("z", 100, NOW + 200, 0.1), observation("a", 100, NOW + 100, 0.1)]),
      NOW,
      0,
    );
    expect(earlier?.observation.limit.id).toBe("a");
    const lexical = selectShortestBurndownWindow(
      snapshot([observation("z", 100, NOW + 100, 0.1), observation("a", 100, NOW + 100, 0.1)]),
      NOW,
      0,
    );
    expect(lexical?.observation.limit.id).toBe("a");
  });

  test("computes elapsed fraction and pace delta, with ahead/behind states", () => {
    const ahead = calculateBurndownSegment(snapshot([observation("w", 1_000, NOW + 500, 0.2)]), {
      now: NOW,
      paceTolerance: 0.01,
      clockSkewMs: 0,
    });
    expect(ahead.elapsedFraction).toBe(0.5);
    expect(ahead.paceDelta).toBeCloseTo(0.3);
    expect(ahead.state).toBe("ahead");
    const behind = calculateBurndownSegment(snapshot([observation("w", 1_000, NOW + 500, 0.8)]), {
      now: NOW,
      paceTolerance: 0.01,
      clockSkewMs: 0,
    });
    expect(behind.state).toBe("behind");
  });

  test("treats exact tolerance as on pace and exhaustion as an override", () => {
    const onPace = calculateBurndownSegment(snapshot([observation("w", 1_000, NOW + 500, 0.49)]), {
      now: NOW,
      paceTolerance: 0.01,
      clockSkewMs: 0,
    });
    expect(onPace.paceDelta).toBeCloseTo(0.01);
    expect(onPace.state).toBe("on-pace");
    const exhausted = calculateBurndownSegment(
      snapshot([observation("w", 1_000, NOW + 500, 1.2)]),
      { now: NOW, paceTolerance: 0.01, clockSkewMs: 0 },
    );
    expect(exhausted.state).toBe("exhausted");
    expect(exhausted.usedFraction).toBe(1.2);
  });

  test("clamps elapsed display pace at window boundaries and handles reset skew", () => {
    const atStart = calculateBurndownSegment(snapshot([observation("w", 1_000, NOW - 999, 0)]), {
      now: NOW,
      clockSkewMs: 1_000,
    });
    expect(atStart.elapsedFraction).toBe(1);
    const tooOld = calculateBurndownSegment(snapshot([observation("w", 1_000, NOW - 1_001, 0)]), {
      now: NOW,
      clockSkewMs: 1_000,
    });
    expect(tooOld.state).toBe("unknown");
  });

  test("expires old observations and reports no eligible windows as unknown", () => {
    const old = calculateBurndownSegment(
      snapshot([observation("w", 1_000, NOW + 500, 0.2, NOW - 101)]),
      { now: NOW, staleAfterMs: 100 },
    );
    expect(old.state).toBe("unknown");
    expect(old.stale).toBe(true);
    const unknown = calculateBurndownSegment(
      snapshot([observation("bad", undefined, NOW + 500, 0.2)]),
      { now: NOW },
    );
    expect(unknown.state).toBe("unknown");
    expect(unknown.stale).toBe(false);
  });

  test("computes one segment per subscription with stable IDs", () => {
    const segments = computeBurndownSegments(
      [
        snapshot([observation("a", 100, NOW + 50, 0.1)]),
        { ...snapshot([]), id: "anthropic:account:b" },
      ],
      { now: NOW, clockSkewMs: 0 },
    );
    expect(segments.map((segment) => segment.subscriptionId)).toEqual([
      "anthropic:account:a",
      "anthropic:account:b",
    ]);
    expect(segments[1]?.state).toBe("unknown");
  });
});
