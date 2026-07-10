import type { SourceDiagnostic, SubscriptionSnapshot } from "../domain/types.ts";

export interface UsageSource {
  readonly id: string;
  refresh(signal: AbortSignal): Promise<SubscriptionSnapshot[]>;
  diagnostic?(): SourceDiagnostic;
}

export class UsageSourceError extends Error {
  constructor(
    readonly category:
      | "auth"
      | "rate-limit"
      | "server"
      | "network"
      | "timeout"
      | "schema"
      | "aborted",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "UsageSourceError";
  }
}
