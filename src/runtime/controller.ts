import type { ProviderResponseMetadata } from "@oh-my-pi/pi-ai";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { isProviderEnabled } from "@oh-my-pi/pi-coding-agent/capability";
import { type BurndownConfig, readConfig, redact } from "../config.ts";
import { computeBurndownSegments } from "../domain/burndown.ts";
import type {
  BurndownSegment,
  CoordinatorDiagnostic,
  SubscriptionSnapshot,
} from "../domain/types.ts";
import { BurndownRowComponent } from "../render/row.ts";
import { mergeSnapshots, SourceCoordinator } from "../sources/coordinator.ts";
import { OmpAuthStorageUsageSource } from "../sources/omp-auth-storage.ts";
import { OmpBrokerUsageSource } from "../sources/omp-broker.ts";
import { discoverProviders } from "../sources/omp-models.ts";
import {
  type ProviderEndpointCredential,
  ProviderEndpointUsageSource,
} from "../sources/provider-endpoints.ts";
import { ResponseHeaderUsageSource } from "../sources/response-headers.ts";
import type { UsageSource } from "../sources/source.ts";
import { RefreshLoop } from "./refresh-loop.ts";

export const WIDGET_KEY = "omp-sub-burndown-indicator";

export interface IndicatorControllerOptions {
  /** Test and host injection point. These sources are used instead of defaults. */
  sources?: readonly UsageSource[];
  /** Explicit credentials passed to the public provider usage adapters. */
  credentials?:
    | readonly ProviderEndpointCredential[]
    | Readonly<Record<string, ProviderEndpointCredential["credential"]>>;
  /** Environment used when constructing configuration and endpoint sources. */
  env?: Record<string, string | undefined>;
  /** Validated configuration override. */
  config?: BurndownConfig;
  /** User/project plugin settings fetched for the active session context. */
  pluginSettings?: Readonly<Record<string, unknown>>;
  /** Clock injection for deterministic refresh/render tests. */
  now?: () => number;
}

type WidgetContext = Pick<ExtensionContext, "ui" | "hasUI">;

function modelProviders(ctx: ExtensionContext): string[] {
  const models =
    typeof ctx.models?.list === "function" ? ctx.models.list() : ctx.model ? [ctx.model] : [];
  return discoverProviders(models).filter(isProviderEnabled);
}

function isResponseSource(source: UsageSource): source is ResponseHeaderUsageSource {
  return (
    source.id === "omp-response" &&
    typeof (source as ResponseHeaderUsageSource).setAuthoritativeSnapshots === "function" &&
    typeof (source as ResponseHeaderUsageSource).ingest === "function"
  );
}

function errorText(error: unknown): string {
  return redact(error instanceof Error ? error.message : error);
}

/** Owns one session's refresh generation, source state, and widget handoff. */
export class IndicatorController {
  readonly #options: IndicatorControllerOptions;
  #config: BurndownConfig | undefined;
  #configError: string | undefined;
  #ctx: ExtensionContext | undefined;
  #coordinator: SourceCoordinator | undefined;
  #responseSource: ResponseHeaderUsageSource | undefined;
  #loop: RefreshLoop | undefined;
  #component: BurndownRowComponent | undefined;
  #tui: { requestRender?: () => void } | undefined;
  #sources: UsageSource[] = [];
  #renderTimer: Timer | undefined;
  #generation = 0;
  #disposed = false;
  #lastSegments: readonly BurndownSegment[] = [];

  constructor(options: IndicatorControllerOptions = {}) {
    this.#options = options;
  }

  get generation(): number {
    return this.#generation;
  }

  get active(): boolean {
    return !this.#disposed && this.#loop?.active === true;
  }

  /** Start the current session. Repeated calls join the existing poller. */
  async start(
    ctx: ExtensionContext,
    pluginSettings?: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    if (this.#disposed || !ctx.hasUI) return;
    if (this.#loop?.active && this.#ctx === ctx) {
      this.#setDiscoveredProviders(ctx);
      await this.#loop.trigger();
      return;
    }
    await this.#activate(ctx, pluginSettings);
  }

  /** Abort the prior session generation and start exactly one new poller. */
  async restart(
    ctx: ExtensionContext,
    pluginSettings?: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    if (this.#disposed || !ctx.hasUI) {
      this.#stopWork();
      return;
    }
    this.#stopWork();
    await this.#activate(ctx, pluginSettings);
  }

  /** Permanently shut down this controller and clear the widget. */
  shutdown(ctx?: WidgetContext): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#stopWork();
    const target = ctx ?? this.#ctx;
    if (target?.hasUI) {
      try {
        target.ui.setWidget(WIDGET_KEY, undefined, { placement: "aboveEditor" });
      } catch {
        // ACP/RPC implementations are permitted to ignore component widgets.
      }
    }
    this.#ctx = undefined;
    this.#component = undefined;
    this.#tui = undefined;
  }

  /** Correlate response headers with the current model and redraw immediately. */
  ingestResponse(event: ProviderResponseMetadata, ctx?: ExtensionContext): boolean {
    if (this.#disposed || !this.#responseSource || !ctx?.hasUI) return false;
    const model = typeof ctx.models?.current === "function" ? ctx.models.current() : ctx.model;
    const provider = model?.provider;
    if (!provider || !isProviderEnabled(provider)) return false;
    const changed = this.#responseSource.ingest(provider, event.headers);
    if (changed && this.#isCurrentContext(ctx)) this.#render(this.#currentSnapshots());
    return changed;
  }

  /** Structured, secret-free diagnostics for tests and command handlers. */
  diagnostic(): CoordinatorDiagnostic & {
    configError?: string;
    active: boolean;
    generation: number;
  } {
    const diagnostic = this.#coordinator?.diagnostic() ?? {
      sources: [],
      discoveredProviders: [],
      reportedProviders: [],
      unavailableProviders: {},
      ambiguities: [],
    };
    const reportedProviders = [
      ...new Set(this.#currentSnapshots().map((snapshot) => snapshot.provider)),
    ].sort();
    const reported = new Set(reportedProviders);
    const unavailableProviders = Object.fromEntries(
      diagnostic.discoveredProviders
        .filter((provider) => !reported.has(provider))
        .map((provider) => [
          provider,
          "no host auth report, broker report, supported response headers, or explicit endpoint credential",
        ]),
    );
    return {
      ...diagnostic,
      reportedProviders,
      unavailableProviders,
      ...(this.#configError ? { configError: this.#configError } : {}),
      active: this.active,
      generation: this.#generation,
    };
  }

  /** Human-readable output used by /burndown-status. It never contains credentials. */
  status(): string {
    const diagnostic = this.diagnostic();
    const sourceLines = diagnostic.sources.map((source) => {
      const flags = [source.enabled ? "enabled" : "disabled"];
      if (source.lastSuccessAt !== undefined) flags.push(`last-success=${source.lastSuccessAt}`);
      if (source.lastErrorCategory) flags.push(`error=${source.lastErrorCategory}`);
      if (source.detail) flags.push(`detail=${source.detail}`);
      return `${source.sourceId}: ${flags.join(", ")}`;
    });
    const discovered =
      diagnostic.discoveredProviders.length > 0
        ? diagnostic.discoveredProviders.join(", ")
        : "none";
    const reported =
      diagnostic.reportedProviders.length > 0 ? diagnostic.reportedProviders.join(", ") : "none";
    const unavailable = Object.entries(diagnostic.unavailableProviders).map(
      ([provider, reason]) => `${provider} (${reason})`,
    );
    return [
      "Burndown status",
      `active: ${diagnostic.active}`,
      `sources: ${sourceLines.length > 0 ? sourceLines.join("; ") : "none"}`,
      `discovered: ${discovered}`,
      `reported: ${reported}`,
      `unavailable: ${unavailable.length > 0 ? unavailable.join("; ") : "none"}`,
      ...(diagnostic.configError ? [`configuration: ${errorText(diagnostic.configError)}`] : []),
    ].join("\n");
  }

  async #activate(
    ctx: ExtensionContext,
    pluginSettings?: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    if (this.#disposed || !ctx.hasUI) return;
    this.#ctx = ctx;
    const generation = ++this.#generation;
    this.#configError = undefined;
    try {
      this.#config =
        this.#options.config ??
        readConfig(this.#options.env, pluginSettings ?? this.#options.pluginSettings);
    } catch (error) {
      this.#configError = errorText(error);
      this.#config = this.#options.config ?? readConfig({});
    }

    const providers = modelProviders(ctx);
    const sources = this.#buildSources(ctx, providers);
    this.#sources = sources;
    this.#coordinator = new SourceCoordinator(sources);
    this.#coordinator.setDiscoveredProviders(providers);
    this.#responseSource = sources.find(isResponseSource);
    this.#lastSegments = [];
    this.#installWidget(ctx);

    const loop = new RefreshLoop({
      intervalMs: this.#config.refreshMs,
      run: (signal) => this.#refresh(generation, ctx, signal),
      onError: (error) => {
        if (generation === this.#generation && !this.#disposed)
          this.#configError = errorText(error);
      },
    });
    this.#loop = loop;
    await loop.start();
    if (!this.#disposed && generation === this.#generation) this.#scheduleTimeRender();
  }

  #buildSources(ctx: ExtensionContext, providers: readonly string[]): UsageSource[] {
    if (this.#options.sources) return [...this.#options.sources];
    const config = this.#config;
    if (!config) return [];
    const authStorage = new OmpAuthStorageUsageSource({
      registry: ctx.modelRegistry,
      staleAfterMs: config.staleAfterMs,
      ...(this.#options.now ? { now: this.#options.now } : {}),
    });
    const response = new ResponseHeaderUsageSource();
    const broker = new OmpBrokerUsageSource(config);
    const endpoint = new ProviderEndpointUsageSource({
      ...(this.#options.env ? { env: this.#options.env } : {}),
      providers,
      ...(this.#options.credentials ? { credentials: this.#options.credentials } : {}),
      timeoutMs: config.timeoutMs,
      staleAfterMs: config.staleAfterMs,
    });
    return [authStorage, broker, response, endpoint];
  }

  #setDiscoveredProviders(ctx: ExtensionContext): void {
    const providers = modelProviders(ctx);
    this.#coordinator?.setDiscoveredProviders(providers);
    for (const source of this.#sources) {
      if (
        source.id === "provider-endpoint" &&
        "setProviders" in source &&
        typeof source.setProviders === "function"
      ) {
        source.setProviders(providers);
      }
    }
  }

  #installWidget(ctx: ExtensionContext): void {
    try {
      ctx.ui.setWidget(
        WIDGET_KEY,
        (tui: { requestRender?: () => void }, theme: unknown) => {
          this.#tui = tui;
          if (!this.#component) {
            this.#component = new BurndownRowComponent(theme as never, {
              symbols: this.#config?.symbols ?? "auto",
              density: this.#config?.density ?? "dense",
              showReset: this.#config?.showReset ?? true,
            });
            this.#component.setSegments(this.#lastSegments);
          }
          return this.#component;
        },
        { placement: "aboveEditor" },
      );
    } catch {
      // Component factories are unsupported in ACP/RPC; the indicator is optional.
    }
  }

  async #refresh(generation: number, ctx: ExtensionContext, signal: AbortSignal): Promise<void> {
    const coordinator = this.#coordinator;
    if (!coordinator || this.#disposed || generation !== this.#generation) return;
    const snapshots = await coordinator.refresh(signal);
    if (this.#disposed || generation !== this.#generation || this.#ctx !== ctx || signal.aborted)
      return;
    this.#responseSource?.setAuthoritativeSnapshots(
      snapshots.filter((snapshot) => isProviderEnabled(snapshot.provider)),
    );
    this.#render(this.#currentSnapshots());
  }

  #currentSnapshots(): SubscriptionSnapshot[] {
    const coordinatorSnapshots = this.#coordinator?.current() ?? [];
    const responseSnapshots = this.#responseSource?.current() ?? [];
    return mergeSnapshots([coordinatorSnapshots, responseSnapshots]).filter((snapshot) =>
      isProviderEnabled(snapshot.provider),
    );
  }

  #render(snapshots: readonly SubscriptionSnapshot[]): void {
    const config = this.#config;
    if (!config) return;
    const segments = computeBurndownSegments(snapshots, {
      now: this.#options.now?.() ?? Date.now(),
      paceTolerance: config.paceTolerance,
      staleAfterMs: config.staleAfterMs,
      clockSkewMs: config.clockSkewMs,
    });
    this.#lastSegments = segments;
    if (!this.#component?.setSegments(segments)) return;
    try {
      this.#tui?.requestRender?.();
    } catch {
      // Rendering is best-effort in headless/ACP/RPC hosts.
    }
  }

  #scheduleTimeRender(): void {
    clearTimeout(this.#renderTimer);
    const generation = this.#generation;
    this.#renderTimer = setTimeout(() => {
      this.#renderTimer = undefined;
      if (this.#disposed || generation !== this.#generation) return;
      this.#render(this.#currentSnapshots());
      this.#scheduleTimeRender();
    }, 30_000);
  }

  #isCurrentContext(ctx: ExtensionContext): boolean {
    return this.#ctx === ctx && !this.#disposed;
  }

  #stopWork(): void {
    this.#generation += 1;
    this.#loop?.stop();
    this.#loop = undefined;
    this.#coordinator = undefined;
    this.#responseSource = undefined;
    this.#lastSegments = [];
    clearTimeout(this.#renderTimer);
    this.#renderTimer = undefined;
    this.#sources = [];
    if (this.#component?.setSegments([])) {
      try {
        this.#tui?.requestRender?.();
      } catch {
        // Ignore redraw failures during lifecycle teardown.
      }
    }
    this.#component = undefined;
    this.#tui = undefined;
  }
}

export const IndicatorRuntime = IndicatorController;
