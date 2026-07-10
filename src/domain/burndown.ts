import { resolveUsedFraction, type UsageLimit } from "@oh-my-pi/pi-ai";
import type { BurndownSegment, LimitObservation, SubscriptionSnapshot } from "./types.ts";

export interface BurndownOptions {
  now?: number;
  /** Pace tolerance as a fraction (0.01 means one percentage point). */
  paceTolerance?: number;
  /** Permit a reset timestamp this far in the past for clock skew. */
  clockSkewMs?: number;
  /** Maximum age before a measurement expires to unknown. */
  staleAfterMs?: number;
}

export interface EligibleWindow {
  observation: LimitObservation;
  usedFraction: number;
}

const DEFAULT_TOLERANCE = 0.01;
const DEFAULT_CLOCK_SKEW_MS = 30_000;

function finiteNumber(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value);
}

function nowValue(options: BurndownOptions): number {
  return options.now ?? Date.now();
}

function currentWindow(limit: UsageLimit): boolean {
  const durationMs = limit.window?.durationMs;
  const resetsAt = limit.window?.resetsAt;
  return finiteNumber(durationMs) && durationMs > 0 && finiteNumber(resetsAt);
}

/** Return windows that can participate in deterministic shortest-window selection. */
export function eligibleBurndownWindows(
  snapshot: SubscriptionSnapshot,
  now = Date.now(),
  clockSkewMs = DEFAULT_CLOCK_SKEW_MS,
): EligibleWindow[] {
  const skew =
    Number.isFinite(clockSkewMs) && clockSkewMs >= 0 ? clockSkewMs : DEFAULT_CLOCK_SKEW_MS;
  const result: EligibleWindow[] = [];
  for (const observation of snapshot.limits) {
    const limit = observation.limit;
    const usedFraction = resolveUsedFraction(limit);
    if (!finiteNumber(usedFraction) || !currentWindow(limit)) continue;
    const resetsAt = limit.window?.resetsAt;
    if (resetsAt === undefined || resetsAt < now - skew) continue;
    result.push({ observation, usedFraction });
  }
  return result;
}

/** Select the shortest positive window, with deterministic reset and ID ties. */
export function selectShortestBurndownWindow(
  snapshot: SubscriptionSnapshot,
  now = Date.now(),
  clockSkewMs = DEFAULT_CLOCK_SKEW_MS,
): EligibleWindow | undefined {
  const eligible = eligibleBurndownWindows(snapshot, now, clockSkewMs);
  eligible.sort((left, right) => {
    const leftDuration = left.observation.limit.window?.durationMs ?? Number.POSITIVE_INFINITY;
    const rightDuration = right.observation.limit.window?.durationMs ?? Number.POSITIVE_INFINITY;
    if (leftDuration !== rightDuration) return leftDuration - rightDuration;
    const leftReset = left.observation.limit.window?.resetsAt ?? Number.POSITIVE_INFINITY;
    const rightReset = right.observation.limit.window?.resetsAt ?? Number.POSITIVE_INFINITY;
    if (leftReset !== rightReset) return leftReset - rightReset;
    return left.observation.limit.id.localeCompare(right.observation.limit.id);
  });
  return eligible[0];
}

export const selectBurndownWindow = selectShortestBurndownWindow;

function staleExpired(
  observation: LimitObservation,
  now: number,
  staleAfterMs: number | undefined,
): boolean {
  if (!finiteNumber(observation.fetchedAt) || !finiteNumber(staleAfterMs)) return false;
  return now - observation.fetchedAt > staleAfterMs;
}

/** Build one display segment without mutating its source snapshot. */
export function calculateBurndownSegment(
  snapshot: SubscriptionSnapshot,
  options: BurndownOptions = {},
): BurndownSegment {
  const now = nowValue(options);
  const tolerance =
    finiteNumber(options.paceTolerance) && options.paceTolerance >= 0
      ? options.paceTolerance
      : DEFAULT_TOLERANCE;
  const skew =
    finiteNumber(options.clockSkewMs) && options.clockSkewMs >= 0
      ? options.clockSkewMs
      : DEFAULT_CLOCK_SKEW_MS;
  const selected = selectShortestBurndownWindow(snapshot, now, skew);
  const base = {
    subscriptionId: snapshot.id,
    provider: snapshot.provider,
    label: snapshot.accountLabel ?? snapshot.provider,
  };

  if (!selected) {
    return { ...base, state: "unknown", stale: false };
  }

  const { observation, usedFraction } = selected;
  const window = observation.limit.window;
  const resetsAt = window?.resetsAt;
  const windowId = window?.id || observation.limit.scope.windowId || undefined;
  const stale = observation.stale || staleExpired(observation, now, options.staleAfterMs);
  const metadata = {
    ...(windowId ? { windowId } : {}),
    ...(finiteNumber(resetsAt) ? { resetsAt } : {}),
  };
  if (
    stale &&
    options.staleAfterMs !== undefined &&
    staleExpired(observation, now, options.staleAfterMs)
  ) {
    return { ...base, ...metadata, state: "unknown", stale: true };
  }

  const durationMs = window?.durationMs;
  if (!finiteNumber(durationMs) || !finiteNumber(resetsAt)) {
    return { ...base, ...metadata, state: "unknown", stale };
  }
  const start = resetsAt - durationMs;
  const toleranceBoundary = tolerance + Number.EPSILON * 8;
  const elapsedFraction = Math.min(1, Math.max(0, (now - start) / durationMs));
  const paceDelta = elapsedFraction - usedFraction;
  let state: BurndownSegment["state"];
  if (usedFraction >= 1) state = "exhausted";
  else if (Math.abs(paceDelta) <= toleranceBoundary) state = "on-pace";
  else if (paceDelta > toleranceBoundary) state = "ahead";
  else state = "behind";
  return {
    ...base,
    ...metadata,
    usedFraction,
    elapsedFraction,
    paceDelta,
    state,
    stale,
  };
}

export const computeBurndownSegment = calculateBurndownSegment;

/** Calculate segments in snapshot order; callers can apply their own risk sort. */
export function computeBurndownSegments(
  snapshots: readonly SubscriptionSnapshot[],
  options: BurndownOptions = {},
): BurndownSegment[] {
  return snapshots.map((snapshot) => calculateBurndownSegment(snapshot, options));
}

export const calculateBurndownSegments = computeBurndownSegments;
