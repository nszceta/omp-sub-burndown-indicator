import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import type { BurndownSegment } from "../src/domain/types";
import { buildStableLabels } from "../src/render/labels";
import { BurndownRowComponent, formatResetCountdown, renderBurndownRow } from "../src/render/row";

const now = 1_700_000_000_000;
const segment = (
  id: string,
  state: BurndownSegment["state"],
  paceDelta?: number,
  extra: Partial<BurndownSegment> = {},
): BurndownSegment => ({
  subscriptionId: id,
  provider: "provider",
  label: id,
  state,
  stale: false,
  ...(paceDelta === undefined ? {} : { paceDelta }),
  ...extra,
});

const identityTheme = { fg: (_color: string, text: string) => text };

describe("burndown row", () => {
  test("shows precise minute granularity for every reset duration", () => {
    expect(formatResetCountdown(now + 2 * 60 * 60_000 + 30 * 60_000, now)).toBe("2h30m");
    expect(formatResetCountdown(now + 2 * 60 * 60_000, now)).toBe("2h");
    expect(formatResetCountdown(now + 2 * 60 * 60_000 + 1, now)).toBe("2h1m");
    expect(formatResetCountdown(now + 6 * 24 * 60 * 60_000 + 4 * 60 * 60_000 + 60_001, now)).toBe(
      "6d4h2m",
    );
  });
  test("shows quota left and the detailed reset in the full form", () => {
    const value = segment("codex", "behind", -0.61, {
      resetsAt: now + 6 * 24 * 60 * 60_000 + 4 * 60 * 60_000 + 60_001,
      usedFraction: 0.88,
    });
    expect(renderBurndownRow([value], 200, { now, theme: identityTheme })).toEqual([
      "Provider ▼61 points behind · 12% left · 6d4h2m",
    ]);
  });

  test("renders every state and both symbol modes", () => {
    const segments = [
      segment("a", "ahead", 0.12),
      segment("b", "behind", -0.04),
      segment("c", "on-pace", 0),
      segment("d", "exhausted", 0),
      segment("e", "unknown"),
      segment("f", "ahead", 0.1, { stale: true }),
    ];
    const unicode = renderBurndownRow(segments, 200, { now, theme: identityTheme }).join("");
    const ascii = renderBurndownRow(segments, 200, {
      now,
      symbols: "ascii",
      theme: identityTheme,
    }).join("");
    expect(unicode).toContain("▲12 points ahead");
    expect(unicode).toContain("▼4 points behind");
    expect(unicode).toContain("=0 points on pace");
    expect(unicode).toContain("! exhausted");
    expect(unicode).toContain("? unknown");
    expect(unicode).toContain("~▲10 points ahead (stale)");
    expect(ascii).toContain("+12 points ahead");
    expect(ascii).toContain("-4 points behind");
  });

  test("fits exact visible width and emits no line when no signal fits", () => {
    const value = segment("Claude", "ahead", 0.12, { resetsAt: now + 2 * 60 * 60 * 1000 });
    const line = renderBurndownRow([value], 10, { now, theme: identityTheme });
    expect(line).toHaveLength(1);
    expect(visibleWidth(line[0] ?? "")).toBeLessThanOrEqual(10);
    expect(renderBurndownRow([value], 3, { now })).toEqual([]);
  });

  test("retains urgent segments first and reports hidden count", () => {
    const values = [
      segment("ahead", "ahead", 0.5),
      segment("behind", "behind", -0.9),
      segment("pace", "on-pace", 0),
    ];
    const line = renderBurndownRow(values, 12, { now, theme: identityTheme });
    expect(line).toHaveLength(1);
    expect(line[0]).toContain("▼90");
    expect(line[0]).toContain("+2");
  });

  test("disambiguates labels independently of input order", () => {
    const values = [
      segment("b", "ahead", 0.1, { label: "Claude" }),
      segment("a", "ahead", 0.1, { label: "Claude" }),
    ];
    const first = buildStableLabels(values);
    const second = buildStableLabels([...values].reverse());
    expect(first.compact.get("a")).toBe(second.compact.get("a"));
    expect(first.compact.get("b")).toBe(second.compact.get("b"));
    expect(first.compact.get("a")).not.toBe(first.compact.get("b"));
  });

  test("always shows providers and hides singleton account identifiers", () => {
    const values = [
      segment("anthropic-account", "ahead", 0.1, {
        provider: "anthropic",
        label: "hi@adamgradzki.com",
      }),
      segment("openai-account", "ahead", 0.1, {
        provider: "openai-codex",
        label: "hi@adamgradzki.com",
      }),
    ];

    const full = renderBurndownRow(values, 100, {
      now,
      showReset: false,
      theme: identityTheme,
    }).join("");
    expect(full).toBe("Anthropic ▲10 points ahead · OpenAI Codex ▲10 points ahead");
    expect(full).not.toContain("adamgradzki");
    expect(full).not.toContain("#2");

    const minimal = renderBurndownRow(values, 14, {
      now,
      showReset: false,
      theme: identityTheme,
    }).join("");
    expect(minimal).toBe("An▲10 · OC▲10");
  });

  test("shows intuitive account labels only for multiple accounts on one provider", () => {
    const values = [
      segment("account-a", "ahead", 0.1, {
        provider: "anthropic",
        label: "hi@adamgradzki.com",
      }),
      segment("account-b", "ahead", 0.1, {
        provider: "anthropic",
        label: "work@adamgradzki.com",
      }),
    ];
    const labels = buildStableLabels(values);
    expect(labels.compact.get("account-a")).toBe("hi");
    expect(labels.compact.get("account-b")).toBe("wo");

    const full = renderBurndownRow(values, 100, {
      now,
      showReset: false,
      theme: identityTheme,
    }).join("");
    expect(full).toContain("Anthropic:hi@adamgradzki.com ▲10 points ahead");
    expect(full).toContain("Anthropic:work@adamgradzki.com ▲10 points ahead");

    const minimal = renderBurndownRow(values, 17, {
      now,
      showReset: false,
      theme: identityTheme,
    }).join("");
    expect(minimal).toBe("An:h▲10 · An:w▲10");
  });

  test("marks true same-provider label collisions with an explicit ordinal", () => {
    const labels = buildStableLabels([
      segment("account-a", "ahead", 0.1, {
        provider: "anthropic",
        label: "hi@adamgradzki.com",
      }),
      segment("account-b", "ahead", 0.1, {
        provider: "anthropic",
        label: "hi@adamgradzki.com",
      }),
    ]);
    expect(labels.full.get("account-a")).toBe("hi@adamgradzki.com");
    expect(labels.full.get("account-b")).toBe("hi@adamgradzki.com#2");
    expect(labels.compact.get("account-b")).toBe("hi#2");
  });

  test("component caches byte-identical output arrays", () => {
    const component = new BurndownRowComponent(identityTheme, { now, showReset: false });
    component.setSegments([segment("a", "ahead", 0.1)]);
    const first = component.render(30);
    const second = component.render(30);
    expect(second).toBe(first);
    expect(component.setSegments([segment("a", "ahead", 0.1)])).toBe(false);
    component.setSegments([segment("a", "behind", -0.1)]);
    expect(component.render(30)).not.toBe(first);
  });
});
