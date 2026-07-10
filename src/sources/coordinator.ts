import type {
  CoordinatorDiagnostic,
  LimitObservation,
  SubscriptionSnapshot,
  UsageSourceId,
} from "../domain/types.ts";
import type { UsageSource } from "./source.ts";

const IDENTITY_RANK: Record<UsageSourceId, number> = {
  "omp-broker": 3,
  "provider-endpoint": 2,
  "omp-response": 1,
};

function observationKey(observation: LimitObservation): string {
  const windowId = observation.limit.window?.id ?? observation.limit.scope.windowId ?? "";
  return `${observation.limit.id}\u0000${windowId}`;
}

export function mergeSnapshots(groups: readonly SubscriptionSnapshot[][]): SubscriptionSnapshot[] {
  const merged = new Map<string, SubscriptionSnapshot>();
  for (const snapshots of groups) {
    for (const incoming of snapshots) {
      const existing = merged.get(incoming.id);
      if (!existing) {
        merged.set(incoming.id, {
          ...incoming,
          limits: [...incoming.limits],
        });
        continue;
      }
      if (existing.provider !== incoming.provider) continue;

      const observations = new Map(existing.limits.map((item) => [observationKey(item), item]));
      for (const candidate of incoming.limits) {
        const key = observationKey(candidate);
        const current = observations.get(key);
        if (!current || candidate.fetchedAt > current.fetchedAt) observations.set(key, candidate);
      }
      const identityIsStronger =
        IDENTITY_RANK[incoming.identitySource] > IDENTITY_RANK[existing.identitySource];
      const accountLabel = identityIsStronger
        ? (incoming.accountLabel ?? existing.accountLabel)
        : (existing.accountLabel ?? incoming.accountLabel);
      merged.set(incoming.id, {
        id: existing.id,
        provider: existing.provider,
        ...(accountLabel ? { accountLabel } : {}),
        identitySource: identityIsStronger ? incoming.identitySource : existing.identitySource,
        limits: [...observations.values()].sort((a, b) =>
          observationKey(a).localeCompare(observationKey(b)),
        ),
      });
    }
  }
  return [...merged.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export class SourceCoordinator {
  readonly #sources: readonly UsageSource[];
  readonly #sourceSnapshots = new Map<string, SubscriptionSnapshot[]>();
  #discoveredProviders: string[] = [];
  #refreshPromise: Promise<SubscriptionSnapshot[]> | undefined;

  constructor(sources: readonly UsageSource[]) {
    this.#sources = sources;
  }

  setDiscoveredProviders(providers: readonly string[]): void {
    this.#discoveredProviders = [...new Set(providers)].sort();
  }

  refresh(signal: AbortSignal): Promise<SubscriptionSnapshot[]> {
    if (this.#refreshPromise) return this.#refreshPromise;
    const refresh = this.#runRefresh(signal).finally(() => {
      if (this.#refreshPromise === refresh) this.#refreshPromise = undefined;
    });
    this.#refreshPromise = refresh;
    return refresh;
  }

  current(): SubscriptionSnapshot[] {
    return mergeSnapshots([...this.#sourceSnapshots.values()]);
  }

  diagnostic(): CoordinatorDiagnostic {
    const current = this.current();
    const reportedProviders = [...new Set(current.map((item) => item.provider))].sort();
    const reported = new Set(reportedProviders);
    return {
      sources: this.#sources.map(
        (source) => source.diagnostic?.() ?? { sourceId: source.id, enabled: true },
      ),
      discoveredProviders: this.#discoveredProviders,
      reportedProviders,
      unavailableProviders: Object.fromEntries(
        this.#discoveredProviders
          .filter((provider) => !reported.has(provider))
          .map((provider) => [
            provider,
            "no broker report, supported response headers, or explicit endpoint credential",
          ]),
      ),
      ambiguities: [],
    };
  }

  async #runRefresh(signal: AbortSignal): Promise<SubscriptionSnapshot[]> {
    const results = await Promise.allSettled(
      this.#sources.map(async (source) => ({ source, snapshots: await source.refresh(signal) })),
    );
    for (const result of results) {
      if (result.status === "fulfilled") {
        this.#sourceSnapshots.set(result.value.source.id, result.value.snapshots);
      }
    }
    if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    return this.current();
  }
}
