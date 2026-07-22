export type SymbolMode = "auto" | "unicode" | "ascii";
export type DensityMode = "dense" | "text";
export type LayoutMode = "fit" | "wrap";
export type AccountLabelsMode = "full" | "masked" | "provider-only";
export type ExhaustedDisplayMode = "status" | "reset";
export type ExhaustedLabelMode = "full" | "symbol";
export interface DisplaySettings {
  density?: unknown;
  layout?: unknown;
  accountLabels?: unknown;
  exhaustedDisplay?: unknown;
  providerLabelMaxColumns?: unknown;
  exhaustedLabel?: unknown;
}

export interface BurndownConfig {
  broker?: { url: string; token: string };
  brokerError?: string;
  refreshMs: number;
  staleAfterMs: number;
  timeoutMs: number;
  paceTolerance: number;
  symbols: SymbolMode;
  density: DensityMode;
  layout: LayoutMode;
  showReset: boolean;
  clockSkewMs: number;
  /** When set, only these provider IDs (lowercase) appear in the indicator. */
  providerFilter?: ReadonlySet<string>;
  accountLabels: AccountLabelsMode;
  exhaustedDisplay: ExhaustedDisplayMode;
  providerLabelMaxColumns: number;
  exhaustedLabel: ExhaustedLabelMode;
}

function densityValue(
  env: Record<string, string | undefined>,
  settings: DisplaySettings,
): DensityMode {
  const configured = env.OMP_SUB_BURNDOWN_DENSITY ?? settings.density;
  if (configured === undefined) return "dense";
  if (configured !== "dense" && configured !== "text") {
    throw new Error("density must be dense or text");
  }
  return configured;
}

function layoutValue(
  env: Record<string, string | undefined>,
  settings: DisplaySettings,
): LayoutMode {
  const configured = env.OMP_SUB_BURNDOWN_LAYOUT ?? settings.layout;
  if (configured === undefined) return "fit";
  if (configured !== "fit" && configured !== "wrap") {
    throw new Error("layout must be fit or wrap");
  }
  return configured;
}

function accountLabelsValue(
  env: Record<string, string | undefined>,
  settings: DisplaySettings,
): AccountLabelsMode {
  const configured = env.OMP_SUB_BURNDOWN_ACCOUNT_LABELS ?? settings.accountLabels;
  if (configured === undefined) return "full";
  if (configured !== "full" && configured !== "masked" && configured !== "provider-only") {
    throw new Error("accountLabels must be full, masked, or provider-only");
  }
  return configured;
}

function exhaustedDisplayValue(
  env: Record<string, string | undefined>,
  settings: DisplaySettings,
): ExhaustedDisplayMode {
  const configured = env.OMP_SUB_BURNDOWN_EXHAUSTED_DISPLAY ?? settings.exhaustedDisplay;
  if (configured === undefined) return "status";
  if (configured !== "status" && configured !== "reset") {
    throw new Error("exhaustedDisplay must be status or reset");
  }
  return configured;
}

function exhaustedLabelValue(
  env: Record<string, string | undefined>,
  settings: DisplaySettings,
): ExhaustedLabelMode {
  const configured = env.OMP_SUB_BURNDOWN_EXHAUSTED_LABEL ?? settings.exhaustedLabel;
  if (configured === undefined) return "full";
  if (configured !== "full" && configured !== "symbol") {
    throw new Error("exhaustedLabel must be full or symbol");
  }
  return configured;
}

function providerLabelMaxColumnsValue(
  env: Record<string, string | undefined>,
  settings: DisplaySettings,
): number {
  const configured =
    env.OMP_SUB_BURNDOWN_PROVIDER_LABEL_MAX_COLUMNS ?? settings.providerLabelMaxColumns;
  if (configured === undefined) return 0;
  const parsed = typeof configured === "number" ? configured : Number(configured);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 256) {
    const source =
      env.OMP_SUB_BURNDOWN_PROVIDER_LABEL_MAX_COLUMNS !== undefined
        ? "OMP_SUB_BURNDOWN_PROVIDER_LABEL_MAX_COLUMNS"
        : "providerLabelMaxColumns";
    throw new Error(`${source} must be an integer from 0 through 256`);
  }
  return parsed;
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

export function readConfig(
  env: Record<string, string | undefined> = process.env,
  displaySettings: DisplaySettings = {},
): BurndownConfig {
  const brokerUrl = env.OMP_AUTH_BROKER_URL?.trim() ?? env.OMP_SUB_BURNDOWN_BROKER_URL?.trim();
  const brokerToken =
    env.OMP_AUTH_BROKER_TOKEN?.trim() ?? env.OMP_SUB_BURNDOWN_BROKER_TOKEN?.trim();
  const symbols = env.OMP_SUB_BURNDOWN_SYMBOLS ?? "auto";
  if (symbols !== "auto" && symbols !== "unicode" && symbols !== "ascii") {
    throw new Error("OMP_SUB_BURNDOWN_SYMBOLS must be auto, unicode, or ascii");
  }

  const density = densityValue(env, displaySettings);
  const layout = layoutValue(env, displaySettings);
  const accountLabels = accountLabelsValue(env, displaySettings);
  const exhaustedDisplay = exhaustedDisplayValue(env, displaySettings);
  const exhaustedLabel = exhaustedLabelValue(env, displaySettings);
  const providerLabelMaxColumns = providerLabelMaxColumnsValue(env, displaySettings);
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

  const providerFilterRaw = env.OMP_SUB_BURNDOWN_PROVIDERS?.trim();
  const providerFilter = providerFilterRaw
    ? new Set(
        providerFilterRaw
          .split(",")
          .map((p) => p.trim().toLowerCase())
          .filter(Boolean),
      )
    : undefined;

  const config: BurndownConfig = {
    refreshMs: refreshSeconds * 1_000,
    staleAfterMs: staleAfterSeconds * 1_000,
    timeoutMs: timeoutSeconds * 1_000,
    paceTolerance: tolerancePercent / 100,
    symbols,
    density,
    layout,
    accountLabels,
    exhaustedDisplay,
    exhaustedLabel,
    providerLabelMaxColumns,
    showReset: booleanValue(env, "OMP_SUB_BURNDOWN_SHOW_RESET", true),
    clockSkewMs: clockSkewSeconds * 1_000,
    ...(providerFilter ? { providerFilter } : {}),
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
