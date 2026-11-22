import type { UsageProvider } from "@oh-my-pi/pi-ai";
import * as piAi from "@oh-my-pi/pi-ai";

/**
 * pi-ai usage adapters used by default, by export name. OMP hosts drop
 * adapters between releases (OMP 19.1 no longer exports `googleGeminiCliUsageProvider`);
 * named imports of a missing export fail module linking and take the whole
 * extension down, so adapters are looked up on the namespace and skipped
 * when the running host no longer exports them.
 */
const DEFAULT_USAGE_PROVIDER_EXPORTS = [
  "claudeUsageProvider",
  "googleGeminiCliUsageProvider",
  "githubCopilotUsageProvider",
  "antigravityUsageProvider",
  "kimiUsageProvider",
  "openaiCodexUsageProvider",
  "zaiUsageProvider",
] as const;

function isUsageProvider(value: unknown): value is UsageProvider {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as UsageProvider).id === "string" &&
    typeof (value as UsageProvider).fetchUsage === "function"
  );
}

const hostExports: Readonly<Record<string, unknown>> = piAi;

export const DEFAULT_USAGE_PROVIDERS: readonly UsageProvider[] =
  DEFAULT_USAGE_PROVIDER_EXPORTS.flatMap((name) => {
    const provider = hostExports[name];
    return isUsageProvider(provider) ? [provider] : [];
  });
