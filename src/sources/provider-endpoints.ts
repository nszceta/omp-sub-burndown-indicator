import {
  antigravityUsageProvider,
  claudeUsageProvider,
  githubCopilotUsageProvider,
  googleGeminiCliUsageProvider,
  kimiUsageProvider,
  openaiCodexUsageProvider,
  type UsageCredential,
  type UsageFetchParams,
  type UsageProvider,
  type UsageReport,
  zaiUsageProvider,
} from "@oh-my-pi/pi-ai";
import type { SubscriptionSnapshot } from "../domain/types.ts";
import type { UsageSource } from "./source.ts";
import { UsageSourceError } from "./source.ts";

export interface ProviderEndpointCredential {
  provider: string;
  credential: UsageCredential;
  /** Stable non-secret account scope supplied by the user, when needed. */
  accountKey?: string;
  baseUrl?: string;
  accountLabel?: string;
}

export interface ProviderEndpointUsageSourceOptions {
  /** Explicit environment object; defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Limit refreshes to these discovered providers. */
  providers?: readonly string[];
  /** Explicit credentials are preferred over environment discovery. */
  credentials?: readonly ProviderEndpointCredential[] | Readonly<Record<string, UsageCredential>>;
  /** Public adapters; defaults to verified pi-ai usage adapters. */
  adapters?: readonly UsageProvider[];
  /** Alias accepted by callers that call the adapter list a registry. */
  registry?: readonly UsageProvider[];
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  now?: () => number;
  staleAfterMs?: number;
}

/**
 * Explicit opt-in credentials for the public usage adapters.  We intentionally
 * do not read OMP's credential store or generic provider environment variables:
 * setting one of these names is the user's deliberate choice to enable a probe.
 */
export interface ProviderCredentialEnvironmentSpec {
  provider: string;
  type: UsageCredential["type"];
  variables: readonly string[];
  baseUrlVariables: readonly string[];
}

export const PROVIDER_CREDENTIAL_ENVIRONMENT: readonly ProviderCredentialEnvironmentSpec[] = [
  {
    provider: "anthropic",
    type: "oauth",
    variables: [
      "OMP_SUB_BURNDOWN_ANTHROPIC_ACCESS_TOKEN",
      "OMP_SUB_BURNDOWN_ANTHROPIC_TOKEN",
      "OMP_SUB_BURNDOWN_CLAUDE_ACCESS_TOKEN",
      "OMP_SUB_BURNDOWN_CLAUDE_TOKEN",
    ],
    baseUrlVariables: ["OMP_SUB_BURNDOWN_ANTHROPIC_BASE_URL"],
  },
  {
    provider: "google-gemini-cli",
    type: "oauth",
    variables: [
      "OMP_SUB_BURNDOWN_GOOGLE_GEMINI_CLI_ACCESS_TOKEN",
      "OMP_SUB_BURNDOWN_GOOGLE_GEMINI_CLI_TOKEN",
    ],
    baseUrlVariables: ["OMP_SUB_BURNDOWN_GOOGLE_GEMINI_CLI_BASE_URL"],
  },
  {
    provider: "github-copilot",
    type: "oauth",
    variables: [
      "OMP_SUB_BURNDOWN_GITHUB_COPILOT_ACCESS_TOKEN",
      "OMP_SUB_BURNDOWN_GITHUB_COPILOT_TOKEN",
    ],
    baseUrlVariables: ["OMP_SUB_BURNDOWN_GITHUB_COPILOT_BASE_URL"],
  },
  {
    provider: "google-antigravity",
    type: "oauth",
    variables: [
      "OMP_SUB_BURNDOWN_GOOGLE_ANTIGRAVITY_ACCESS_TOKEN",
      "OMP_SUB_BURNDOWN_GOOGLE_ANTIGRAVITY_TOKEN",
    ],
    baseUrlVariables: ["OMP_SUB_BURNDOWN_GOOGLE_ANTIGRAVITY_BASE_URL"],
  },
  {
    provider: "kimi-code",
    type: "oauth",
    variables: [
      "OMP_SUB_BURNDOWN_KIMI_ACCESS_TOKEN",
      "OMP_SUB_BURNDOWN_KIMI_TOKEN",
      "OMP_SUB_BURNDOWN_KIMI_CODE_ACCESS_TOKEN",
    ],
    baseUrlVariables: ["OMP_SUB_BURNDOWN_KIMI_BASE_URL"],
  },
  {
    provider: "openai-codex",
    type: "oauth",
    variables: [
      "OMP_SUB_BURNDOWN_OPENAI_CODEX_ACCESS_TOKEN",
      "OMP_SUB_BURNDOWN_OPENAI_CODEX_TOKEN",
    ],
    baseUrlVariables: ["OMP_SUB_BURNDOWN_OPENAI_CODEX_BASE_URL"],
  },
  {
    provider: "zai",
    type: "api_key",
    variables: ["OMP_SUB_BURNDOWN_ZAI_API_KEY", "OMP_SUB_BURNDOWN_ZAI_KEY"],
    baseUrlVariables: ["OMP_SUB_BURNDOWN_ZAI_BASE_URL"],
  },
];

const DEFAULT_ADAPTERS: readonly UsageProvider[] = [
  claudeUsageProvider,
  googleGeminiCliUsageProvider,
  githubCopilotUsageProvider,
  antigravityUsageProvider,
  kimiUsageProvider,
  openaiCodexUsageProvider,
  zaiUsageProvider,
];

function cloneSnapshot(
  snapshot: SubscriptionSnapshot,
  stale = snapshot.limits.some((limit) => limit.stale),
): SubscriptionSnapshot {
  return {
    ...snapshot,
    limits: snapshot.limits.map((limit) => ({ ...limit, stale })),
  };
}

function stringMetadata(report: UsageReport, key: string): string | undefined {
  const value = report.metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function identityForReport(
  provider: string,
  report: UsageReport,
  credential: ProviderEndpointCredential,
): { id: string; accountLabel?: string } | undefined {
  const firstScope = report.limits.find((limit) => limit.scope.provider === provider)?.scope;
  const accountId =
    stringMetadata(report, "accountId") ?? firstScope?.accountId ?? credential.credential.accountId;
  const projectId =
    stringMetadata(report, "projectId") ?? firstScope?.projectId ?? credential.credential.projectId;
  const orgId = stringMetadata(report, "orgId") ?? firstScope?.orgId;
  const accountKey = credential.accountKey;
  const scope = accountId
    ? `account:${encodeURIComponent(accountId)}`
    : projectId
      ? `project:${encodeURIComponent(orgId ? `${projectId}|org:${orgId}` : projectId)}`
      : orgId
        ? `org:${encodeURIComponent(orgId)}`
        : accountKey
          ? `account-key:${encodeURIComponent(accountKey)}`
          : undefined;
  if (!scope) return undefined;
  const accountLabel =
    credential.accountLabel ?? stringMetadata(report, "email") ?? credential.credential.email;
  return { id: `${provider}:${scope}`, ...(accountLabel ? { accountLabel } : {}) };
}

function classifyError(error: unknown, signal: AbortSignal): UsageSourceError["category"] {
  if (
    (error instanceof DOMException && error.name === "TimeoutError") ||
    (signal.reason instanceof DOMException && signal.reason.name === "TimeoutError")
  ) {
    return "timeout";
  }
  if (signal.aborted) return "aborted";
  if (error instanceof UsageSourceError) return error.category;
  if (error instanceof DOMException && error.name === "AbortError") return "aborted";
  return "network";
}

function createTimedSignal(
  parent: AbortSignal,
  timeoutMs: number,
): {
  signal: AbortSignal;
  cancel: () => void;
  timedOut: () => boolean;
} {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(parent.reason);
  if (parent.aborted) onAbort();
  else parent.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("Timed out", "TimeoutError"));
  }, timeoutMs);
  return {
    signal: controller.signal,
    cancel: () => {
      clearTimeout(timer);
      parent.removeEventListener("abort", onAbort);
    },
    timedOut: () => timedOut,
  };
}

/** Fetches only explicitly configured public usage adapters. */
export class ProviderEndpointUsageSource implements UsageSource {
  readonly id = "provider-endpoint";
  readonly #adapters: ReadonlyMap<string, UsageProvider>;
  readonly #env: Record<string, string | undefined>;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutMs: number;
  readonly #now: () => number;
  readonly #staleAfterMs: number;
  #providers: string[] | undefined;
  #credentials: ProviderEndpointCredential[];
  #lastGood: SubscriptionSnapshot[] = [];
  #lastErrorCategory: string | undefined;
  #lastSuccessAt?: number;
  #lastErrorAt?: number;

  constructor(options: ProviderEndpointUsageSourceOptions = {}) {
    this.#env = options.env ?? process.env;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = Math.max(1, options.timeoutMs ?? 15_000);
    this.#now = options.now ?? Date.now;
    this.#staleAfterMs = Math.max(this.#timeoutMs, options.staleAfterMs ?? 1_800_000);
    const adapters = options.adapters ?? options.registry ?? DEFAULT_ADAPTERS;
    this.#adapters = new Map(adapters.map((adapter) => [adapter.id, adapter]));
    this.#providers = options.providers
      ? [...new Set(options.providers.filter(Boolean))]
      : undefined;
    this.#credentials = options.credentials
      ? this.#normalizeCredentials(options.credentials)
      : this.#readEnvironmentCredentials();
  }

  setProviders(providers: readonly string[]): void {
    this.#providers = [...new Set(providers.filter((provider) => provider.trim()))];
  }

  setCredentials(credentials: readonly ProviderEndpointCredential[]): void {
    this.#credentials = credentials.map((credential) => ({ ...credential }));
  }

  current(): SubscriptionSnapshot[] {
    const now = this.#now();
    return this.#lastGood
      .map((snapshot) => ({
        ...snapshot,
        limits: snapshot.limits.filter((limit) => now - limit.fetchedAt <= this.#staleAfterMs),
      }))
      .filter((snapshot) => snapshot.limits.length > 0)
      .map((snapshot) => cloneSnapshot(snapshot));
  }

  async refresh(signal: AbortSignal): Promise<SubscriptionSnapshot[]> {
    if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    const credentials = this.#credentials.filter(
      (item) => !this.#providers || this.#providers.includes(item.provider),
    );
    if (credentials.length === 0) return this.current();

    const results = await Promise.all(
      credentials.map((item) => this.#fetchCredential(item, signal)),
    );
    if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");

    const successful = results.filter(
      (result): result is SubscriptionSnapshot => result !== undefined,
    );
    // A provider-only identity is valid only when exactly one explicit
    // credential exists for that provider. Ambiguous reports are discarded.
    const snapshots = successful.filter(
      (snapshot) => snapshot.id !== `${snapshot.provider}:__ambiguous__`,
    );
    const stalePrevious = this.#lastGood
      .filter((previous) => !snapshots.some((snapshot) => snapshot.id === previous.id))
      .map((previous) => cloneSnapshot(previous, true));
    this.#lastGood = [...snapshots, ...stalePrevious].sort((a, b) => a.id.localeCompare(b.id));
    if (successful.length > 0) {
      this.#lastSuccessAt = this.#now();
      this.#lastErrorCategory = undefined;
    }
    return this.current();
  }

  diagnostic() {
    return {
      sourceId: this.id,
      enabled: this.#credentials.length > 0,
      ...(this.#lastSuccessAt !== undefined ? { lastSuccessAt: this.#lastSuccessAt } : {}),
      ...(this.#lastErrorAt !== undefined ? { lastErrorAt: this.#lastErrorAt } : {}),
      ...(this.#lastErrorCategory ? { lastErrorCategory: this.#lastErrorCategory } : {}),
    };
  }

  async #fetchCredential(
    item: ProviderEndpointCredential,
    parentSignal: AbortSignal,
  ): Promise<SubscriptionSnapshot | undefined> {
    const adapter = this.#adapters.get(item.provider);
    if (!adapter) return undefined;
    const baseParams: UsageFetchParams = {
      provider: item.provider,
      credential: item.credential,
      ...(item.accountKey ? { accountKey: item.accountKey } : {}),
      ...(item.baseUrl ? { baseUrl: item.baseUrl } : {}),
    };
    if (adapter.supports && !adapter.supports(baseParams)) return undefined;
    if (
      !adapter.supports &&
      item.credential.type !== (this.#credentialType(item.provider) ?? item.credential.type)
    ) {
      return undefined;
    }
    const timed = createTimedSignal(parentSignal, this.#timeoutMs);
    const params: UsageFetchParams = { ...baseParams, signal: timed.signal };
    try {
      const report = await Promise.race([
        adapter.fetchUsage(params, {
          fetch: this.#fetch,
          logger: { debug() {}, warn() {} },
        }),
        new Promise<null>((_, reject) => {
          timed.signal.addEventListener(
            "abort",
            () =>
              reject(
                timed.timedOut()
                  ? new DOMException("Timed out", "TimeoutError")
                  : new DOMException("Aborted", "AbortError"),
              ),
            { once: true },
          );
        }),
      ]);
      if (!report || report.provider !== item.provider || report.limits.length === 0)
        return undefined;
      const measurementAt = Number.isFinite(report.fetchedAt) ? report.fetchedAt : this.#now();
      const identity = identityForReport(item.provider, report, item);
      if (!identity) {
        const sameProvider = this.#credentials.filter(
          (candidate) => candidate.provider === item.provider,
        );
        if (sameProvider.length !== 1) return undefined;
        return {
          id: `provider:${item.provider}`,
          provider: item.provider,
          ...(item.accountLabel ? { accountLabel: item.accountLabel } : {}),
          identitySource: "provider-endpoint",
          limits: report.limits.map((limit) => ({
            limit,
            measurementSource: "provider-endpoint",
            fetchedAt: measurementAt,
            stale: false,
          })),
        };
      }
      return {
        id: identity.id,
        provider: item.provider,
        ...(identity.accountLabel ? { accountLabel: identity.accountLabel } : {}),
        identitySource: "provider-endpoint",
        limits: report.limits.map((limit) => ({
          limit,
          measurementSource: "provider-endpoint",
          fetchedAt: measurementAt,
          stale: false,
        })),
      };
    } catch (error) {
      this.#lastErrorCategory = classifyError(error, timed.signal);
      this.#lastErrorAt = this.#now();
      return undefined;
    } finally {
      timed.cancel();
    }
  }

  #credentialType(provider: string): UsageCredential["type"] | undefined {
    return PROVIDER_CREDENTIAL_ENVIRONMENT.find((spec) => spec.provider === provider)?.type;
  }

  #normalizeCredentials(
    credentials: readonly ProviderEndpointCredential[] | Readonly<Record<string, UsageCredential>>,
  ): ProviderEndpointCredential[] {
    if (Array.isArray(credentials)) return credentials.map((item) => ({ ...item }));
    return Object.entries(credentials).map(([provider, credential]) => ({ provider, credential }));
  }

  #readEnvironmentCredentials(): ProviderEndpointCredential[] {
    const credentials: ProviderEndpointCredential[] = [];
    for (const spec of PROVIDER_CREDENTIAL_ENVIRONMENT) {
      const token = spec.variables.map((name) => this.#env[name]?.trim()).find(Boolean);
      if (!token) continue;
      const baseUrl = spec.baseUrlVariables.map((name) => this.#env[name]?.trim()).find(Boolean);
      credentials.push({
        provider: spec.provider,
        credential:
          spec.type === "oauth"
            ? { type: "oauth", accessToken: token }
            : { type: "api_key", apiKey: token },
        ...(baseUrl ? { baseUrl } : {}),
      });
    }
    return credentials;
  }
}

export const SUPPORTED_PROVIDER_ENDPOINTS = PROVIDER_CREDENTIAL_ENVIRONMENT.map(
  (spec) => spec.provider,
);

export const PUBLIC_USAGE_ADAPTERS: readonly UsageProvider[] = DEFAULT_ADAPTERS;
