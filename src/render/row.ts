import { visibleWidth } from "@oh-my-pi/pi-tui";
import type {
  AccountLabelsMode,
  DensityMode,
  ExhaustedDisplayMode,
  ExhaustedLabelMode,
  LayoutMode,
} from "../config";
import type { BurndownSegment, SegmentState } from "../domain/types";
import {
  buildStableLabels,
  labelFor,
  maskAccountLabel,
  providerLabelFor,
  type StableLabels,
} from "./labels";
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
  density?: DensityMode;
  layout?: LayoutMode;
  accountLabels?: AccountLabelsMode;
  exhaustedDisplay?: ExhaustedDisplayMode;
  exhaustedLabel?: ExhaustedLabelMode;
  providerLabelMaxColumns?: number;
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
  const totalMinutes = Math.ceil(remaining / minute);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d${hours > 0 ? `${hours}h` : ""}${minutes > 0 ? `${minutes}m` : ""}`;
  if (hours > 0) return `${hours}h${minutes > 0 ? `${minutes}m` : ""}`;
  if (minutes > 0) return `${minutes}m`;
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

function remainingQuota(usedFraction: number | undefined): string {
  if (usedFraction === undefined || !Number.isFinite(usedFraction)) return "";
  return `${Math.round(Math.max(0, 1 - usedFraction) * 100)}% left`;
}

function clipToColumns(text: string, maxColumns: number): string {
  if (maxColumns === 0 || visibleWidth(text) <= maxColumns) return text;
  if (maxColumns === 1) return "…";
  let result = "";
  for (const character of text) {
    if (visibleWidth(`${result}${character}…`) > maxColumns) break;
    result += character;
  }
  return `${result}…`;
}

function formsFor(
  segment: BurndownSegment,
  labels: StableLabels,
  symbols: BurndownSymbols,
  density: DensityMode,
  accountLabels: AccountLabelsMode,
  exhaustedDisplay: ExhaustedDisplayMode,
  exhaustedLabel: ExhaustedLabelMode,
  providerLabelMaxColumns: number,
  showReset: boolean,
  now: number,
  theme: BurndownTheme | undefined,
): RenderedForms {
  const color = colorFor(segment);
  const fullSignal = style(
    theme,
    color,
    exhaustedLabel === "symbol" && segment.state === "exhausted"
      ? segmentSignal(segment, symbols)
      : describeSegmentSignal(segment, symbols, density),
  );
  const compactSignal = style(theme, color, segmentSignalWithUnit(segment, symbols));
  const minimalSignal = style(theme, color, segmentSignal(segment, symbols));
  const separator = " ";
  const provider = clipToColumns(
    providerLabelFor(labels, segment.subscriptionId),
    providerLabelMaxColumns,
  );
  const account = labelFor(labels, segment.subscriptionId);
  const hasDistinctAccount =
    labels.accountRequired.has(segment.subscriptionId) &&
    segment.label.trim().length > 0 &&
    segment.label.trim().toLocaleLowerCase() !== segment.provider.trim().toLocaleLowerCase();
  const qualifiedLabel =
    !hasDistinctAccount || accountLabels === "provider-only"
      ? provider
      : accountLabels === "masked"
        ? (() => {
            const { head, tail } = maskAccountLabel(account);
            return `${provider}:${head}${tail}`;
          })()
        : `${provider}:${account}`;
  const fullLabel = style(theme, "muted", qualifiedLabel);
  const compact = `${fullLabel}${separator}${compactSignal}`;
  const minimal = `${fullLabel}${minimalSignal}`;
  const reset = showReset ? resetCountdown(segment.resetsAt, now) : "";
  const remaining = remainingQuota(segment.usedFraction);
  const details =
    segment.state === "exhausted" && exhaustedDisplay === "reset"
      ? [reset].filter(Boolean)
      : [remaining, reset].filter(Boolean);
  const full = details.length
    ? `${fullLabel}${separator}${fullSignal}${details
        .map((detail) => `${separator}·${separator}${style(theme, "dim", detail)}`)
        .join("")}`
    : `${fullLabel}${separator}${fullSignal}`;
  return { full, compact, minimal };
}

function chooseForms(
  forms: readonly RenderedForms[],
  width: number,
  separator: string,
): string[] | undefined {
  const count = forms.length;
  const separatorsWidth = Math.max(0, count - 1) * visibleWidth(separator);
  const budget = width - separatorsWidth;
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
  return chosen;
}

/**
 * Pack segments line by line, keeping each segment's full form and moving
 * whole segments to subsequent lines instead of degrading details to fit.
 * A segment degrades only when its full form cannot fit an empty line.
 */
function wrapForms(forms: readonly RenderedForms[], width: number, separator: string): string[] {
  const separatorWidth = visibleWidth(separator);
  const lines: string[] = [];
  let line: string[] = [];
  let used = 0;
  for (const form of forms) {
    const available = width - used - (line.length > 0 ? separatorWidth : 0);
    if (visibleWidth(form.full) <= available) {
      line.push(form.full);
      used += (line.length > 1 ? separatorWidth : 0) + visibleWidth(form.full);
      continue;
    }
    if (line.length > 0) {
      lines.push(line.join(separator));
      line = [];
      used = 0;
    }
    const first =
      visibleWidth(form.full) <= width
        ? form.full
        : visibleWidth(form.compact) <= width
          ? form.compact
          : form.minimal;
    line.push(first);
    used = visibleWidth(first);
  }
  if (line.length > 0) lines.push(line.join(separator));
  return lines;
}

/** Render zero or more lines, always within the supplied cell budget. */
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
    formsFor(
      segment,
      labels,
      symbols,
      options.density ?? "dense",
      options.accountLabels ?? "full",
      options.exhaustedDisplay ?? "status",
      options.exhaustedLabel ?? "full",
      options.providerLabelMaxColumns ?? 0,
      options.showReset ?? true,
      renderNow,
      options.theme,
    ),
  );
  const renderable = forms.filter((form) => visibleWidth(form.minimal) <= budget);
  if (options.layout === "wrap") {
    const wrapped = wrapForms(renderable, budget, separator);
    return wrapped.length > 0 ? wrapped : EMPTY_ROWS;
  }
  const lines: string[] = [];
  for (let start = 0; start < renderable.length; ) {
    let chosen: string[] | undefined;
    let chosenLine: string | undefined;
    for (let count = renderable.length - start; count >= 1; count--) {
      const candidate = chooseForms(renderable.slice(start, start + count), budget, separator);
      if (!candidate) continue;
      const line = candidate.join(separator);
      if (visibleWidth(line) > budget) continue;
      chosen = candidate;
      chosenLine = line;
      break;
    }
    if (!chosen || chosenLine === undefined) break;
    lines.push(chosenLine);
    start += chosen.length;
  }
  return lines.length > 0 ? lines : EMPTY_ROWS;
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
