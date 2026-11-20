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
  extra: Partial<BurndownSegment> & { accountId?: string; tier?: string } = {},
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
    expect(renderBurndownRow([value], 200, { now, theme: identityTheme, density: "text" })).toEqual(
      ["Provider ▼61 points behind · 12% left · 6d4h2m"],
    );
  });

  test("appends semantic window labels without changing subscription identity", () => {
    const fiveHour = segment("kimi", "ahead", 0.51, {
      provider: "kimi-code",
      label: "Kimi",
      windowClass: "five_hour",
      windowLabel: "5h",
      usedFraction: 0,
      resetsAt: now + 2 * 60 * 60_000 + 28 * 60_000,
    });
    const week = segment("kimi", "ahead", 0.12, {
      provider: "kimi-code",
      label: "Kimi",
      windowClass: "week",
      windowLabel: "Wk",
      usedFraction: 0.12,
      resetsAt: now + 2 * 24 * 60 * 60_000 + 7 * 60 * 60_000 + 25 * 60_000,
    });
    expect(
      renderBurndownRow([fiveHour, week], 300, { now, theme: identityTheme, density: "dense" }),
    ).toEqual(["Kimi Code 5h ▲51pp · 100% left · 2h28m · Kimi Code Wk ▲12pp · 88% left · 2d7h25m"]);
  });

  test("applies privacy, truncation, and exhausted display controls", () => {
    const values = [
      segment("first", "exhausted", undefined, {
        provider: "openai-codex",
        label: "work@example.test",
        accountId: "first",
        usedFraction: 1,
        resetsAt: now + 60 * 60_000,
      }),
      segment("second", "ahead", 0.1, {
        provider: "openai-codex",
        label: "personal@example.test",
        accountId: "second",
      }),
    ];
    const rendered = renderBurndownRow(values, 200, {
      now,
      theme: identityTheme,
      accountLabels: "masked",
      exhaustedDisplay: "reset",
      exhaustedLabel: "symbol",
      providerLabelMaxColumns: 8,
    }).join("");
    expect(rendered).toContain("OpenAI …:wor*** !");
    expect(rendered).toContain("OpenAI …:per***");
    expect(rendered).not.toContain("100% left");
    expect(rendered).toContain("1h");
  });

  test("keeps masked account labels distinct when local parts share a prefix", () => {
    const values = [
      segment("a", "ahead", 0.1, {
        provider: "kimi-code",
        label: "dev.account7@example.test",
        accountId: "a",
      }),
      segment("b", "ahead", 0.1, {
        provider: "kimi-code",
        label: "dev.account7@example.invalid",
        accountId: "b",
      }),
    ];
    const render = (input: BurndownSegment[]): string =>
      renderBurndownRow(input, 300, {
        now,
        theme: identityTheme,
        accountLabels: "masked",
      }).join("");
    const rendered = render(values);
    expect(rendered).toContain("Kimi Code:dev***");
    expect(rendered).toContain("Kimi Code:dev***#2");
    // Masking must not disclose the domain, and must stay stable under reordering.
    expect(rendered).not.toContain("@");
    expect(render([...values].reverse())).toBe(rendered);
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
    const unicode = renderBurndownRow(segments, 200, {
      now,
      density: "text",
      theme: identityTheme,
    }).join("");
    const ascii = renderBurndownRow(segments, 200, {
      now,
      density: "text",
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

  test("uses dense pace signals in full forms by default", () => {
    const segments = [
      segment("a", "ahead", 0.12),
      segment("b", "behind", -0.04),
      segment("c", "on-pace", 0),
      segment("d", "exhausted", 0),
      segment("e", "unknown"),
      segment("f", "ahead", 0.1, { stale: true }),
    ];
    const unicode = renderBurndownRow(segments, 200, {
      now,
      theme: identityTheme,
    }).join("");
    const ascii = renderBurndownRow(segments, 200, {
      now,
      symbols: "ascii",
      theme: identityTheme,
    }).join("");
    expect(unicode).toContain("▲12pp");
    expect(unicode).toContain("▼4pp");
    expect(unicode).toContain("=0pp");
    expect(unicode).toContain("! exhausted");
    expect(unicode).toContain("? unknown");
    expect(unicode).toContain("~▲10pp (stale)");
    expect(unicode).not.toContain("points ahead");
    expect(unicode).not.toContain("points behind");
    expect(ascii).toContain("+12pp");
    expect(ascii).toContain("-4pp");
  });

  test("fits exact visible width and emits no line when no signal fits", () => {
    const value = segment("Claude", "ahead", 0.12, { resetsAt: now + 2 * 60 * 60 * 1000 });
    const fits = renderBurndownRow([value], 13, { now, theme: identityTheme });
    expect(fits).toEqual(["Provider ▲12"]);
    expect(visibleWidth(fits[0] ?? "")).toBeLessThanOrEqual(12);
    expect(renderBurndownRow([value], 12, { now })).toEqual([]);
  });

  test("prefers full quota detail on ~52-col panes and reflows on resize", () => {
    const values = [
      segment("codex", "behind", -0.21, {
        provider: "openai-codex",
        label: "Codex",
        windowClass: "week",
        windowLabel: "Wk",
        usedFraction: 0.72,
        resetsAt: now + 3 * 24 * 60 * 60_000,
      }),
      segment("anth5", "unknown", undefined, {
        provider: "anthropic",
        label: "A",
        windowClass: "five_hour",
        windowLabel: "5h",
        usedFraction: 0,
      }),
      segment("kimi5", "ahead", 0.87, {
        accountId: "kimi",
        provider: "kimi-code",
        label: "Kimi",
        windowClass: "five_hour",
        windowLabel: "5h",
        usedFraction: 0,
        resetsAt: now + 85 * 60_000,
      }),
      segment("kimiW", "unknown", undefined, {
        accountId: "kimi",
        provider: "kimi-code",
        label: "Kimi",
        windowClass: "week",
        windowLabel: "Wk",
        usedFraction: 0.88,
        resetsAt: now + 2 * 24 * 60 * 60_000 + 5 * 60 * 60_000 + 40 * 60_000,
      }),
    ];
    const component = new BurndownRowComponent(identityTheme, {
      now,
      density: "dense",
      showReset: true,
      layout: "wrap",
    });
    component.setSegments(values);

    // ~1/3 MBA pane content width observed via herdr borders.
    const pane = component.render(52);
    const text = pane.join("\n");
    expect(text).toContain("% left");
    expect(text).toContain("OpenAI Codex Wk");
    expect(text).toContain("28% left");
    expect(text).toContain("Anthropic 5h");
    expect(text).toContain("100% left");
    expect(text).toContain("Kimi Code 5h");
    expect(text).toContain("Kimi Code Wk");
    expect(text).toContain("12% left");
    expect(text).toContain("2d5h40m");
    for (const line of pane) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(51);
      expect(line).not.toMatch(/Code▲|Codex▼|Wk\?/u);
    }

    const wide = component.render(200).join("\n");
    expect(wide).toContain("OpenAI Codex Wk ▼21pp · 28% left · 3d");
    expect(wide).toContain("Kimi Code Wk");
    expect(wide).toContain("12% left · 2d5h40m");
    expect(wide).toContain("Anthropic 5h · 100% left");
    expect(wide).not.toContain("Anthropic 5h ? unknown");

    expect(component.render(52)).toEqual(pane);
  });

  test("skips an unrenderable segment and keeps later fit-capable segments", () => {
    const tooWide = segment("too-wide", "behind", -123.45, {
      provider: "very-long-provider-name-that-cannot-fit",
      windowLabel: "Wk",
    });
    const later = segment("later", "on-pace", 0, { provider: "x" });
    const lines = renderBurndownRow([tooWide, later], 8, { now, theme: identityTheme });
    expect(lines.join("")).toContain("X");
    expect(renderBurndownRow([tooWide], 8, { now, theme: identityTheme })).toEqual([]);
  });

  test("keeps stale marker on stale unknown rows even with percent left", () => {
    const stale = segment("codex", "unknown", undefined, {
      provider: "openai-codex",
      label: "Codex",
      windowClass: "week",
      windowLabel: "Wk",
      usedFraction: 0.5,
      resetsAt: now + 24 * 60 * 60_000,
      stale: true,
    });
    const lines = renderBurndownRow([stale], 200, { now, theme: identityTheme });
    expect(lines.join("")).toContain("~");
    expect(lines.join("")).toContain("stale");
    expect(lines.join("")).toContain("50% left");
  });

  test("disambiguates labels independently of input order", () => {
    const values = [
      segment("b", "ahead", 0.1, { label: "Claude" }),
      segment("a", "ahead", 0.1, { label: "Claude" }),
    ];
    const first = buildStableLabels(values);
    const second = buildStableLabels([...values].reverse());
    expect(first.full.get("a")).toBe(second.full.get("a"));
    expect(first.full.get("b")).toBe(second.full.get("b"));
    expect(first.full.get("a")).not.toBe(first.full.get("b"));
  });

  test("always shows full providers and hides singleton account identifiers", () => {
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
      density: "text",
      showReset: false,
      theme: identityTheme,
    }).join("");
    expect(full).toBe("Anthropic ▲10 points ahead · OpenAI Codex ▲10 points ahead");
    expect(full).not.toContain("adamgradzki");
    expect(full).not.toContain("#2");

    const minimal = renderBurndownRow(values, 17, {
      now,
      showReset: false,
      theme: identityTheme,
    });
    expect(minimal).toEqual(["Anthropic ▲10pp", "OpenAI Codex ▲10"]);
    expect(minimal.join("")).not.toMatch(/\b(?:An|OC)▲/u);
  });

  test("keeps base and Spark quotas under one account without qualification", () => {
    const values = [
      segment("base", "ahead", 0.1, {
        provider: "openai-codex",
        label: "user@example.test",
        accountId: "account-a",
      }),
      segment("spark", "ahead", 0.1, {
        provider: "openai-codex",
        label: "user@example.test",
        accountId: "account-a",
        tier: "spark",
      }),
    ];
    const labels = buildStableLabels(values);
    expect(labels.providerFull.get("base")).toBe("OpenAI Codex");
    expect(labels.providerFull.get("spark")).toBe("OpenAI Codex Spark");
    expect(labels.full.get("base")).toBe("user@example.test");
    expect(labels.full.get("spark")).toBe("user@example.test");
    expect(labels.accountRequired.size).toBe(0);

    const full = renderBurndownRow(values, 100, {
      now,
      density: "text",
      showReset: false,
      theme: identityTheme,
    }).join("");
    expect(full).toBe("OpenAI Codex ▲10 points ahead · OpenAI Codex Spark ▲10 points ahead");
    expect(full).not.toContain("user@example.test");
  });

  test("qualifies base and Spark providers when a second account exists", () => {
    const values = [
      segment("base-a", "ahead", 0.1, {
        provider: "openai-codex",
        label: "user@example.test",
        accountId: "account-a",
      }),
      segment("spark-a", "ahead", 0.1, {
        provider: "openai-codex",
        label: "user@example.test",
        accountId: "account-a",
        tier: "spark",
      }),
      segment("base-b", "ahead", 0.1, {
        provider: "openai-codex",
        label: "work@example.test",
        accountId: "account-b",
      }),
    ];
    const labels = buildStableLabels(values);
    expect(labels.providerFull.get("base-a")).toBe("OpenAI Codex");
    expect(labels.providerFull.get("spark-a")).toBe("OpenAI Codex Spark");
    expect(labels.providerFull.get("base-b")).toBe("OpenAI Codex");
    expect(labels.full.get("base-a")).toBe("user@example.test");
    expect(labels.full.get("spark-a")).toBe("user@example.test");
    expect(labels.full.get("base-b")).toBe("work@example.test");
    expect(labels.accountRequired).toEqual(new Set(["base-a", "base-b", "spark-a"]));

    const full = renderBurndownRow(values, 200, {
      now,
      density: "text",
      showReset: false,
      theme: identityTheme,
    }).join("");
    expect(full).toContain("OpenAI Codex:user@example.test ▲10 points ahead");
    expect(full).toContain("OpenAI Codex Spark:user@example.test ▲10 points ahead");
    expect(full).toContain("OpenAI Codex:work@example.test ▲10 points ahead");
    expect(full).not.toContain("#2");
  });

  test("uses complete account labels for multiple accounts on one provider", () => {
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
    expect(labels.full.get("account-a")).toBe("hi@adamgradzki.com");
    expect(labels.full.get("account-b")).toBe("work@adamgradzki.com");

    const full = renderBurndownRow(values, 100, {
      now,
      showReset: false,
      density: "text",
      theme: identityTheme,
    }).join("");
    expect(full).toContain("Anthropic:hi@adamgradzki.com ▲10 points ahead");
    expect(full).toContain("Anthropic:work@adamgradzki.com ▲10 points ahead");

    const minimal = renderBurndownRow(values, 35, {
      now,
      showReset: false,
      theme: identityTheme,
    });
    expect(minimal).toEqual([
      "Anthropic:hi@adamgradzki.com ▲10pp",
      "Anthropic:work@adamgradzki.com ▲10",
    ]);
    expect(minimal.join("")).not.toMatch(/An:[hw]▲/u);
    expect(
      renderBurndownRow(values, 17, {
        now,
        showReset: false,
        theme: identityTheme,
      }),
    ).toEqual([]);
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

  test("wrap layout keeps full details and wraps whole segments to extra lines", () => {
    const values = [
      segment("one", "exhausted", 0, {
        provider: "alpha",
        usedFraction: 1,
        resetsAt: now + 4 * 24 * 60 * 60_000,
      }),
      segment("two", "behind", -0.8, {
        provider: "bravo",
        usedFraction: 0.9,
        resetsAt: now + 6 * 24 * 60 * 60_000,
      }),
      segment("three", "ahead", 0.23, {
        provider: "charlie",
        usedFraction: 0.22,
        resetsAt: now + 3 * 60 * 60_000,
      }),
      segment("four", "on-pace", 0, {
        provider: "delta",
        usedFraction: 0.5,
        resetsAt: now + 2 * 60 * 60_000,
      }),
    ];
    const width = 100;
    const fit = renderBurndownRow(values, width, { now, theme: identityTheme });
    expect(fit).toHaveLength(1);
    expect(fit.join(" ")).not.toContain("50% left");

    const wrapped = renderBurndownRow(values, width, {
      now,
      theme: identityTheme,
      layout: "wrap",
    });
    expect(wrapped.length).toBeGreaterThan(1);
    for (const line of wrapped) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    const all = wrapped.join(" · ");
    expect(all).toContain("Alpha ! exhausted · 0% left");
    expect(all).toContain("Delta");
    expect(all).toContain("50% left");
    expect(all.indexOf("Alpha")).toBeLessThan(all.indexOf("Delta"));
  });

  test("wrap layout matches fit layout when every full form fits one line", () => {
    const values = [
      segment("one", "ahead", 0.1, { provider: "alpha", resetsAt: now + 2 * 60 * 60_000 }),
      segment("two", "behind", -0.1, { provider: "bravo", resetsAt: now + 3 * 60 * 60_000 }),
    ];
    const options = { now, theme: identityTheme } as const;
    expect(renderBurndownRow(values, 200, { ...options, layout: "wrap" })).toEqual(
      renderBurndownRow(values, 200, options),
    );
  });

  test("wrap layout still degrades a single segment whose full form exceeds the width", () => {
    const value = segment("only", "ahead", 0.12, {
      provider: "alpha",
      resetsAt: now + 2 * 60 * 60_000,
    });
    const lines = renderBurndownRow([value], 10, { now, theme: identityTheme, layout: "wrap" });
    expect(lines).toEqual(["Alpha ▲12"]);
    expect(visibleWidth(lines[0] ?? "")).toBeLessThanOrEqual(9);
  });

  test("describes a native wrapping row of whole, keyed segments for Tern", () => {
    const codex = segment("codex", "ahead", 0.01, {
      provider: "openai-codex",
      label: "OpenAI Codex",
      windowId: "5h",
      windowLabel: "5h",
      usedFraction: 0,
      resetsAt: now + 4 * 60 * 60_000 + 57 * 60_000,
    });
    const go = segment("go", "behind", -0.2, {
      provider: "opencode-go",
      label: "OpenCode Go",
      windowId: "wk",
      windowLabel: "Wk",
      usedFraction: 0.5,
    });
    const fit = new BurndownRowComponent(identityTheme, { now, density: "text" });
    fit.setSegments([codex, go]);
    const node = fit.describe();
    expect(node.c?.map((child) => child.k)).toEqual(["row", "spacer"]);
    const segmentsRow = node.c?.[0];
    expect(segmentsRow?.p).toMatchObject({ wrap: true });
    const children = segmentsRow?.c ?? [];
    expect(children.map((child) => child.k)).toEqual(["text", "text"]);
    for (const child of children) expect(child.p).toMatchObject({ wrap: "none" });
    const keys = children.map((child) => child.key);
    expect(new Set(keys).size).toBe(2);
    const codexChild = children.find((child) =>
      String(child.p?.title).startsWith("OpenAI Codex 5h"),
    );
    expect(codexChild?.p?.title).toBe("OpenAI Codex 5h ▲1 points ahead · 100% left · 4h57m");
    expect(codexChild?.p?.spans).toContainEqual({ t: "▲1 points", s: "success" });
    expect(fit.describe()).toBe(node);

    const wrap = new BurndownRowComponent(identityTheme, { now, density: "text", layout: "wrap" });
    wrap.setSegments([codex, go]);
    const wrapped = wrap.describe().c?.[0]?.c ?? [];
    expect(wrapped.map((child) => child.key).sort()).toEqual([...keys].sort());
    expect(wrapped.every((child) => child.p?.title === undefined)).toBe(true);

    const empty = new BurndownRowComponent(identityTheme, { now });
    expect(empty.describe().p).toMatchObject({ hidden: true });
  });
});
