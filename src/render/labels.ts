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
  "opencode-go": "OpenCode Go",
  zai: "Z.ai",
};

/** Turn a provider identifier into a stable, human-readable brand name. */
export function providerDisplayName(provider: string, tier?: string): string {
  const normalized = provider.trim().toLocaleLowerCase();
  const known = PROVIDER_DISPLAY_NAMES[normalized];
  const display = known ?? (titleCaseWords(normalized) || "Unknown");
  const normalizedTier = clean(tier).toLocaleLowerCase();
  return normalizedTier ? `${display} ${titleCaseWords(normalizedTier)}` : display;
}

function titleCaseWords(value: string): string {
  return value
    .split(/[-_\s]+/u)
    .filter(Boolean)
    .map((word) => `${word[0]?.toLocaleUpperCase() ?? ""}${word.slice(1)}`)
    .join(" ");
}

/** A segment-shaped value accepted by the renderer's label allocator. */
export type LabelSegment = Pick<BurndownSegment, "subscriptionId" | "provider" | "label"> & {
  accountId?: string;
  accountLabel?: string;
  tier?: string;
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

/** Preserve a tiny account hint without disclosing the original label or domain. */
export function maskAccountLabel(value: string): { head: string; tail: string } {
  const localPart = clean(value).split("@", 1)[0] || "?";
  return { head: [...localPart].slice(0, 3).join(""), tail: "***" };
}

/**
 * Allocate stable labels. Collisions are disambiguated in stable-id order, so
 * reordering a source response cannot change a subscription's label.
 */
export function buildStableLabels(segments: readonly LabelSegment[]): StableLabels {
  const ordered = [...segments].sort((a, b) => a.subscriptionId.localeCompare(b.subscriptionId));
  const providerAccounts = new Map<string, Set<string>>();
  for (const segment of ordered) {
    const provider = clean(segment.provider).toLocaleLowerCase();
    let accounts = providerAccounts.get(provider);
    if (!accounts) {
      accounts = new Set<string>();
      providerAccounts.set(provider, accounts);
    }
    accounts.add(clean(segment.accountId) || segment.subscriptionId);
  }
  const fullGroups = new Map<string, Map<string, number>>();
  const full = new Map<string, string>();
  const providerFull = new Map<string, string>();
  const accountRequired = new Set<string>();

  for (const segment of ordered) {
    const name = displayName(segment);
    const providerKey = clean(segment.provider).toLocaleLowerCase();
    const accountKey = clean(segment.accountId) || segment.subscriptionId;
    const provider = providerDisplayName(segment.provider, segment.tier);
    if ((providerAccounts.get(providerKey)?.size ?? 0) > 1) {
      accountRequired.add(segment.subscriptionId);
    }
    const collisionScope = `${providerKey}\0${name}`;
    let groups = fullGroups.get(collisionScope);
    if (!groups) {
      groups = new Map<string, number>();
      fullGroups.set(collisionScope, groups);
    }
    let fullNumber = groups.get(accountKey);
    if (fullNumber === undefined) {
      fullNumber = groups.size + 1;
      groups.set(accountKey, fullNumber);
    }

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
