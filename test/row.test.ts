import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import type { BurndownSegment } from "../src/domain/types";
import { buildStableLabels } from "../src/render/labels";
import { BurndownRowComponent, renderBurndownRow } from "../src/render/row";

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
    expect(unicode).toContain("▲12");
    expect(unicode).toContain("▼4");
    expect(unicode).toContain("=0");
    expect(unicode).toContain("!");
    expect(unicode).toContain("?");
    expect(unicode).toContain("~▲10");
    expect(ascii).toContain("+12");
    expect(ascii).toContain("-4");
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
