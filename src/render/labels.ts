import type { BurndownSegment } from "../domain/types";

/** A segment-shaped value accepted by the renderer's label allocator. */
export type LabelSegment = Pick<BurndownSegment, "subscriptionId" | "provider" | "label"> & {
  accountLabel?: string;
};

export interface StableLabels {
  /** Display names, keyed by stable subscription id. */
  readonly full: ReadonlyMap<string, string>;
  /** Two-cell (where possible) compact names, keyed by stable subscription id. */
  readonly compact: ReadonlyMap<string, string>;
  /** One-grapheme names, keyed by stable subscription id. */
  readonly minimal: ReadonlyMap<string, string>;
}

function clean(value: string | undefined): string {
  return (value ?? "").replace(/\s+/gu, " ").trim();
}

function displayName(segment: LabelSegment): string {
  return clean(segment.label) || clean(segment.accountLabel) || clean(segment.provider) || "?";
}

function graphemes(value: string): string[] {
  return [...value];
}

/** Build a deterministic short name from a provider/account display label. */
export function compactLabel(value: string): string {
  const normalized = clean(value);
  if (!normalized) return "?";
  const words = normalized.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (words.length > 1) {
    const initials = words.map((word) => graphemes(word)[0] ?? "").join("");
    if (initials) return initials.slice(0, 2);
  }
  return graphemes(normalized.replace(/[^\p{L}\p{N}]/gu, ""))[0] === undefined
    ? "?"
    : graphemes(normalized.replace(/[^\p{L}\p{N}]/gu, ""))
        .slice(0, 2)
        .join("");
}

function minimalLabel(value: string): string {
  return graphemes(value)[0] ?? "?";
}

/**
 * Allocate stable labels. Collisions are disambiguated in stable-id order, so
 * reordering a source response cannot change a subscription's label.
 */
export function buildStableLabels(segments: readonly LabelSegment[]): StableLabels {
  const ordered = [...segments].sort((a, b) => a.subscriptionId.localeCompare(b.subscriptionId));
  const fullCounts = new Map<string, number>();
  const compactCounts = new Map<string, number>();
  const minimalCounts = new Map<string, number>();
  const full = new Map<string, string>();
  const compact = new Map<string, string>();
  const minimal = new Map<string, string>();

  for (const segment of ordered) {
    const name = displayName(segment);
    const fullNumber = (fullCounts.get(name) ?? 0) + 1;
    fullCounts.set(name, fullNumber);
    const short = compactLabel(name);
    const shortNumber = (compactCounts.get(short) ?? 0) + 1;
    compactCounts.set(short, shortNumber);
    const tiny = minimalLabel(short);
    const tinyNumber = (minimalCounts.get(tiny) ?? 0) + 1;
    minimalCounts.set(tiny, tinyNumber);

    full.set(segment.subscriptionId, fullNumber === 1 ? name : `${name}${fullNumber}`);
    compact.set(segment.subscriptionId, shortNumber === 1 ? short : `${short}${shortNumber}`);
    minimal.set(segment.subscriptionId, tinyNumber === 1 ? tiny : `${tiny}${tinyNumber}`);
  }
  return { full, compact, minimal };
}

/** Alias retained as the natural imperative name for callers. */
export const assignStableLabels = buildStableLabels;

export function labelFor(
  labels: StableLabels,
  subscriptionId: string,
  form: "full" | "compact" | "minimal",
): string {
  return labels[form].get(subscriptionId) ?? "?";
}
