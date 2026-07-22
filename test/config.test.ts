import { describe, expect, test } from "bun:test";
import { readConfig, redact } from "../src/config.ts";

describe("readConfig", () => {
  test("defaults make no broker request configuration", () => {
    const config = readConfig({});
    expect(config.broker).toBeUndefined();
    expect(config.refreshMs).toBe(300_000);
    expect(config.paceTolerance).toBe(0.01);
    expect(config.density).toBe("dense");
  });

  test("half configured broker reports a diagnostic without exposing token", () => {
    const config = readConfig({ OMP_AUTH_BROKER_TOKEN: "secret-value" });
    expect(config.broker).toBeUndefined();
    expect(config.brokerError).toContain("must both be configured");
    expect(config.brokerError).not.toContain("secret-value");
  });

  test("validates numeric, enum, boolean, URL, and plugin density values", () => {
    expect(() => readConfig({ OMP_SUB_BURNDOWN_REFRESH_SECONDS: "29" })).toThrow();
    expect(() => readConfig({ OMP_SUB_BURNDOWN_SYMBOLS: "emoji" })).toThrow();
    expect(() => readConfig({ OMP_SUB_BURNDOWN_SHOW_RESET: "yes" })).toThrow();
    expect(() =>
      readConfig({ OMP_AUTH_BROKER_URL: "file:///tmp/x", OMP_AUTH_BROKER_TOKEN: "x" }),
    ).toThrow();
    expect(readConfig({}, { density: "text" }).density).toBe("text");
    expect(() => readConfig({}, { density: "normal" })).toThrow("density");
    expect(readConfig({}, {}).layout).toBe("fit");
    expect(readConfig({}, { layout: "wrap" }).layout).toBe("wrap");
    expect(() => readConfig({}, { layout: "wide" })).toThrow("layout must be fit or wrap");
  });

  test("reads account-label and exhausted-display plugin settings", () => {
    const config = readConfig({}, { accountLabels: "masked", exhaustedDisplay: "status" });
    expect(config.accountLabels).toBe("masked");
    expect(config.exhaustedDisplay).toBe("status");
    expect(readConfig({}, {}).accountLabels).toBe("full");
    expect(readConfig({}, {}).exhaustedDisplay).toBe("status");
    expect(() => readConfig({}, { accountLabels: "hidden" })).toThrow(
      "accountLabels must be full, masked, or provider-only",
    );
    expect(() => readConfig({}, { exhaustedDisplay: "countdown" })).toThrow(
      "exhaustedDisplay must be status or reset",
    );
  });

  test("reads and validates exhausted-label settings", () => {
    expect(readConfig({}, {}).exhaustedLabel).toBe("full");
    expect(readConfig({}, { exhaustedLabel: "symbol" }).exhaustedLabel).toBe("symbol");
    expect(
      readConfig({ OMP_SUB_BURNDOWN_EXHAUSTED_LABEL: "symbol" }, { exhaustedLabel: "full" })
        .exhaustedLabel,
    ).toBe("symbol");
    expect(() => readConfig({}, { exhaustedLabel: "short" })).toThrow(
      "exhaustedLabel must be full or symbol",
    );
  });

  test("environment display controls override extension settings", () => {
    const config = readConfig(
      {
        OMP_SUB_BURNDOWN_DENSITY: "text",
        OMP_SUB_BURNDOWN_LAYOUT: "wrap",
        OMP_SUB_BURNDOWN_ACCOUNT_LABELS: "provider-only",
        OMP_SUB_BURNDOWN_EXHAUSTED_DISPLAY: "reset",
      },
      {
        density: "dense",
        layout: "fit",
        accountLabels: "full",
        exhaustedDisplay: "status",
      },
    );
    expect(config.density).toBe("text");
    expect(config.layout).toBe("wrap");
    expect(config.accountLabels).toBe("provider-only");
    expect(config.exhaustedDisplay).toBe("reset");
  });

  test("reads provider-label column limits from settings and environment", () => {
    expect(readConfig({}, {}).providerLabelMaxColumns).toBe(0);
    expect(readConfig({}, { providerLabelMaxColumns: 8 }).providerLabelMaxColumns).toBe(8);
    expect(
      readConfig(
        { OMP_SUB_BURNDOWN_PROVIDER_LABEL_MAX_COLUMNS: "12" },
        { providerLabelMaxColumns: 8 },
      ).providerLabelMaxColumns,
    ).toBe(12);
    expect(() => readConfig({}, { providerLabelMaxColumns: -1 })).toThrow(
      "providerLabelMaxColumns",
    );
    expect(() => readConfig({ OMP_SUB_BURNDOWN_PROVIDER_LABEL_MAX_COLUMNS: "nope" })).toThrow(
      "OMP_SUB_BURNDOWN_PROVIDER_LABEL_MAX_COLUMNS",
    );
  });
  test("OMP_SUB_BURNDOWN_PROVIDERS builds a lowercase provider filter set", () => {
    const config = readConfig({ OMP_SUB_BURNDOWN_PROVIDERS: "OpenAI-Codex, Anthropic, zai" });
    expect(config.providerFilter).toBeInstanceOf(Set);
    expect(config.providerFilter?.has("openai-codex")).toBe(true);
    expect(config.providerFilter?.has("anthropic")).toBe(true);
    expect(config.providerFilter?.has("zai")).toBe(true);
    expect(config.providerFilter?.has("gemini")).toBe(false);
  });

  test("OMP_SUB_BURNDOWN_PROVIDERS unset leaves no filter", () => {
    const config = readConfig({});
    expect(config.providerFilter).toBeUndefined();
  });
});

test("redact masks authorization values and URL credentials", () => {
  const value = redact("Bearer abc123 at https://user:password@example.test token=secret");
  expect(value).not.toContain("abc123");
  expect(value).not.toContain("password");
  expect(value).not.toContain("secret");
  expect(value).toContain("[REDACTED]");
});
