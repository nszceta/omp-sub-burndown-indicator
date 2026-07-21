import type { UsageReport } from "@oh-my-pi/pi-ai";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { normalizeUsageReports } from "../domain/normalize.ts";
import type { SourceDiagnostic, SubscriptionSnapshot } from "../domain/types.ts";
import { type UsageSource, UsageSourceError } from "./source.ts";

export type HostModelRegistry = Pick<
  ExtensionContext["modelRegistry"],
  "authStorage" | "getProviderBaseUrl"
>;

export interface OmpAuthStorageUsageSourceOptions {
  registry: HostModelRegistry;
  staleAfterMs?: number;
  now?: () => number;
}

/** Reads the same public normalized usage reports that back OMP's /usage command. */
export class OmpAuthStorageUsageSource implements UsageSource {
  readonly id = "omp-auth-storage" as const;
  readonly #registry: HostModelRegistry;
  readonly #staleAfterMs: number;
  readonly #now: () => number;
  #lastSuccessAt: number | undefined;
  #lastErrorAt: number | undefined;
  #lastErrorCategory: UsageSourceError["category"] | undefined;
  #detail: string | undefined;

  constructor(options: OmpAuthStorageUsageSourceOptions) {
    this.#registry = options.registry;
    this.#staleAfterMs = options.staleAfterMs ?? 1_800_000;
    this.#now = options.now ?? (() => Date.now());
  }

  async refresh(signal: AbortSignal): Promise<SubscriptionSnapshot[]> {
    try {
      if (signal.aborted) throw new UsageSourceError("aborted", "OMP auth usage refresh aborted");
      const reports =
        (await this.#registry.authStorage.fetchUsageReports({
          baseUrlResolver: (provider) => this.#registry.getProviderBaseUrl(provider),
          signal,
        })) ?? [];
      const snapshots = this.#normalize(reports);
      this.#lastSuccessAt = this.#now();
      this.#lastErrorAt = undefined;
      this.#lastErrorCategory = undefined;
      return snapshots;
    } catch (error) {
      const usageError =
        error instanceof UsageSourceError
          ? error
          : new UsageSourceError("network", "OMP auth usage refresh failed");
      this.#lastErrorAt = this.#now();
      this.#lastErrorCategory = usageError.category;
      throw usageError;
    }
  }

  diagnostic(): SourceDiagnostic {
    const diagnostic: SourceDiagnostic = { sourceId: this.id, enabled: true };
    if (this.#lastSuccessAt !== undefined) diagnostic.lastSuccessAt = this.#lastSuccessAt;
    if (this.#lastErrorAt !== undefined) diagnostic.lastErrorAt = this.#lastErrorAt;
    if (this.#lastErrorCategory !== undefined)
      diagnostic.lastErrorCategory = this.#lastErrorCategory;
    if (this.#detail !== undefined) diagnostic.detail = this.#detail;
    return diagnostic;
  }

  #normalize(reports: readonly UsageReport[]): SubscriptionSnapshot[] {
    const normalized = normalizeUsageReports(reports, {
      measurementSource: "omp-auth-storage",
      now: this.#now(),
      staleAfterMs: this.#staleAfterMs,
    });
    const snapshots = normalized.snapshots
      .map((snapshot) => ({
        ...snapshot,
        limits: snapshot.limits.filter(
          (observation) => this.#now() - observation.fetchedAt <= this.#staleAfterMs,
        ),
      }))
      .filter((snapshot) => snapshot.limits.length > 0);
    const ambiguous = normalized.diagnostics.filter(
      (entry) => entry.reason === "ambiguous-identity",
    );
    const placeholders = unattributedPlaceholders(
      ambiguous.map((entry) => entry.provider),
      snapshots,
      this.id,
    );
    this.#detail =
      ambiguous.length > 0
        ? `${ambiguous.length} usage report(s) cannot be attributed to a stable account${
            placeholders.length > 0
              ? `; ${placeholders.map((snapshot) => snapshot.provider).join(", ")} shown as unknown`
              : ""
          }`
        : undefined;
    return [...snapshots, ...placeholders];
  }
}

/**
 * Surface one provisional provider-level placeholder per provider whose reports
 * were all dropped as unattributable. The placeholder carries no measurements,
 * so it renders as `? unknown` and never assigns usage across accounts; a later
 * identified report or provisional header snapshot replaces it by stable ID.
 */
function unattributedPlaceholders(
  ambiguousProviders: readonly string[],
  snapshots: readonly SubscriptionSnapshot[],
  identitySource: SubscriptionSnapshot["identitySource"],
): SubscriptionSnapshot[] {
  const reported = new Set(snapshots.map((snapshot) => snapshot.provider));
  const hidden = [
    ...new Set(ambiguousProviders.filter((provider) => !reported.has(provider))),
  ].sort();
  return hidden.map((provider) => {
    const id = `provider:${provider}`;
    return { id, provider, accountId: id, identitySource, provisional: true, limits: [] };
  });
}
