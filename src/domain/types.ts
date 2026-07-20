import type { UsageLimit } from "@oh-my-pi/pi-ai";

export type UsageSourceId =
  | "omp-auth-storage"
  | "omp-broker"
  | "omp-response"
  | "provider-endpoint";

export interface LimitObservation {
  limit: UsageLimit;
  measurementSource: UsageSourceId;
  fetchedAt: number;
  stale: boolean;
}

export interface SubscriptionSnapshot {
  id: string;
  provider: string;
  /** Stable base identity shared by all quota tiers for this account. */
  accountId?: string;
  tier?: string;
  accountLabel?: string;
  identitySource: UsageSourceId;
  limits: LimitObservation[];
}
export type SegmentState = "ahead" | "on-pace" | "behind" | "exhausted" | "unknown";

export interface BurndownSegment {
  subscriptionId: string;
  provider: string;
  /** Stable base identity used to group tiered segments as one account. */
  accountId?: string;
  tier?: string;
  label: string;
  windowId?: string;
  resetsAt?: number;
  usedFraction?: number;
  elapsedFraction?: number;
  paceDelta?: number;
  state: SegmentState;
  stale: boolean;
}

export interface SourceDiagnostic {
  sourceId: string;
  enabled: boolean;
  lastSuccessAt?: number;
  lastErrorAt?: number;
  lastErrorCategory?: string;
  detail?: string;
}

export interface CoordinatorDiagnostic {
  sources: SourceDiagnostic[];
  discoveredProviders: string[];
  reportedProviders: string[];
  unavailableProviders: Record<string, string>;
  ambiguities: string[];
}
