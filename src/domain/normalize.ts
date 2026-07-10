import type { UsageLimit, UsageReport } from "@oh-my-pi/pi-ai";
import type { LimitObservation, SubscriptionSnapshot, UsageSourceId } from "./types.ts";
export interface NormalizeOptions {
  /** Source which measured each limit. */
  measurementSource?: UsageSourceId;
  /** Timestamp used to mark observations stale. Defaults to Date.now(). */
  now?: number;
  /** Maximum observation age before it is marked stale. Defaults to Infinity. */
  staleAfterMs?: number;
  /** Permit a provider-only identity when the caller has proved uniqueness. */
  providerIsUnambiguous?: boolean;
  /** Alias for providerIsUnambiguous for source callers. */
  allowProviderOnly?: boolean;
}

export interface NormalizationDiagnostic {
  provider: string;
  reason: "ambiguous-identity" | "missing-identity" | "invalid-provider";
  detail: string;
  reportIndex?: number;
}

export interface NormalizationResult {
  snapshots: SubscriptionSnapshot[];
  diagnostics: NormalizationDiagnostic[];
}

const DEFAULT_SOURCE: UsageSourceId = "omp-broker";

function stringValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const result = value.trim();
  return result.length > 0 ? result : undefined;
}

function providerValue(value: unknown): string | undefined {
  const provider = stringValue(value);
  return provider?.toLowerCase();
}

function metadataValue(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  return stringValue(metadata?.[key]);
}

interface Identity {
  key: "account" | "project" | "org" | "account-key" | "provider";
  value?: string;
  label?: string;
}

/**
 * Extract the strongest non-secret identity exposed by a normalized report.
 * Scope IDs are authoritative; accountKey is reserved for broker supplied
 * stable metadata and is never derived from credentials or labels.
 */
function reportIdentity(
  report: UsageReport,
  provider: string,
  allowProviderOnly: boolean,
): { identity: Identity } | { reason: "ambiguous-identity" | "missing-identity"; detail: string } {
  const metadata = report.metadata;
  const accountIds = new Set<string>();
  const projectIds = new Set<string>();
  const orgIds = new Set<string>();

  const metadataAccount = metadataValue(metadata, "accountId");
  const metadataProject = metadataValue(metadata, "projectId");
  const metadataOrg = metadataValue(metadata, "orgId");
  if (metadataAccount) accountIds.add(metadataAccount);
  if (metadataProject) projectIds.add(metadataProject);
  const accountLabel = metadataValue(metadata, "accountLabel") ?? metadataValue(metadata, "email");
  if (metadataOrg) orgIds.add(metadataOrg);

  for (const limit of report.limits) {
    const scope = limit.scope;
    const accountId = stringValue(scope.accountId);
    const projectId = stringValue(scope.projectId);
    const orgId = stringValue(scope.orgId);
    if (accountId) accountIds.add(accountId);
    if (projectId) projectIds.add(projectId);
    if (orgId) orgIds.add(orgId);
  }

  if (accountIds.size > 1) {
    return { reason: "ambiguous-identity", detail: `multiple account IDs for ${provider}` };
  }
  if (projectIds.size > 1) {
    return { reason: "ambiguous-identity", detail: `multiple project IDs for ${provider}` };
  }
  if (orgIds.size > 1) {
    return { reason: "ambiguous-identity", detail: `multiple organization IDs for ${provider}` };
  }

  const accountId = [...accountIds][0];
  if (accountId) {
    return {
      identity: {
        key: "account",
        value: accountId,
        ...(accountLabel ? { label: accountLabel } : {}),
      },
    };
  }

  const projectId = [...projectIds][0];
  const orgId = [...orgIds][0];
  if (projectId && orgId) {
    return {
      identity: {
        key: "project",
        value: `${projectId}|org:${orgId}`,
        ...(accountLabel ? { label: accountLabel } : {}),
      },
    };
  }
  if (projectId) {
    return {
      identity: {
        key: "project",
        value: projectId,
        ...(accountLabel ? { label: accountLabel } : {}),
      },
    };
  }
  if (orgId) {
    return {
      identity: { key: "org", value: orgId, ...(accountLabel ? { label: accountLabel } : {}) },
    };
  }

  const accountKey = metadataValue(metadata, "accountKey");
  if (accountKey) {
    return {
      identity: {
        key: "account-key",
        value: accountKey,
        ...(accountLabel ? { label: accountLabel } : {}),
      },
    };
  }
  if (allowProviderOnly) {
    return { identity: { key: "provider", ...(accountLabel ? { label: accountLabel } : {}) } };
  }
  return {
    reason: "missing-identity",
    detail: `no stable account, project, organization, or broker account key for ${provider}`,
  };
}

function identityId(provider: string, identity: Identity): string {
  if (identity.key === "provider") return `provider:${provider}`;
  return `${provider}:${identity.key}:${encodeURIComponent(identity.value ?? "")}`;
}

function staleValue(fetchedAt: number, options: NormalizeOptions): boolean {
  const staleAfterMs = options.staleAfterMs ?? Number.POSITIVE_INFINITY;
  if (!Number.isFinite(fetchedAt) || !Number.isFinite(staleAfterMs)) return false;
  const now = options.now ?? Date.now();
  return now - fetchedAt > staleAfterMs;
}

function snapshotFromReport(
  report: UsageReport,
  identity: Identity,
  options: NormalizeOptions,
): SubscriptionSnapshot {
  const source = options.measurementSource ?? DEFAULT_SOURCE;
  const fetchedAt = report.fetchedAt;
  const limits: LimitObservation[] = report.limits.map((limit: UsageLimit) => ({
    limit,
    measurementSource: source,
    fetchedAt,
    stale: staleValue(fetchedAt, options),
  }));
  return {
    id: identityId(providerValue(report.provider) ?? "unknown", identity),
    provider: providerValue(report.provider) ?? "unknown",
    ...(identity.label ? { accountLabel: identity.label } : {}),
    identitySource: source,
    limits,
  };
}

/** Normalize one report when the caller has established provider uniqueness. */
export function normalizeUsageReport(
  report: UsageReport,
  options: NormalizeOptions = {},
): SubscriptionSnapshot | undefined {
  const provider = providerValue(report.provider);
  if (!provider) return undefined;
  const identityResult = reportIdentity(
    report,
    provider,
    options.providerIsUnambiguous === true || options.allowProviderOnly === true,
  );
  if (!("identity" in identityResult)) return undefined;
  return snapshotFromReport(report, identityResult.identity, options);
}

/** Normalize reports and expose reports that cannot be assigned a safe identity. */
export function normalizeUsageReports(
  reports: readonly UsageReport[],
  options: NormalizeOptions = {},
): NormalizationResult {
  const diagnostics: NormalizationDiagnostic[] = [];
  const snapshotsById = new Map<string, SubscriptionSnapshot>();
  const pendingAnonymous: Array<{ report: UsageReport; index: number; provider: string }> = [];
  const providerCounts = new Map<string, number>();

  reports.forEach((report, index) => {
    const provider = providerValue(report.provider);
    if (!provider) {
      diagnostics.push({
        provider: "unknown",
        reason: "invalid-provider",
        detail: "report has no provider",
        reportIndex: index,
      });
      return;
    }
    providerCounts.set(provider, (providerCounts.get(provider) ?? 0) + 1);
    const identityResult = reportIdentity(report, provider, false);
    if (!("identity" in identityResult)) {
      if (identityResult.reason === "missing-identity")
        pendingAnonymous.push({ report, index, provider });
      else diagnostics.push({ provider, ...identityResult, reportIndex: index });
      return;
    }
    const snapshot = snapshotFromReport(report, identityResult.identity, options);
    const previous = snapshotsById.get(snapshot.id);
    if (!previous) {
      snapshotsById.set(snapshot.id, snapshot);
    } else {
      // A report can be split by a source into multiple entries. Preserve the
      // newest observation for each stable limit ID without reordering limits.
      const byLimit = new Map(
        previous.limits.map((observation) => [observation.limit.id, observation]),
      );
      for (const observation of snapshot.limits) {
        const old = byLimit.get(observation.limit.id);
        if (!old || observation.fetchedAt >= old.fetchedAt)
          byLimit.set(observation.limit.id, observation);
      }
      snapshotsById.set(snapshot.id, { ...previous, limits: [...byLimit.values()] });
    }
  });

  for (const anonymous of pendingAnonymous) {
    if ((providerCounts.get(anonymous.provider) ?? 0) === 1) {
      const snapshot = normalizeUsageReport(anonymous.report, {
        ...options,
        providerIsUnambiguous: true,
      });
      if (snapshot) snapshotsById.set(snapshot.id, snapshot);
    } else {
      diagnostics.push({
        provider: anonymous.provider,
        reason: "ambiguous-identity",
        detail: `anonymous ${anonymous.provider} report cannot be assigned among multiple reports`,
        reportIndex: anonymous.index,
      });
    }
  }

  return { snapshots: [...snapshotsById.values()], diagnostics };
}

export const normalizeReports = normalizeUsageReports;
