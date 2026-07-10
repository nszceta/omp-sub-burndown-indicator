export type SymbolMode = "auto" | "unicode" | "ascii";

export interface BurndownConfig {
  broker?: { url: string; token: string };
  brokerError?: string;
  refreshMs: number;
  staleAfterMs: number;
  timeoutMs: number;
  paceTolerance: number;
  symbols: SymbolMode;
  showReset: boolean;
  clockSkewMs: number;
}

const DEFAULTS = {
  refreshSeconds: 300,
  staleAfterSeconds: 1_800,
  timeoutSeconds: 15,
  tolerancePercent: 1,
  clockSkewSeconds: 30,
} as const;

function boundedNumber(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be a number from ${minimum} through ${maximum}`);
  }
  return parsed;
}

function booleanValue(
  env: Record<string, string | undefined>,
  name: string,
  fallback: boolean,
): boolean {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`${name} must be true or false`);
}

export function readConfig(env: Record<string, string | undefined> = process.env): BurndownConfig {
  const brokerUrl = env.OMP_AUTH_BROKER_URL?.trim() ?? env.OMP_SUB_BURNDOWN_BROKER_URL?.trim();
  const brokerToken =
    env.OMP_AUTH_BROKER_TOKEN?.trim() ?? env.OMP_SUB_BURNDOWN_BROKER_TOKEN?.trim();
  const symbols = env.OMP_SUB_BURNDOWN_SYMBOLS ?? "auto";
  if (symbols !== "auto" && symbols !== "unicode" && symbols !== "ascii") {
    throw new Error("OMP_SUB_BURNDOWN_SYMBOLS must be auto, unicode, or ascii");
  }

  const refreshSeconds = boundedNumber(
    env,
    "OMP_SUB_BURNDOWN_REFRESH_SECONDS",
    DEFAULTS.refreshSeconds,
    30,
    86_400,
  );
  const staleAfterSeconds = boundedNumber(
    env,
    "OMP_SUB_BURNDOWN_STALE_AFTER_SECONDS",
    DEFAULTS.staleAfterSeconds,
    refreshSeconds,
    604_800,
  );
  const timeoutSeconds = boundedNumber(
    env,
    "OMP_SUB_BURNDOWN_TIMEOUT_SECONDS",
    DEFAULTS.timeoutSeconds,
    1,
    120,
  );
  const tolerancePercent = boundedNumber(
    env,
    "OMP_SUB_BURNDOWN_PACE_TOLERANCE_PERCENT",
    DEFAULTS.tolerancePercent,
    0,
    25,
  );
  const clockSkewSeconds = boundedNumber(
    env,
    "OMP_SUB_BURNDOWN_CLOCK_SKEW_SECONDS",
    DEFAULTS.clockSkewSeconds,
    0,
    300,
  );

  const config: BurndownConfig = {
    refreshMs: refreshSeconds * 1_000,
    staleAfterMs: staleAfterSeconds * 1_000,
    timeoutMs: timeoutSeconds * 1_000,
    paceTolerance: tolerancePercent / 100,
    symbols,
    showReset: booleanValue(env, "OMP_SUB_BURNDOWN_SHOW_RESET", true),
    clockSkewMs: clockSkewSeconds * 1_000,
  };

  if (brokerUrl && brokerToken) {
    let url: URL;
    try {
      url = new URL(brokerUrl);
    } catch {
      throw new Error("OMP_AUTH_BROKER_URL must be a valid http(s) URL");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("OMP_AUTH_BROKER_URL must use http or https");
    }
    url.username = "";
    url.password = "";
    config.broker = { url: url.toString().replace(/\/$/, ""), token: brokerToken };
  } else if (brokerUrl || brokerToken) {
    config.brokerError = "OMP_AUTH_BROKER_URL and OMP_AUTH_BROKER_TOKEN must both be configured";
  }

  return config;
}

const SECRET_PATTERN =
  /(?:bearer\s+|authorization[=:]\s*|token[=:]\s*|api[_-]?key[=:]\s*)([^\s,;]+)/gi;

export function redact(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value);
  return text
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, "$1[REDACTED]@")
    .replace(SECRET_PATTERN, (match) => match.replace(/[^\s,;]+$/, "[REDACTED]"));
}
