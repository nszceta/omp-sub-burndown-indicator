import type { BurndownSegment } from "../domain/types";

const PROVIDER_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  anthropic: "Anthropic",
  "github-copilot": "GitHub Copilot",
  "google-antigravity": "Google Antigravity",
  "google-gemini-cli": "Google Gemini",
  huggingface: "Hugging Face",
  "kimi-code": "Kimi Code",
  llamacpp: "llama.cpp",
  "openai-codex": "OpenAI Codex",
  zai: "Z.ai",
};

/** Turn a provider identifier into a stable, human-readable brand name. */
export function providerDisplayName(provider: string): string {
  const normalized = provider.trim().toLocaleLowerCase();
  const known = PROVIDER_DISPLAY_NAMES[normalized];
  if (known) return known;
  return (
    normalized
      .split(/[-_\s]+/u)
      .filter(Boolean)
      .map((word) => `${word[0]?.toLocaleUpperCase() ?? ""}${word.slice(1)}`)
      .join(" ") || "Unknown"
  );
}

/** A segment-shaped value accepted by the renderer's label allocator. */
export type LabelSegment = Pick<BurndownSegment, "subscriptionId" | "provider" | "label"> & {
  accountLabel?: string;
};

export interface StableLabels {
  /** Full collision-disambiguated account display names, keyed by stable subscription id. */
  readonly full: ReadonlyMap<string, string>;
  /** Full provider brand names, keyed by stable subscription id. */
  readonly providerFull: ReadonlyMap<string, string>;
  /** Subscriptions whose provider has multiple accounts and needs an account label. */
  readonly accountRequired: ReadonlySet<string>;
}
function clean(value: string | undefined): string {
  return (value ?? "").replace(/\s+/gu, " ").trim();
}

function displayName(segment: LabelSegment): string {
  return clean(segment.label) || clean(segment.accountLabel) || clean(segment.provider) || "?";
}

/**
 * Allocate stable labels. Collisions are disambiguated in stable-id order, so
 * reordering a source response cannot change a subscription's label.
 */
export function buildStableLabels(segments: readonly LabelSegment[]): StableLabels {
  const ordered = [...segments].sort((a, b) => a.subscriptionId.localeCompare(b.subscriptionId));
  const providerCounts = new Map<string, number>();
  for (const segment of ordered) {
    providerCounts.set(segment.provider, (providerCounts.get(segment.provider) ?? 0) + 1);
  }
  const fullCounts = new Map<string, number>();
  const full = new Map<string, string>();
  const providerFull = new Map<string, string>();
  const accountRequired = new Set<string>();

  for (const segment of ordered) {
    const name = displayName(segment);
    const provider = providerDisplayName(segment.provider);
    if ((providerCounts.get(segment.provider) ?? 0) > 1) {
      accountRequired.add(segment.subscriptionId);
    }
    const collisionScope = `${segment.provider}\0`;
    const fullKey = `${collisionScope}${name}`;
    const fullNumber = (fullCounts.get(fullKey) ?? 0) + 1;
    fullCounts.set(fullKey, fullNumber);

    full.set(segment.subscriptionId, fullNumber === 1 ? name : `${name}#${fullNumber}`);
    providerFull.set(segment.subscriptionId, provider);
  }
  return { full, providerFull, accountRequired };
}

/** Alias retained as the natural imperative name for callers. */
export const assignStableLabels = buildStableLabels;

export function labelFor(labels: StableLabels, subscriptionId: string): string {
  return labels.full.get(subscriptionId) ?? "?";
}

export function providerLabelFor(labels: StableLabels, subscriptionId: string): string {
  return labels.providerFull.get(subscriptionId) ?? "?";
}
