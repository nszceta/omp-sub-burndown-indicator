import type { Model } from "@oh-my-pi/pi-ai";

/**
 * The small part of OMP's model context this source needs.  Keeping this
 * structural makes the helper usable with both Model objects and test fakes.
 */
export type ModelProviderLike = Pick<Model, "provider">;

/**
 * Return the unique providers represented by the public model list.
 *
 * A model list is discovery metadata only: providers are not usage reports and
 * this function deliberately does not infer an account, credential, or quota.
 */
export function discoverProviders(models: readonly ModelProviderLike[]): string[] {
  const providers = new Set<string>();
  for (const model of models) {
    const provider = typeof model?.provider === "string" ? model.provider.trim() : "";
    if (provider) providers.add(provider);
  }
  return [...providers].sort((a, b) => a.localeCompare(b));
}

/** Compatibility alias for callers that name the operation explicitly. */
export const discoverModelProviders = discoverProviders;
