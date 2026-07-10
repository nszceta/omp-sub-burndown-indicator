import { describe, expect, test } from "bun:test";
import { readConfig, redact } from "../src/config.ts";

describe("readConfig", () => {
  test("defaults make no broker request configuration", () => {
    const config = readConfig({});
    expect(config.broker).toBeUndefined();
    expect(config.refreshMs).toBe(300_000);
    expect(config.paceTolerance).toBe(0.01);
  });

  test("half configured broker reports a diagnostic without exposing token", () => {
    const config = readConfig({ OMP_AUTH_BROKER_TOKEN: "secret-value" });
    expect(config.broker).toBeUndefined();
    expect(config.brokerError).toContain("must both be configured");
    expect(config.brokerError).not.toContain("secret-value");
  });

  test("validates numeric, enum, boolean, and URL values", () => {
    expect(() => readConfig({ OMP_SUB_BURNDOWN_REFRESH_SECONDS: "29" })).toThrow();
    expect(() => readConfig({ OMP_SUB_BURNDOWN_SYMBOLS: "emoji" })).toThrow();
    expect(() => readConfig({ OMP_SUB_BURNDOWN_SHOW_RESET: "yes" })).toThrow();
    expect(() =>
      readConfig({ OMP_AUTH_BROKER_URL: "file:///tmp/x", OMP_AUTH_BROKER_TOKEN: "x" }),
    ).toThrow();
  });
});

test("redact masks authorization values and URL credentials", () => {
  const value = redact("Bearer abc123 at https://user:password@example.test token=secret");
  expect(value).not.toContain("abc123");
  expect(value).not.toContain("password");
  expect(value).not.toContain("secret");
  expect(value).toContain("[REDACTED]");
});
