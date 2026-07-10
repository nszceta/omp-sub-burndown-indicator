import {
  antigravityUsageProvider,
  claudeUsageProvider,
  githubCopilotUsageProvider,
  googleGeminiCliUsageProvider,
  kimiUsageProvider,
  openaiCodexUsageProvider,
  resolveUsedFraction,
  type UsageLimit,
  type UsageProvider,
  zaiUsageProvider,
} from "@oh-my-pi/pi-ai";
import type { LimitObservation, SubscriptionSnapshot } from "../domain/types.ts";
import type { UsageSource } from "./source.ts";

export interface ResponseHeaderUsageSourceOptions {
  providers?: readonly UsageProvider[];
  parsers?: ReadonlyMap<string, UsageProvider["parseRateLimitHeaders"]>;
}

const DEFAULT_PROVIDERS: readonly UsageProvider[] = [
  claudeUsageProvider,
  googleGeminiCliUsageProvider,
  githubCopilotUsageProvider,
  antigravityUsageProvider,
  kimiUsageProvider,
  openaiCodexUsageProvider,
  zaiUsageProvider,
];

function normalizeHeaders(
  headers: Headers | Record<string, string | readonly string[]>,
): Record<string, string> {
  const normalized: Record<string, string> = {};
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    headers.forEach((value, name) => {
      normalized[name.toLowerCase()] = value;
    });
    return normalized;
  }
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === "string") normalized[name.toLowerCase()] = value;
    else if (Array.isArray(value)) normalized[name.toLowerCase()] = value.join(", ");
  }
  return normalized;
}

function observationKey(observation: LimitObservation): string {
  const limit = observation.limit;
  return `${limit.id}\u0000${limit.window?.id ?? limit.scope.windowId ?? ""}`;
}

function completeLimit(limit: UsageLimit): boolean {
  const usedFraction = resolveUsedFraction(limit);
  const window = limit.window;
  return (
    typeof usedFraction === "number" &&
    Number.isFinite(usedFraction) &&
    !!window &&
    typeof window.durationMs === "number" &&
    Number.isFinite(window.durationMs) &&
    window.durationMs > 0 &&
    typeof window.resetsAt === "number" &&
    Number.isFinite(window.resetsAt)
  );
}

function cloneSnapshot(snapshot: SubscriptionSnapshot): SubscriptionSnapshot {
  return { ...snapshot, limits: [...snapshot.limits] };
}

/** Correlates public response-header reports with one existing subscription. */
export class ResponseHeaderUsageSource implements UsageSource {
  readonly id = "omp-response";
  readonly #parsers: ReadonlyMap<string, UsageProvider["parseRateLimitHeaders"]>;
  #authoritative: SubscriptionSnapshot[] = [];

  constructor(options: ResponseHeaderUsageSourceOptions = {}) {
    const parsers = new Map<string, UsageProvider["parseRateLimitHeaders"]>();
    for (const provider of options.providers ?? DEFAULT_PROVIDERS) {
      if (provider.parseRateLimitHeaders)
        parsers.set(provider.id, provider.parseRateLimitHeaders.bind(provider));
    }
    for (const [provider, parser] of options.parsers ?? []) {
      if (parser) parsers.set(provider, parser);
    }
    this.#parsers = parsers;
  }

  setAuthoritativeSnapshots(snapshots: readonly SubscriptionSnapshot[]): void {
    this.#authoritative = snapshots
      .filter(
        (snapshot) =>
          snapshot.identitySource === "omp-broker" ||
          snapshot.identitySource === "provider-endpoint",
      )
      .map(cloneSnapshot);
  }

  current(): SubscriptionSnapshot[] {
    return this.#authoritative.map(cloneSnapshot);
  }

  /** Returns true only when a complete report changed one unambiguous snapshot. */
  ingest(
    provider: string,
    headers: Headers | Record<string, string | readonly string[]>,
    now = Date.now(),
  ): boolean {
    const providerId = provider.trim();
    if (!providerId) return false;
    const parser = this.#parsers.get(providerId);
    if (!parser) return false;
    const candidates = this.#authoritative.filter((snapshot) => snapshot.provider === providerId);
    if (candidates.length !== 1) return false;

    const report = parser(normalizeHeaders(headers), now);
    if (!report || report.provider !== providerId) return false;
    const limits = report.limits.filter(completeLimit);
    if (limits.length === 0) return false;

    const target = candidates[0];
    if (!target) return false;
    const fetchedAt = Number.isFinite(report.fetchedAt) ? report.fetchedAt : now;
    const incoming = limits.map((limit) => ({
      limit,
      measurementSource: "omp-response" as const,
      fetchedAt,
      stale: false,
    }));
    const observations = new Map(
      target.limits.map((observation) => [observationKey(observation), observation]),
    );
    let changed = false;
    for (const candidate of incoming) {
      const key = observationKey(candidate);
      const existing = observations.get(key);
      if (!existing || candidate.fetchedAt > existing.fetchedAt) {
        observations.set(key, candidate);
        changed = true;
      }
    }
    if (!changed) return false;
    const updated = {
      ...target,
      limits: [...observations.values()].sort((a, b) =>
        observationKey(a).localeCompare(observationKey(b)),
      ),
    };
    this.#authoritative[this.#authoritative.indexOf(target)] = updated;
    return true;
  }

  async refresh(signal: AbortSignal): Promise<SubscriptionSnapshot[]> {
    if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    return this.current();
  }

  diagnostic() {
    return { sourceId: this.id, enabled: this.#parsers.size > 0 };
  }
}

export function ingestResponseHeaders(
  source: ResponseHeaderUsageSource,
  provider: string,
  headers: Headers | Record<string, string | readonly string[]>,
  now?: number,
): boolean {
  return source.ingest(provider, headers, now);
}

export { normalizeHeaders };
