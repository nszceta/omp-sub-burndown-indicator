import type { UsageLimit, UsageResponse } from "@oh-my-pi/pi-ai";
import { AuthBrokerClient, AuthBrokerError } from "@oh-my-pi/pi-ai/auth-broker";
import type { BurndownConfig } from "../config.ts";
import { normalizeUsageReports } from "../domain/normalize.ts";
import type { LimitObservation, SourceDiagnostic, SubscriptionSnapshot } from "../domain/types.ts";
import { UsageSourceError } from "./source.ts";

export interface OmpBrokerClient {
  fetchUsage(signal?: AbortSignal): Promise<UsageResponse>;
}

export interface OmpBrokerUsageSourceOptions {
  broker?: { url: string; token: string };
  url?: string;
  token?: string;
  timeoutMs?: number;
  staleAfterMs?: number;
  now?: () => number;
  client?: OmpBrokerClient;
}

type SourceConfig = Pick<BurndownConfig, "broker" | "timeoutMs" | "staleAfterMs">;

const TRANSIENT_CATEGORIES = new Set<UsageSourceError["category"]>([
  "rate-limit",
  "server",
  "network",
  "timeout",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function statusOf(error: unknown): number | undefined {
  if (error instanceof AuthBrokerError) return error.status;
  if (!isRecord(error)) return undefined;
  return typeof error.status === "number" ? error.status : undefined;
}

function hasCauseNamed(error: unknown, names: readonly string[]): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (isRecord(current) && typeof current.name === "string" && names.includes(current.name)) {
      return true;
    }
    current = isRecord(current) ? current.cause : undefined;
  }
  return false;
}

function classifyError(
  error: unknown,
  callerSignal: AbortSignal,
  timeoutSignal: AbortSignal,
): UsageSourceError["category"] {
  if (callerSignal.aborted) return "aborted";
  if (timeoutSignal.aborted || hasCauseNamed(error, ["TimeoutError"])) return "timeout";

  const status = statusOf(error);
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate-limit";
  if (status !== undefined && status >= 500) return "server";

  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (
    message.includes("schema") ||
    message.includes("validation") ||
    message.includes("malformed json")
  ) {
    return "schema";
  }
  if (hasCauseNamed(error, ["AbortError"])) return "network";
  return "network";
}

function cloneObservation(limit: UsageLimit, fetchedAt: number, stale: boolean): LimitObservation {
  return {
    limit: structuredClone(limit),
    measurementSource: "omp-broker",
    fetchedAt,
    stale,
  };
}

export class OmpBrokerUsageSource {
  readonly id = "omp-broker" as const;
  readonly #client: OmpBrokerClient | undefined;
  readonly #timeoutMs: number;
  readonly #staleAfterMs: number;
  readonly #now: () => number;
  #lastGood: SubscriptionSnapshot[] = [];
  #inFlight: Promise<SubscriptionSnapshot[]> | undefined;
  #lastSuccessAt: number | undefined;
  #lastErrorAt: number | undefined;
  #lastErrorCategory: UsageSourceError["category"] | undefined;
  #enabled: boolean;

  constructor(
    config: SourceConfig | OmpBrokerUsageSourceOptions,
    options: OmpBrokerUsageSourceOptions = {},
  ) {
    const candidate = config as SourceConfig & OmpBrokerUsageSourceOptions;
    const broker =
      candidate.broker ??
      (candidate.url && candidate.token
        ? { url: candidate.url, token: candidate.token }
        : undefined);
    this.#timeoutMs = options.timeoutMs ?? candidate.timeoutMs ?? 15_000;
    this.#staleAfterMs = options.staleAfterMs ?? candidate.staleAfterMs ?? 1_800_000;
    this.#now = options.now ?? candidate.now ?? (() => Date.now());
    this.#enabled = Boolean(broker || options.client || candidate.client);
    this.#client =
      options.client ??
      candidate.client ??
      (broker
        ? new AuthBrokerClient({
            url: broker.url,
            token: broker.token,
            timeoutMs: this.#timeoutMs + 100,
            maxRetries: 0,
          })
        : undefined);
  }

  refresh(signal: AbortSignal): Promise<SubscriptionSnapshot[]> {
    if (!this.#enabled || !this.#client) return Promise.resolve([]);
    if (this.#inFlight) return this.#inFlight;
    const request = this.#runRefresh(signal).finally(() => {
      if (this.#inFlight === request) this.#inFlight = undefined;
    });
    this.#inFlight = request;
    return request;
  }

  diagnostic(): SourceDiagnostic {
    const diagnostic: SourceDiagnostic = { sourceId: this.id, enabled: this.#enabled };
    if (this.#lastSuccessAt !== undefined) diagnostic.lastSuccessAt = this.#lastSuccessAt;
    if (this.#lastErrorAt !== undefined) diagnostic.lastErrorAt = this.#lastErrorAt;
    if (this.#lastErrorCategory !== undefined)
      diagnostic.lastErrorCategory = this.#lastErrorCategory;
    if (this.#lastErrorCategory !== undefined) {
      diagnostic.detail = `Broker usage refresh failed (${this.#lastErrorCategory})`;
    }
    return diagnostic;
  }

  async #runRefresh(callerSignal: AbortSignal): Promise<SubscriptionSnapshot[]> {
    const client = this.#client;
    if (!client) return [];
    const timeoutController = new AbortController();
    const timer = setTimeout(
      () => timeoutController.abort(new DOMException("Timeout", "TimeoutError")),
      this.#timeoutMs,
    );
    const signal = AbortSignal.any([callerSignal, timeoutController.signal]);

    try {
      if (callerSignal.aborted)
        throw new UsageSourceError("aborted", "Broker usage refresh aborted");
      const response = await client.fetchUsage(signal);
      const snapshots = this.#normalize(response);
      this.#lastGood = snapshots;
      this.#lastSuccessAt = this.#now();
      this.#lastErrorAt = undefined;
      this.#lastErrorCategory = undefined;
      return snapshots;
    } catch (error) {
      const usageError =
        error instanceof UsageSourceError
          ? error
          : new UsageSourceError(
              classifyError(error, callerSignal, timeoutController.signal),
              `Broker usage refresh failed (${classifyError(error, callerSignal, timeoutController.signal)})`,
            );
      this.#lastErrorAt = this.#now();
      this.#lastErrorCategory = usageError.category;
      if (TRANSIENT_CATEGORIES.has(usageError.category)) {
        const preserved = this.#preservedSnapshots();
        if (this.#lastGood.length > 0) return preserved;
      }
      throw usageError;
    } finally {
      clearTimeout(timer);
    }
  }
  #normalize(response: UsageResponse): SubscriptionSnapshot[] {
    if (!response || !Array.isArray(response.reports)) {
      throw new UsageSourceError("schema", "Broker usage refresh failed (schema)");
    }
    const normalized = normalizeUsageReports(response.reports, {
      measurementSource: "omp-broker",
      now: this.#now(),
      staleAfterMs: this.#staleAfterMs,
    });
    if (normalized.diagnostics.length > 0) {
      throw new UsageSourceError(
        "schema",
        `Broker usage refresh failed (schema: ${normalized.diagnostics[0]?.reason ?? "identity"})`,
      );
    }
    return normalized.snapshots
      .map((snapshot) => ({
        ...snapshot,
        limits: snapshot.limits.filter((item) => this.#isWithinAge(item.fetchedAt)),
      }))
      .filter((snapshot) => snapshot.limits.length > 0);
  }

  #preservedSnapshots(): SubscriptionSnapshot[] {
    return this.#lastGood
      .map((snapshot) => {
        const limits = snapshot.limits
          .filter((item) => this.#isWithinAge(item.fetchedAt))
          .map((item) => cloneObservation(item.limit, item.fetchedAt, true));
        return limits.length > 0 ? { ...snapshot, limits } : undefined;
      })
      .filter((snapshot): snapshot is SubscriptionSnapshot => snapshot !== undefined);
  }

  #isWithinAge(fetchedAt: number): boolean {
    return this.#now() - fetchedAt <= this.#staleAfterMs;
  }
}
