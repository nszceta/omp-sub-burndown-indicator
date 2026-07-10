import type { BurndownSegment, SegmentState } from "../domain/types";

export type SymbolMode = "auto" | "unicode" | "ascii";

export interface BurndownSymbols {
  readonly ahead: string;
  readonly behind: string;
  readonly onPace: string;
  readonly exhausted: string;
  readonly unknown: string;
  readonly stale: string;
}

export const UNICODE_SYMBOLS: BurndownSymbols = {
  ahead: "▲",
  behind: "▼",
  onPace: "=",
  exhausted: "!",
  unknown: "?",
  stale: "~",
};

export const ASCII_SYMBOLS: BurndownSymbols = {
  ahead: "+",
  behind: "-",
  onPace: "=",
  exhausted: "!",
  unknown: "?",
  stale: "~",
};

export function symbolsFor(mode: SymbolMode = "auto"): BurndownSymbols {
  return mode === "ascii" ? ASCII_SYMBOLS : UNICODE_SYMBOLS;
}

export function symbolForState(state: SegmentState, symbols: BurndownSymbols): string {
  switch (state) {
    case "ahead":
      return symbols.ahead;
    case "behind":
      return symbols.behind;
    case "on-pace":
      return symbols.onPace;
    case "exhausted":
      return symbols.exhausted;
    default:
      return symbols.unknown;
  }
}

export function segmentSignal(
  segment: Pick<BurndownSegment, "state" | "paceDelta" | "stale">,
  symbols: BurndownSymbols,
): string {
  const stale = segment.stale ? symbols.stale : "";
  if (segment.state === "unknown") return `${stale}${symbols.unknown}`;
  if (segment.state === "exhausted") return `${stale}${symbols.exhausted}`;
  const magnitude = Number.isFinite(segment.paceDelta)
    ? Math.round(Math.abs(segment.paceDelta ?? 0) * 100)
    : 0;
  return `${stale}${symbolForState(segment.state, symbols)}${magnitude}`;
}

/** Add the percentage-point unit to pace deltas while preserving state glyphs. */
export function segmentSignalWithUnit(
  segment: Pick<BurndownSegment, "state" | "paceDelta" | "stale">,
  symbols: BurndownSymbols,
): string {
  const signal = segmentSignal(segment, symbols);
  return segment.state === "ahead" || segment.state === "behind" || segment.state === "on-pace"
    ? `${signal}pp`
    : signal;
}

/** Spell out what a pace delta means for the full-width indicator form. */
export function describeSegmentSignal(
  segment: Pick<BurndownSegment, "state" | "paceDelta" | "stale">,
  symbols: BurndownSymbols,
): string {
  const signal = segmentSignalWithUnit(segment, symbols);
  const meaning =
    segment.state === "ahead"
      ? "ahead"
      : segment.state === "behind"
        ? "behind"
        : segment.state === "on-pace"
          ? "on pace"
          : segment.state === "exhausted"
            ? "exhausted"
            : "unknown";
  return `${signal} ${meaning}${segment.stale ? " (stale)" : ""}`;
}

export const getSymbols = symbolsFor;
