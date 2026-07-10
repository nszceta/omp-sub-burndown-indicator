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
  /** Account display names, keyed by stable subscription id. */
  readonly full: ReadonlyMap<string, string>;
  /** Compact account names, keyed by stable subscription id. */
  readonly compact: ReadonlyMap<string, string>;
  /** Minimal account names, keyed by stable subscription id. */
  readonly minimal: ReadonlyMap<string, string>;
  /** Provider brand names, keyed by stable subscription id. */
  readonly providerFull: ReadonlyMap<string, string>;
  /** Compact provider names for severely constrained rows. */
  readonly providerMinimal: ReadonlyMap<string, string>;
  /** Subscriptions whose provider has multiple accounts and needs an account label. */
  readonly accountRequired: ReadonlySet<string>;
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
  const at = normalized.indexOf("@");
  if (at > 0) {
    const localPart = normalized.slice(0, at).replace(/[^\p{L}\p{N}]/gu, "");
    const abbreviatedLocalPart = graphemes(localPart).slice(0, 2).join("");
    if (abbreviatedLocalPart) return abbreviatedLocalPart;
  }
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
  const providerCounts = new Map<string, number>();
  for (const segment of ordered) {
    providerCounts.set(segment.provider, (providerCounts.get(segment.provider) ?? 0) + 1);
  }
  const fullCounts = new Map<string, number>();
  const compactCounts = new Map<string, number>();
  const minimalCounts = new Map<string, number>();
  const full = new Map<string, string>();
  const compact = new Map<string, string>();
  const minimal = new Map<string, string>();
  const providerFull = new Map<string, string>();
  const providerMinimal = new Map<string, string>();
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
    const short = compactLabel(name);
    const shortKey = `${collisionScope}${short}`;
    const shortNumber = (compactCounts.get(shortKey) ?? 0) + 1;
    compactCounts.set(shortKey, shortNumber);
    const tiny = minimalLabel(short);
    const tinyKey = `${collisionScope}${tiny}`;
    const tinyNumber = (minimalCounts.get(tinyKey) ?? 0) + 1;
    minimalCounts.set(tinyKey, tinyNumber);

    full.set(segment.subscriptionId, fullNumber === 1 ? name : `${name}#${fullNumber}`);
    compact.set(segment.subscriptionId, shortNumber === 1 ? short : `${short}#${shortNumber}`);
    minimal.set(segment.subscriptionId, tinyNumber === 1 ? tiny : `${tiny}#${tinyNumber}`);
    providerFull.set(segment.subscriptionId, provider);
    providerMinimal.set(segment.subscriptionId, compactLabel(provider));
  }
  return { full, compact, minimal, providerFull, providerMinimal, accountRequired };
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

export function providerLabelFor(
  labels: StableLabels,
  subscriptionId: string,
  form: "full" | "minimal",
): string {
  return (
    (form === "full" ? labels.providerFull : labels.providerMinimal).get(subscriptionId) ?? "?"
  );
}
