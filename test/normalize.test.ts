import { describe, expect, test } from "bun:test";
import type { UsageLimit, UsageReport } from "@oh-my-pi/pi-ai";
import { normalizeUsageReport, normalizeUsageReports } from "../src/domain/normalize.ts";

const limit = (id: string, accountId?: string): UsageLimit => ({
  id,
  label: id,
  scope: { provider: "anthropic", ...(accountId ? { accountId } : {}) },
  window: { id: "5h", label: "5 hours", durationMs: 18_000_000, resetsAt: 2_000_000 },
  amount: { usedFraction: 0.2, unit: "percent" },
});

const report = (overrides: Partial<UsageReport> = {}): UsageReport => ({
  provider: "anthropic",
  fetchedAt: 1_000_000,
  limits: [limit("5h", "acct-a")],
  ...overrides,
});

describe("usage report normalization", () => {
  test("uses account identity, source, measurement timestamp, and stale age", () => {
    const snapshot = normalizeUsageReport(report(), {
      measurementSource: "omp-response",
      now: 1_000_101,
      staleAfterMs: 100,
    });
    expect(snapshot?.id).toBe("anthropic:account:acct-a");
    expect(snapshot?.identitySource).toBe("omp-response");
    expect(snapshot?.limits[0]).toMatchObject({ fetchedAt: 1_000_000, stale: true });
  });

  test("falls back to project, organization, then broker account key", () => {
    const project = normalizeUsageReport(
      report({
        limits: [{ ...limit("p"), scope: { provider: "anthropic", projectId: "project-1" } }],
      }),
    );
    const org = normalizeUsageReport(
      report({ limits: [{ ...limit("o"), scope: { provider: "anthropic", orgId: "org-1" } }] }),
    );
    const key = normalizeUsageReport(
      report({ limits: [limit("k")], metadata: { accountKey: "broker-key" } }),
    );
    expect(project?.id).toBe("anthropic:project:project-1");
    expect(org?.id).toBe("anthropic:org:org-1");
    expect(key?.id).toBe("anthropic:account-key:broker-key");
  });

  test("does not use mutable labels or credentials as identity", () => {
    const first = report({
      limits: [{ ...limit("x"), scope: { provider: "anthropic" } }],
      metadata: { accountLabel: "Personal", token: "secret" },
    });
    const second = report({
      limits: [{ ...limit("x"), scope: { provider: "anthropic" } }],
      metadata: { accountLabel: "Renamed", token: "other" },
    });
    const normalized = normalizeUsageReports([first, second]);
    expect(normalized.snapshots).toHaveLength(0);
    expect(normalized.diagnostics.every((entry) => entry.reason === "ambiguous-identity")).toBe(
      true,
    );
  });

  test("permits provider-only identity only when one report proves uniqueness", () => {
    const anonymous = report({ limits: [{ ...limit("x"), scope: { provider: "anthropic" } }] });
    const one = normalizeUsageReports([anonymous]);
    expect(one.snapshots).toHaveLength(1);
    expect(one.snapshots[0]?.id).toBe("provider:anthropic");

    const many = normalizeUsageReports([anonymous, { ...anonymous, fetchedAt: 1_000_001 }]);
    expect(many.snapshots).toHaveLength(0);
    expect(many.diagnostics).toHaveLength(2);
    expect(many.diagnostics[0]?.reason).toBe("ambiguous-identity");
  });

  test("rejects conflicting scope identities and retains distinct accounts", () => {
    const conflicting = report({ limits: [limit("a", "acct-a"), limit("b", "acct-b")] });
    expect(normalizeUsageReports([conflicting]).diagnostics[0]?.reason).toBe("ambiguous-identity");
    const distinct = normalizeUsageReports([report(), report({ limits: [limit("5h", "acct-b")] })]);
    expect(distinct.snapshots.map((snapshot) => snapshot.id)).toEqual([
      "anthropic:account:acct-a",
      "anthropic:account:acct-b",
    ]);
  });

  test("merges split reports for one stable account using newest limit observation", () => {
    const newer = report({ fetchedAt: 2_000_000, limits: [limit("5h", "acct-a")] });
    const older = report({ limits: [limit("7d", "acct-a")] });
    const result = normalizeUsageReports([newer, older]);
    expect(result.snapshots).toHaveLength(1);
    expect(result.snapshots[0]?.limits.map((entry) => entry.limit.id)).toEqual(["5h", "7d"]);
  });
});
