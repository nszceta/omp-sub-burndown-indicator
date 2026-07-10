import { visibleWidth } from "@oh-my-pi/pi-tui";
import type { BurndownSegment, SegmentState } from "../domain/types";
import { buildStableLabels, labelFor, providerLabelFor, type StableLabels } from "./labels";
import {
  type BurndownSymbols,
  describeSegmentSignal,
  type SymbolMode,
  segmentSignal,
  segmentSignalWithUnit,
  symbolsFor,
} from "./symbols";

export interface BurndownTheme {
  fg(color: string, text: string): string;
}

export interface BurndownRenderOptions {
  theme?: BurndownTheme;
  symbols?: SymbolMode | BurndownSymbols;
  showReset?: boolean;
  now?: number | (() => number);
  separator?: string;
}

const DEFAULT_SEPARATOR = " · ";
const EMPTY_ROWS: readonly string[] = [];

function nowValue(now: number | (() => number) | undefined): number {
  return typeof now === "function" ? now() : (now ?? Date.now());
}

function resetCountdown(resetsAt: number | undefined, now: number): string {
  if (resetsAt === undefined || !Number.isFinite(resetsAt)) return "";
  const remaining = Math.max(0, resetsAt - now);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (remaining >= day) return `${Math.ceil(remaining / day)}d`;
  if (remaining >= hour) {
    const totalMinutes = Math.ceil(remaining / minute);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
  }
  if (remaining >= minute) return `${Math.ceil(remaining / minute)}m`;
  return "<1m";
}

export const formatResetCountdown = resetCountdown;

function riskRank(state: SegmentState, stale: boolean): number {
  if (stale) return 4;
  if (state === "exhausted") return 0;
  if (state === "behind") return 1;
  if (state === "on-pace") return 2;
  if (state === "ahead") return 3;
  return 4;
}

export function sortBurndownSegments(segments: readonly BurndownSegment[]): BurndownSegment[] {
  return [...segments].sort((a, b) => {
    const rank = riskRank(a.state, a.stale) - riskRank(b.state, b.stale);
    if (rank !== 0) return rank;
    if ((a.state === "behind" || a.state === "ahead") && !a.stale && !b.stale) {
      const ap = Number.isFinite(a.paceDelta) ? (a.paceDelta ?? 0) : 0;
      const bp = Number.isFinite(b.paceDelta) ? (b.paceDelta ?? 0) : 0;
      if (ap !== bp) return ap - bp;
    }
    return a.subscriptionId.localeCompare(b.subscriptionId);
  });
}

function stableSegmentKey(segments: readonly BurndownSegment[]): string {
  return JSON.stringify(
    [...segments]
      .sort((a, b) => a.subscriptionId.localeCompare(b.subscriptionId))
      .map((segment) => [
        segment.subscriptionId,
        segment.provider,
        segment.label,
        segment.windowId,
        segment.resetsAt,
        segment.usedFraction,
        segment.elapsedFraction,
        segment.paceDelta,
        segment.state,
        segment.stale,
      ]),
  );
}

function colorFor(segment: BurndownSegment): string {
  if (segment.stale || segment.state === "unknown") return "dim";
  if (segment.state === "exhausted") return "error";
  if (segment.state === "behind")
    return Math.abs(segment.paceDelta ?? 0) >= 0.5 ? "error" : "warning";
  if (segment.state === "ahead") return "success";
  return "accent";
}

function style(theme: BurndownTheme | undefined, color: string, text: string): string {
  return theme ? theme.fg(color, text) : text;
}

interface RenderedForms {
  full: string;
  compact: string;
  minimal: string;
}

function formsFor(
  segment: BurndownSegment,
  labels: StableLabels,
  symbols: BurndownSymbols,
  showReset: boolean,
  now: number,
  theme: BurndownTheme | undefined,
): RenderedForms {
  const color = colorFor(segment);
  const fullSignal = style(theme, color, describeSegmentSignal(segment, symbols));
  const compactSignal = style(theme, color, segmentSignalWithUnit(segment, symbols));
  const minimalSignal = style(theme, color, segmentSignal(segment, symbols));
  const separator = " ";
  const provider = providerLabelFor(labels, segment.subscriptionId, "full");
  const providerMinimal = providerLabelFor(labels, segment.subscriptionId, "minimal");
  const account = labelFor(labels, segment.subscriptionId, "full");
  const accountCompact = labelFor(labels, segment.subscriptionId, "compact");
  const accountMinimal = labelFor(labels, segment.subscriptionId, "minimal");
  const hasDistinctAccount =
    labels.accountRequired.has(segment.subscriptionId) &&
    segment.label.trim().length > 0 &&
    segment.label.trim().toLocaleLowerCase() !== segment.provider.trim().toLocaleLowerCase();
  const qualifiedLabel = hasDistinctAccount ? `${provider}:${account}` : provider;
  const qualifiedCompact = hasDistinctAccount ? `${provider}:${accountCompact}` : provider;
  const qualifiedMinimal = hasDistinctAccount
    ? `${providerMinimal}:${accountMinimal}`
    : providerMinimal;
  const compact = `${style(theme, "muted", qualifiedCompact)}${separator}${compactSignal}`;
  const minimal = `${style(theme, "muted", qualifiedMinimal)}${minimalSignal}`;
  const reset = showReset ? resetCountdown(segment.resetsAt, now) : "";
  const fullLabel = style(theme, "muted", qualifiedLabel);
  const full = reset
    ? `${fullLabel}${separator}${fullSignal}${separator}${style(theme, "dim", reset)}`
    : `${fullLabel}${separator}${fullSignal}`;
  return { full, compact, minimal };
}

function chooseForms(
  forms: readonly RenderedForms[],
  count: number,
  width: number,
  separator: string,
  hidden: number,
): string[] | undefined {
  const marker = hidden > 0 ? `+${hidden}` : "";
  const markerWidth = marker ? visibleWidth(separator) + visibleWidth(marker) : 0;
  const separatorsWidth = Math.max(0, count - 1) * visibleWidth(separator);
  const budget = width - markerWidth - separatorsWidth;
  if (budget < 0) return undefined;
  const chosen: string[] = [];
  let used = 0;
  for (let index = 0; index < count; index++) {
    const form = forms[index];
    if (!form) return undefined;
    const remainingMinimum = forms
      .slice(index + 1, count)
      .reduce((sum, value) => sum + visibleWidth(value.minimal), 0);
    const available = budget - used - remainingMinimum;
    const candidate =
      visibleWidth(form.full) <= available
        ? form.full
        : visibleWidth(form.compact) <= available
          ? form.compact
          : visibleWidth(form.minimal) <= available
            ? form.minimal
            : undefined;
    if (!candidate) return undefined;
    chosen.push(candidate);
    used += visibleWidth(candidate);
  }
  if (hidden > 0) chosen.push(marker);
  return chosen;
}

/** Render exactly zero or one line, always within the supplied cell budget. */
export function renderBurndownRow(
  segments: readonly BurndownSegment[],
  width: number,
  optionsOrTheme: BurndownRenderOptions | BurndownTheme = {},
): readonly string[] {
  const options: BurndownRenderOptions =
    "fg" in optionsOrTheme ? { theme: optionsOrTheme } : optionsOrTheme;
  const budget = Math.floor(width);
  if (budget <= 0 || segments.length === 0) return EMPTY_ROWS;
  const symbols =
    typeof options.symbols === "object" ? options.symbols : symbolsFor(options.symbols ?? "auto");
  const separator = options.separator ?? DEFAULT_SEPARATOR;
  const sorted = sortBurndownSegments(segments);
  const labels = buildStableLabels(sorted);
  const renderNow = nowValue(options.now);
  const forms = sorted.map((segment) =>
    formsFor(segment, labels, symbols, options.showReset ?? true, renderNow, options.theme),
  );
  for (let count = sorted.length; count >= 1; count--) {
    const hidden = sorted.length - count;
    const chosen = chooseForms(forms, count, budget, separator, hidden);
    if (!chosen) continue;
    const line = chosen.join(separator);
    if (visibleWidth(line) <= budget) return [line];
  }
  return EMPTY_ROWS;
}

export class BurndownRowComponent {
  readonly theme: BurndownTheme | undefined;
  readonly options: Omit<BurndownRenderOptions, "theme">;
  #segments: readonly BurndownSegment[] = [];
  #semanticKey = "[]";
  #cachedWidth: number | undefined;
  #cachedNow: number | undefined;
  #cachedRows: readonly string[] = EMPTY_ROWS;

  constructor(theme?: BurndownTheme, options: Omit<BurndownRenderOptions, "theme"> = {}) {
    this.theme = theme;
    this.options = options;
  }

  setSegments(segments: readonly BurndownSegment[]): boolean {
    const key = stableSegmentKey(segments);
    if (key === this.#semanticKey) return false;
    this.#segments = segments.map((segment) => ({ ...segment }));
    this.#semanticKey = key;
    this.#cachedWidth = undefined;
    this.#cachedNow = undefined;
    return true;
  }

  render(width: number): readonly string[] {
    const currentNow = nowValue(this.options.now);
    if (this.#cachedWidth === width && this.#cachedNow === currentNow) return this.#cachedRows;
    const renderOptions: BurndownRenderOptions = { ...this.options, now: currentNow };
    if (this.theme) renderOptions.theme = this.theme;
    this.#cachedRows = renderBurndownRow(this.#segments, width, renderOptions);
    this.#cachedWidth = width;
    this.#cachedNow = currentNow;
    return this.#cachedRows;
  }
}
